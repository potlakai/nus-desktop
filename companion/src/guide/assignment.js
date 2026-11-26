// Assignment mode: the Knot follows along while the person works through a
// set of problems. Each problem gets a walkthrough (solve.js) shown one step
// at a time by the Knot; moving to a new problem is noticed without asking.
//
// Noticing is three gates, cheapest first, so a model call is only spent on a
// screen that really looks like a different problem:
//   1. gray cells of a tiny frame: a big change that has stopped moving;
//   2. Windows OCR of the full frame (local, free, about a second): enough of
//      the words on screen are new;
//   3. the model itself, told what the previous problem was, answers same/new.
// A scroll inside one problem stops at gate 2. A scroll down a worksheet gets
// to gate 3 once the old problem's words are mostly gone.
//
// Pure JS with injected dependencies so it can be tested without Electron:
//   foreground()        -> { process, title, hwnd } | null (never our own window)
//   frame()             -> { cells } a tiny gray frame of the display
//   capture()           -> { dataUrl, ... } the frame the model and OCR read
//   ocr(cap)            -> text ('' or a throw = could not read)
//   solve({ system, text, cap }) -> raw model reply (throws on failure)
//   cursor()            -> { x, y } fractions of the display, or null
//   idle()              -> false while a guide session or another ask owns the Knot
//   send(channel, payload), record(rec), now(), log(msg)
'use strict';

const { buildSolveRequest, parseSolveReply, cellsChanged, newTextFraction } = require('./solve');
const { runLanes } = require('./solve-lanes');
const { cacheSimilarity, homeworkText, critical, criticalRemoved } = require('./assignment-watch');
const { sameForeground } = require('./assignment-capture');
const { plainAskError } = require('../ask-error');

const SETTLED = 0.01;        // two frames this alike = the screen has stopped moving
const BIG_CHANGE = 0.06;     // share of cells; the Knot's own bubble is under 0.03
const TEXT_NEW = 0.35;       // new words since the last look
const TEXT_GONE = 0.6;       // new words since the last solve (a slow scroll adds up)
const CRITICAL_GONE = 2;     // without Jev: numbers/operators gone since the last look (a submit loses one "0")
const MIN_GAP_MS = 600;      // between looks the person did not ask for (a look is OCR + Jev; the model only follows a "different")
const LOW_CONF = 0.6;
const QUIET_CELLS = 3;               // fewer cells than this moved since the last look: nothing to read
const POKE_LOOKS_MS = [350, 1500];   // after a click, key or window change: a quick look, then one for a page that was still loading

const MODE_OFF = /\b(stop|end|exit|quit|leave|turn off|done with|finished with|finished)\b.{0,16}\b(assignment|homework|study|problem[- ]set)\b|\b(assignment|homework|study) mode off\b/i;
const MODE_ON = /\b(assignment|homework|study|problem[- ]set)\s+mode\b|\b(help|start|begin|working on|doing|do)\b.{0,24}\bmy (assignment|homework|problem set|pset|worksheet)\b/i;
const POINT = /^\s*(where('s| is| are| do i click)|how (do|can) i (open|get to|turn|enable|disable|change|set|switch|insert|save|export|share|submit|upload)|point (at|to|me)|show me where|click|open the)\b/i;
const SOLVE = /\b(solve|answer)\b|\b(this|the|that|next|current) (problem|question|exercise|equation|integral|proof)\b|\bwalk me through (this|it|the (problem|question))\b|\bexplain (this|the) (problem|question|step)\b|\b(question|problem|number)\s*#?\d+\b/i;

// What an ask means to assignment mode: 'on' | 'off' | 'point' | 'solve' | null.
// null = not ours; it carries on to the guide as before.
function classifyAsk(text, modeOn) {
  const t = String(text || '');
  if (MODE_OFF.test(t)) return 'off';
  if (MODE_ON.test(t)) return 'on';
  if (modeOn) return POINT.test(t) ? 'point' : 'solve';
  return SOLVE.test(t) && !POINT.test(t) ? 'solve' : null;
}

// Signed out comes in several wordings; live 2026-09-21 it was "cli_failed:
// Failed to authenticate: OAuth session expired and could not be refreshed".
const SIGNED_OUT = /cli_not_logged_in|not logged in|\/login|failed to authenticate|oauth|session expired/i;

function friendlyError(e) {
  const m = String((e && e.message) || e || 'error');
  if (SIGNED_OUT.test(m)) return 'Claude Code is signed out on this computer. The quick fix: paste a free Gemini key on the dashboard, under Settings, Keys. Or sign Claude Code back in.';
  if (/assignment spend limit/i.test(m)) return 'Today\'s assignment budget on your Anthropic key is used up (about $3). It resets at midnight. Claude Code or a Gemini key has no daily cap: Settings > Keys.';
  if (/cli_spend_limit|\b429\b|quota|usage limit|rate limit/i.test(m)) return 'The AI is out of quota for now. Try again in a little while.';
  if (/no_ai|no AI is set up/i.test(m)) return 'No AI is set up. Sign in to Claude Code, or add a key in Settings > Keys.';
  return plainAskError('', m);
}

class Assignment {
  constructor(deps) {
    this.d = Object.assign({ log: () => {}, now: () => Date.now(), idle: () => true, record: () => {}, cursor: () => null }, deps);
    this.on = false;
    this.style = 'walkthrough';
    this.voiceEnabled = true;
    this.app = null;          // the app the assignment lives in
    this.view = null;         // { problem, steps, answer, check, confidence, index, voice }
    this.up = false;          // one of our bubbles is on screen
    this.gen = 0;             // bumps on every ask and on stop; stale replies check it
    this.solving = 0;
    this.ticking = false;
    this.baseline = null;     // cells at the last look
    this.last = null;         // cells one tick ago
    this.lookText = '';       // words at the last look
    this.solveText = '';      // words at the last solve
    this.lastLookAt = 0;
    this.looking = false;
    this.inFlightText = '';
    this.stillText = '';      // words of the last look on a moving screen
    this.cache = [];
    this.solveController = null;
  }

  isOn() { return this.on; }
  showing() { return this.up; }
  status() { return { on: this.on, style: this.style, app: this.app ? this.app.process : '', showing: this.showing(), solving: this.solving > 0, problem: this.view ? this.view.problem : '' }; }

  setStyle(style, source) {
    this.style = style === 'answers' ? 'answers' : 'walkthrough';
    if (this.view) {
      this.view.voice = source === 'voice';
      this.show();
    } else this.hint(this.style === 'answers' ? 'Answers only.' : 'Walkthrough mode on.');
  }

  setVoice(enabled) {
    this.voiceEnabled = !!enabled;
    this.lastSpoken = '';
    this.d.send('assignment:voice', { enabled: this.voiceEnabled });
    this.hint(this.voiceEnabled ? 'Voice mode on.' : 'Voice mode off. Answers stay on screen.');
    if (this.voiceEnabled && this.view) { this.view.voice = true; this.show(); }
  }

  // ---- mode ---------------------------------------------------------------
  // opts.solve === false: start following without reading what is in front now.
  async start(source, opts) {
    if (this.on) { if (this.view) this.show(); else this.hint('Assignment mode is already on.'); return; }
    this.on = true;
    // A previous one-off ask must not make the first automatic gate say "same".
    // Checked OCR-cache entries remain available and restore through their guard.
    this.view = null;
    this.lookFrame = null;
    this.needsStableLook = false;
    this.fallbackText = '';
    this.nextSolveVoice = source === 'voice';
    if (this.d.warm) this.d.warm();
    this.baseline = this.last = null;
    this.lookText = this.solveText = '';
    let fg = null;
    try { fg = await this.d.foreground(); } catch (_) { fg = null; }
    this.app = fg && fg.process ? { process: fg.process, title: fg.title || '' } : null;
    this.d.log('on' + (this.app ? ' in ' + this.app.process : ' (no app yet)'));
    // Said out loud and shown as a bubble: the moment a recording can zoom on.
    this.up = true;
    this.d.send('guide:state', { state: 'explaining', task: 'solve' });
    this.d.send('guide:bubble', { task: 'solve', anchor: 'knot', kicker: 'assignment mode', text: 'Assignment mode on.', hint: 'I will walk you through each problem, and notice when you move to the next one.', actions: [], speak: 'Assignment mode on.' });
    if (opts && opts.solve === false) return;
    if (this.d.solveLane) { this.poke('mode'); await this.look({ settled: true, first: true, voice: source === 'voice' }); return; }
    await this.solveNow({ auto: true, first: true, voice: source === 'voice' });
  }

  // Another bubble (a pointing step) replaced ours.
  covered() { this.up = false; }

  stop() {
    if (!this.on && !this.view) return;
    this.on = false;
    this.gen++;
    if (this.solveController) this.solveController.abort();
    this.app = null;
    (this.pokeTimers || []).forEach((t) => (this.d.cancel || clearTimeout)(t));
    this.pokeTimers = [];
    const wasShowing = this.showing();
    this.view = null;
    this.up = false;
    this.baseline = this.last = null;
    this.d.log('off');
    if (wasShowing) this.d.send('guide:done', { sessionId: null, offerKeep: false });
    else this.d.send('guide:state', { state: null });
    this.d.send('guide:hint', { text: 'Assignment mode off.', ms: 3000, speak: 'Assignment mode off.' });
  }

  // The person asked something: about the problem on screen, or about the
  // walkthrough already up. It always gets a model call and always wins over a
  // look the watcher started on its own.
  ask(question, source) { return this.solveNow({ question: String(question || '').trim(), auto: false, voice: source === 'voice' }); }

  // ---- events, not polling ---------------------------------------------------
  // Grabbing the screen two or three times a second made the whole machine
  // stutter under a recording (Pranav 2026-09-21: "too laggy"). A new problem
  // does not appear by itself: it follows a click, a key, or a window or title
  // change, and those cost nothing to hear about. poke() is what they call.
  // One look shortly after, one more once a page has had time to load. tick()
  // stays as a slow safety net (index.js runs it every few seconds) for what
  // no event announces, like a scroll wheel.
  poke(reason) {
    if (!this.on) return;
    if (this.d.warm) this.d.warm();
    this.eventAt = this.d.now();
    const later = this.d.later || ((ms, fn) => { const t = setTimeout(fn, ms); if (t.unref) t.unref(); return t; });
    const cancel = this.d.cancel || clearTimeout;
    (this.pokeTimers || []).forEach((t) => cancel(t));
    this.pokeTimers = POKE_LOOKS_MS.map((ms) => later(ms, () => { this.lookSoon(reason).catch((e) => this.d.log('look failed: ' + e.message)); }));
  }

  async lookSoon(reason) {
    if (!this.on || this.looking || this.scheduledLooking || !this.d.idle()) return;
    this.scheduledLooking = true;
    const finishPerformance = this.d.observeLook?.(reason);
    try {
    // Most clicks change nothing (a Next in our own bubble, a text field). One
    // tiny thumbnail answers that before the full-size capture is spent. The
    // bar is a few cells, not a share of the screen: two quiz pages can differ
    // by one line of formula.
    let f = null;
    try { f = await this.d.frame(); } catch (_) { f = null; }
    if (!this.on) return;
    if (f && f.cells) {
      if (!this.needsStableLook && this.lookFrame && cellsChanged(this.lookFrame, f.cells) * f.cells.length < QUIET_CELLS) return;
      this.lookFrame = f.cells;
    }
    this.d.log('looking (' + reason + ')');
    await this.look({ settled: true, changeSeenAt: this.d.now(), eventAt: this.eventAt });
    this.baseline = this.last = null;   // the safety net starts again from this screen
    } finally { this.scheduledLooking = false; finishPerformance?.(); }
  }

  // The window in front, once a second. No capture. A new app or a new title
  // (another tab, the next page of a quiz) is a poke.
  async pulse() {
    if (!this.on || !this.d.idle()) return;
    let fg = null;
    try { fg = await this.d.foreground(); } catch (_) { fg = null; }
    if (!fg || !fg.process || !this.on) return;
    const switched = !this.app || this.app.process !== fg.process || (this.app.title || '') !== (fg.title || '');
    if (!switched) return;
    this.app = { process: fg.process, title: fg.title || '' };
    this.d.log('following ' + fg.process + (fg.title ? ' "' + String(fg.title).slice(0, 50) + '"' : ''));
    this.poke('window');
  }

  // ---- the watcher ----------------------------------------------------------
  // Speed (Pranav 2026-09-21, "it needs to be instant like Jev"): a big change
  // is looked at the moment it appears, not once the screen has settled, and a
  // look keeps running while the model is still busy on the last problem. A
  // look is cheap (OCR in the probe about 60 ms, Jev about 200 ms); only the
  // model call waits, and only when Jev is unsure and the screen still moves.
  async tick() {
    if (!this.on || this.ticking) return;
    if (!this.d.idle()) return;
    this.ticking = true;
    try {
      let fg = null;
      try { fg = await this.d.foreground(); } catch (_) { fg = null; }
      if (!fg || !fg.process) return;
      // The watcher goes where the person goes. Binding it to one app failed
      // twice on 2026-09-21 (whatever was in front at launch; then the taskbar,
      // "explorer", at the moment of the first solve, after which Firefox was
      // ignored for good). Switching apps counts as a change worth a look; the
      // OCR gate keeps a switch back to the same page from costing a call.
      const f = await this.d.frame();
      if (!f || !f.cells || !this.on) return;
      // A new window title (another tab, the next page of a quiz) is a switch too.
      const switched = !this.app || this.app.process !== fg.process || (this.app.title || '') !== (fg.title || '');
      if (switched) { this.app = { process: fg.process, title: fg.title || '' }; this.d.log('following ' + fg.process + (fg.title ? ' "' + String(fg.title).slice(0, 50) + '"' : '')); }
      const prev = this.last;
      this.last = f.cells;
      if (!this.baseline) { this.baseline = f.cells; return; }
      const settled = Boolean(prev) && cellsChanged(prev, f.cells) <= SETTLED;
      const big = cellsChanged(this.baseline, f.cells) >= BIG_CHANGE;
      if (!switched && !big) return;                                          // nothing much happened
      if (this.looking) return;                                               // one look at a time
      if (this.d.now() - this.lastLookAt < MIN_GAP_MS) { if (switched) this.app = null; return; }   // asked again next tick
      // The baseline moves only once the screen holds still, so an early look
      // at a half-drawn page is followed by a settled one.
      if (settled || switched) this.baseline = f.cells;
      this.d.log('screen changed' + (switched ? ' (new app)' : settled ? '' : ' (still moving)') + ', reading it');
      await this.look({ settled: settled || switched });
    } catch (e) {
      this.d.log('tick failed: ' + e.message);
    } finally {
      this.ticking = false;
    }
  }

  // The screen changed and settled. Read its words; call the model only when
  // enough of them are new.
  async look(o) {
    const finishPerformance = !this.scheduledLooking && this.d.observeLook?.('direct');
    const settled = !o || o.settled !== false;
    this.looking = true;
    this.lastLookAt = this.d.now();
    try { await this.lookInner(settled, o || {}); } finally { this.looking = false; if (finishPerformance) finishPerformance(); }
  }

  async lookInner(settled, context = {}) {
    const lookStarted = this.d.now(), lookGen = this.gen;
    const cap = await this.d.capture({ model: false });
    const capMs = this.d.now() - lookStarted, ocrStarted = this.d.now();
    if (!cap || !this.on) return;
    if (cap.invalidated) { this.retryCapture('window changed during OCR capture'); return; }
    let text = null;
    try { text = await this.d.ocr(cap); } catch (e) { this.d.log('ocr failed: ' + e.message); text = null; }
    if (!this.on || lookGen !== this.gen) return;
    const ocrMs = this.d.now() - ocrStarted;
    const strict = !!this.d.solveLane;
    if (strict && !String(text || '').trim()) { this.d.log('empty OCR: no automatic call'); return; }
    if (strict) {
      const cached = this.cache.find(c => cacheSimilarity(c.text, text) >= 0.9);
      if (cached && (!this.view || cacheSimilarity(this.solveText, text) < 0.9)) {
        if (this.solveController) this.solveController.abort();
        this.gen++;
        this.view = JSON.parse(JSON.stringify(cached.view)); this.view.voice = false;
        this.lookText = this.solveText = text; this.show();
        const rec = { at: this.d.now(), changeSeenAt: context.changeSeenAt || lookStarted, lookMs: this.d.now() - lookStarted, capMs, ocrMs, jevMs: null, fastFirstTokenMs: null, fastAnswerMs: null, checkerFirstStepMs: null, checkerMs: null, agreed: null, fastModel: null, checkerModel: null, cacheHit: true, reason: 'seen before', reply: this.view };
        if (this.d.paint) await this.d.paint({ kind: 'seen before', changeSeenAt: rec.changeSeenAt, gen: this.gen });
        this.d.record(rec); this.d.log('timing ' + JSON.stringify(rec)); return;
      }
    }
    // Pixels are not the only way to hold still: the same words two looks in a
    // row is a settled screen too (an animation somewhere on it never lets the
    // frames agree, and a page can be read the moment its text stops changing).
    if (!settled && text && text.trim()) {
      if (this.stillText && newTextFraction(this.stillText, text) < 0.05 && newTextFraction(text, this.stillText) < 0.05) { settled = true; this.d.log('same words twice: holding still'); }
      this.stillText = text;
    }
    if (!this.needsStableLook && text != null && text.trim() && (this.solveText || this.lookText)) {
      const sinceLook = newTextFraction(this.lookText || this.solveText, text);
      // Nothing solved yet (no problem was on screen): only the last look counts.
      const sinceSolve = this.solveText ? newTextFraction(this.solveText, text) : 0;
      // With Jev, any changed number goes to it to judge. Without Jev nothing tells a
      // typed answer from a new problem, so only numbers that went away count
      // (2026-09-28: every answer typed on WeBWorK re-solved the same problem).
      const prev = this.lookText || this.solveText;
      const criticalChanged = strict && (this.d.judge ? critical(prev) !== critical(text) : criticalRemoved(prev, text) >= CRITICAL_GONE);
      this.lookText = text;
      if (!criticalChanged && sinceLook < TEXT_NEW && sinceSolve < TEXT_GONE) { this.d.log('same words (' + sinceLook.toFixed(2) + ' new, ' + sinceSolve.toFixed(2) + ' since the solve): no call'); return; }
      this.d.log('new words (' + sinceLook.toFixed(2) + ' new, ' + sinceSolve.toFixed(2) + ' since the solve)');
    } else {
      this.d.log('no words to compare');
    }
    // Jev reads the words before the model is spent on them (problemgate.js).
    // A confident "same problem" or "nothing to solve" ends it here; anything
    // else, or no opinion, goes to the model as before.
    let j = null;
    if (text && this.d.judge) {
      try { j = await this.d.judge({ previousProblem: this.view ? this.view.problem : '', previousAnswer: this.view ? this.view.answer : '', text }); } catch (e) { this.d.log('gate failed: ' + e.message); }
      if (!this.on || lookGen !== this.gen) return;
      if (j) {
        this.d.log('jev ' + j.ms + 'ms: ' + j.choice + ' ' + j.confidence.toFixed(2) + (j.hasProblem != null ? ' has_problem=' + j.hasProblem.toFixed(2) : '') + ' -> ' + j.verdict);
        if (j.verdict === 'same' || j.verdict === 'none' || strict && (j.choice === 'same' || j.choice === 'none')) { this.lookText = text; return; }
        if (strict && !(j.homeworkPage >= 0.6)) { this.lookText = text; this.d.log('homework page not confirmed: no model call'); return; }
        // Jev is sure it is a different problem: that alone is enough, even
        // mid-scroll. Unsure on a moving screen: the settled look decides.
        if (j.verdict !== 'different' && !settled) { this.d.log('unsure while the screen moves: waiting for it to hold still'); return; }
      } else if (!settled) { this.d.log('no opinion while the screen moves: waiting for it to hold still'); return; }
    } else if (!settled) { return; }
    if (strict && !j) {
      if (!homeworkText(text)) { this.needsStableLook = false; this.d.log('local homework check failed'); return; }
      if (!this.fallbackText || cacheSimilarity(this.fallbackText, text) < 0.9) {
        this.fallbackText = text; this.needsStableLook = true;
        this.d.log('Jev unavailable: waiting for stable OCR'); this.poke('local fallback'); return;
      }
    }
    this.needsStableLook = false; this.fallbackText = '';
    if (!settled) this.stillText = '';
    if (this.solving > 0 && this.sameAsInFlight(text)) { this.d.log('already working on this one'); return; }
    this.d.log('asking the model');
    // The model takes 15 to 30 s. Live 2026-09-21 that silence read as "it did
    // nothing": say so, out loud, and go amber while it works.
    this.d.send('guide:hint', { text: this.view ? 'New problem. Working through it.' : 'Reading this problem.', ms: 6000, speak: !strict && this.view ? 'New problem.' : undefined });
    const options = { ...context, voice: context.voice || !!this.nextSolveVoice, auto: true, cap, text, capMs, ocrMs, jevMs: j?.ms ?? null, lookMs: this.d.now() - lookStarted, changeSeenAt: context.changeSeenAt || lookStarted, blockMs: cap.blockMs ?? null };
    this.nextSolveVoice = false;
    if (strict) {
      const solve = this.solveNow(options);
      if (this.d.paint) this.d.paint({ kind: 'new problem', changeSeenAt: options.changeSeenAt, gen: this.gen, jevMs: options.jevMs }).then(ms => this.d.log('detection ' + JSON.stringify({ changeSeenAt: options.changeSeenAt, eventAt: context.eventAt ?? null, chipMs: ms, eventToChipMs: ms != null && context.eventAt ? ms + options.changeSeenAt - context.eventAt : null, lookMs: options.lookMs, capMs, ocrMs, jevMs: options.jevMs, blockMs: options.blockMs })));
      solve.catch(e => this.d.log('solve failed: ' + e.message));
    } else await this.solveNow(options);
  }

  // ---- one solve ------------------------------------------------------------
  retryCapture(reason) {
    // A discarded capture is not a solved/seen problem. Bypass both the
    // unchanged-thumbnail and unchanged-OCR gates on the next scheduled look.
    this.lookFrame = null;
    this.needsStableLook = true;
    this.d.log('capture retry: ' + reason);
    this.hint('The page changed while loading. Reading it again.');
    this.poke('capture retry');
  }

  // A look, in flight, for words like these (a second early look at the same
  // new problem must not start a second model call).
  sameAsInFlight(text) {
    return Boolean(this.inFlightText) && critical(this.inFlightText) === critical(text) && newTextFraction(this.inFlightText, text) < TEXT_NEW;
  }

  async solveNow(o) {
    if (this.d.solveLane) return this.solveStreaming(o);
    // Every solve supersedes the one before it: a new problem noticed while
    // the model is still on the last one wins, and so does any question asked.
    const gen = ++this.gen;
    const started = this.d.now();
    this.solving += 1;
    if (o.text) this.inFlightText = o.text;
    this.d.send('guide:state', { state: 'reading', task: 'solve' });
    let provider = '';
    try {
      const cap = o.cap || await this.d.capture();
      if (!cap || !cap.dataUrl) { if (!o.auto) this.say('I could not read the screen. Allow screen capture for Nūs and try again.'); return; }
      let fg = null;
      try { fg = await this.d.foreground(); } catch (_) { fg = null; }
      const previous = this.view ? { problem: this.view.problem, steps: this.view.steps, answer: this.view.answer } : null;
      const req = buildSolveRequest({ question: o.question, previous, cursor: this.d.cursor(), window: fg ? { title: fg.title, process: fg.process } : null, auto: !!o.auto });
      // The words on this frame, for the next comparison. Read while the model works.
      const textP = o.text != null ? Promise.resolve(o.text) : Promise.resolve().then(() => this.d.ocr(cap)).catch(() => null);
      let raw;
      try {
        const r = await this.d.solve({ system: req.system, text: req.text, cap });
        raw = r && typeof r === 'object' ? r.text : r;
        provider = (r && r.provider) || '';
      } catch (e) {
        this.d.log('model failed: ' + e.message);
        if (gen !== this.gen) return;
        // A look nobody asked for fails quietly, except the one failure only the person can fix.
        if (!o.auto || o.first || SIGNED_OUT.test(String(e.message)) || /no_ai/i.test(String(e.message))) this.say(friendlyError(e));
        return;
      }
      const text = await textP;
      const ms = this.d.now() - started;
      if (gen !== this.gen) { this.d.log('reply dropped: a newer ask took over'); return; }
      const v = parseSolveReply(raw);
      this.d.log('model ' + ms + 'ms: ' + v.reason + (v.reply && v.reply.problem ? ' "' + v.reply.problem.slice(0, 60) + '"' : ''));
      if (text) { this.lookText = text; if (v.ok) this.solveText = text; }
      this.baseline = this.last = null;   // our own bubble may be in the next frame
      try { this.d.record({ at: this.d.now(), auto: !!o.auto, question: o.question || '', app: fg ? fg.process : '', ms, provider, reason: v.reason, reply: v.reply || null, raw: v.ok ? undefined : String(raw || '').slice(0, 2000) }); } catch (_) { /* a log never breaks a solve */ }

      if (!v.ok) { if (!o.auto) this.say('I could not work this one out from the screen. Scroll so the whole problem shows, then ask again.'); else this.restore(); return; }
      const reply = v.reply;
      if (!reply.found) {
        if (o.first) this.say('I do not see a problem on screen yet. Open your assignment and I will pick it up.', true);
        else if (!o.auto) this.say('I do not see a problem on screen. Open it, then ask again.');
        else this.restore();
        return;
      }
      if (o.auto && reply.same && this.view) { this.restore(); return; }
      if (!reply.steps.length) { if (!o.auto) this.say('I could not work this one out from the screen.'); else this.restore(); return; }
      if (o.auto && !o.first) this.hint('New problem. Here is the walkthrough.', 3000);
      // Its first step is read out when it was noticed, not asked for.
      const speakFirst = o.auto && !o.first;
      // The app a problem was found in is the assignment from here on.
      if (fg && fg.process) this.app = { process: fg.process, title: fg.title || '' };
      this.view = { problem: reply.problem, steps: reply.steps, answer: reply.answer, check: reply.check, confidence: reply.confidence, index: 0, voice: !!o.voice };
      this.show(speakFirst ? 'Here is the walkthrough. Step 1: ' + (reply.steps[0].title || reply.steps[0].body) : undefined);
    } catch (e) {
      this.d.log('solve failed: ' + e.message);
      if (!o.auto && gen === this.gen) this.say(friendlyError(e));
    } finally {
      this.solving -= 1;
      if (gen === this.gen) this.inFlightText = '';
    }
  }

  async solveStreaming(o) {
    if (this.solveController) this.solveController.abort();
    const ctl = new AbortController();
    this.solveController = ctl;
    this.lastSpoken = '';
    const gen = ++this.gen, started = this.d.now();
    this.solving++;
    this.inFlightText = o.text || '';
    const current = () => gen === this.gen && !ctl.signal.aborted;
    const rec = { at: started, changeSeenAt: o.changeSeenAt || started, auto: !!o.auto, question: o.question || '', lookMs: o.lookMs ?? null, capMs: o.capMs || 0, ocrMs: o.ocrMs ?? null, jevMs: o.jevMs ?? null, blockMs: o.blockMs ?? null, fastFirstTokenMs: null, fastAnswerMs: null, checkerFirstStepMs: null, checkerMs: null, agreed: null, cacheHit: false, fastModel: this.d.fastModel, checkerModel: this.d.checkerModel || 'claude-sonnet-5' };
    this.d.send('guide:state', { state: 'reading', task: 'solve' });
    let firstStep = false, result;
    try {
      const capStart = this.d.now();
      const cap = o.modelCap || await this.d.capture({ model: true });
      rec.capMs += this.d.now() - capStart;
      if (!current()) { rec.reason = 'cancelled'; return; }
      if (!cap?.dataUrl || cap.invalidated) {
        rec.reason = cap?.invalidated ? 'capture changed' : 'capture unavailable';
        this.retryCapture(rec.reason); return;
      }
      if (o.cap?.foreground && cap.foreground && !sameForeground(o.cap.foreground, cap.foreground)) {
        rec.reason = 'window changed during gate'; this.retryCapture(rec.reason); return;
      }
      const fg = await this.d.foreground();
      if (!current()) return;
      if (cap.foreground && !sameForeground(cap.foreground, fg)) {
        rec.reason = 'window changed after capture'; this.retryCapture(rec.reason); return;
      }
      rec.app = fg?.process || '';
      const previous = this.view;
      this.view = { problem: '', answer: '', steps: [], index: 0, confidence: 0, checkState: 'checking', voice: !!o.voice };
      const update = (p) => { this.view = { ...this.view, ...p }; this.show(); };
      result = await runLanes({
        call: this.d.solveLane, cap, signal: ctl.signal, fastModel: rec.fastModel, checkerModel: rec.checkerModel, hedgeAfterMs: this.d.hedgeAfterMs, now: this.d.now, compare: this.d.compareAnswers,
        input: { question: o.question, previous, auto: !!o.auto, window: fg, cursor: cap.cursor || this.d.cursor() },
        onFirstToken: ms => { rec.fastFirstTokenMs = ms; },
        onFast: (p) => {
          if (!current()) return;
          rec.fastReply = p;
          update({ problem: p.problem || '', answer: p.answer, checkState: 'checking' });
          this.markPaint('answer', rec, gen);
        },
        onSteps: (p) => {
          if (!current()) return;
          const first = !firstStep; firstStep = true;
          update({ problem: p.problem || this.view.problem, steps: p.steps });
          if (first) this.markPaint('step', rec, gen);
        },
        onChecked: (p, agreed, fast) => {
          if (!current()) return;
          if (!p.found || p.same && !p.steps.length) {
            if (p.same && previous) { this.view = previous; this.show(); }
            else { this.view = null; this.say('I do not see a readable problem.'); }
            return;
          }
          update({ ...p, answer: fast && agreed === true ? fast.answer : p.answer, index: Math.min(this.view.index, p.steps.length - 1), checkState: fast && agreed === false ? 'corrected' : 'checked' });
          this.markPaint(fast && agreed === false ? 'corrected' : 'checked', rec, gen);
          if (!firstStep) { firstStep = true; this.markPaint('step', rec, gen); }
        },
      });
      if (!current()) return;
      rec.fastFirstTokenMs = result.timing.fastFirstTokenMs;
      rec.agreed = result.timing.agreed;
      rec.checkerCompleteMs = result.timing.checkerMs;
      rec.fastError = result.timing.fastError; rec.checkerError = result.timing.checkerError;
      rec.fastReply = result.fast; rec.reply = result.checked;
      rec.disagreement = !!(result.fast?.answer && result.checked?.answer && result.timing.agreed === false);
      rec.reason = result.checked?.found ? 'solved' : result.timing.checkerError ? 'checker failed' : 'nothing to solve';
      if (result.timing.checkerError) {
        if (this.view?.answer) update({ checkState: 'not checked' });
        else this.say(friendlyError(new Error(result.timing.checkerError)));
      }
      if (o.text) {
        this.lookText = o.text;
        if (result.checked?.found && result.checked.steps.length) {
          this.solveText = o.text;
          this.cache.push({ text: o.text, view: JSON.parse(JSON.stringify(this.view)) });
          if (this.cache.length > 30) this.cache.shift();
        }
      }
      if (fg?.process) this.app = { process: fg.process, title: fg.title || '' };
      this.baseline = this.last = null;
    } catch (e) {
      rec.reason = e.name === 'AbortError' ? 'cancelled' : 'failed'; rec.error = e.message;
      if (current() && e.name !== 'AbortError') this.say(friendlyError(e));
    } finally {
      this.solving--;
      rec.ms = this.d.now() - started;
      if (current()) this.inFlightText = '';
      // Paint acknowledgments may still be crossing IPC after the final token.
      if (rec.paintPromises) await Promise.all(rec.paintPromises);
      delete rec.paintPromises;
      try { this.d.record(rec); this.d.log('timing ' + JSON.stringify(rec)); } catch (_) { /* logging cannot break the mode */ }
    }
  }

  markPaint(kind, rec, gen) {
    if (!this.d.paint) return;
    if (!rec.paintPromises) rec.paintPromises = [];
    rec.paintPromises.push(Promise.resolve(this.d.paint({ kind, changeSeenAt: rec.changeSeenAt, gen, expected: kind === 'step' ? this.view?.steps[0]?.body : this.view?.answer })).then(ms => {
      if (ms == null) return;
      if (kind === 'answer') rec.fastAnswerMs = ms;
      if (kind === 'step') rec.checkerFirstStepMs = ms;
      if (kind === 'checked' || kind === 'corrected') rec.checkerMs = ms;
    }).catch(() => {}));
  }

  // ---- drawing --------------------------------------------------------------
  // speak: one line read out with this step (a noticed problem announces itself).
  show(speak) {
    const v = this.view;
    if (!v) return;
    if (this.style === 'answers') {
      this.up = true;
      this.d.send('guide:state', { state: 'explaining', task: 'solve' });
      this.sendBubble({ task: 'solve', style: 'answers', anchor: 'assignment', kicker: v.problem, text: v.answer || 'Reading the answer...', hint: v.checkState || 'checked', actions: [{ id: 'solve-done', label: 'Done' }], speak: v.voice && v.answer ? v.answer : undefined });
      return;
    }
    if (!v.steps.length) {
      if (v.answer) this.sendBubble({ task: 'solve', style: 'answers', anchor: 'assignment', kicker: v.problem, text: v.answer, hint: 'checking · walkthrough follows', actions: [] });
      return;
    }
    this.up = true;
    const n = v.steps.length, i = Math.max(0, Math.min(n - 1, v.index)), st = v.steps[i], last = i === n - 1;
    const unsure = v.confidence > 0 && v.confidence < LOW_CONF;
    const text = st.body + ((last || v.checkState) && v.answer ? '\n\nAnswer: ' + v.answer : '');
    const hint = last
      ? (unsure ? 'I am not fully sure of this one. ' : '') + (v.check ? 'Checked: ' + v.check : '')
      : (i === 0 ? v.problem : '');
    const actions = [];
    if (i > 0) actions.push({ id: 'solve-back', label: 'Back' });
    if (!last) actions.push({ id: 'solve-next', label: 'Next', primary: true });
    else if (v.checkState !== 'checking') actions.push({ id: 'solve-done', label: 'Done', primary: true });
    this.d.send('guide:state', { state: 'explaining', task: 'solve' });
    this.sendBubble({ task: 'solve', style: 'walkthrough', anchor: 'assignment', kicker: 'step ' + (i + 1) + ' of ' + n + (st.title ? ' · ' + st.title : ''), text, hint: v.checkState ? v.checkState + (hint ? ' · ' + hint : '') : hint, actions, speak: speak || (v.voice ? st.body : undefined) });
  }

  sendBubble(payload) {
    this.up = true;
    payload.solveGen = this.gen;
    if (!this.voiceEnabled) payload.speak = undefined;
    if (payload.speak && payload.speak === this.lastSpoken) payload.speak = undefined;
    if (payload.speak) this.lastSpoken = payload.speak;
    this.d.send('guide:bubble', payload);
  }

  // A look that changed nothing: put things back the way they were.
  restore() {
    this.d.send('guide:state', { state: this.showing() ? 'explaining' : null, task: 'solve' });
  }

  action(id) {
    const v = this.view;
    if (id === 'solve-done') return this.hide();
    if (!v || !this.up) return false;
    if (id === 'solve-next') { v.index = Math.min(v.steps.length - 1, v.index + 1); this.show(); return true; }
    if (id === 'solve-back') { v.index = Math.max(0, v.index - 1); this.show(); return true; }
    return false;
  }

  // "next" / "back" by voice while a walkthrough is up.
  step(delta) {
    if (!this.showing() || !this.view || !this.view.steps.length) return false;
    if (delta > 0 && this.view.checkState === 'checking' && this.view.index >= this.view.steps.length - 1) { this.hint('The next step is still being checked.'); return true; }
    return this.action(delta > 0 ? (this.view.index >= this.view.steps.length - 1 ? 'solve-done' : 'solve-next') : 'solve-back');
  }

  // Closed, not forgotten: a follow-up question still knows the problem.
  hide() {
    if (!this.up) return false;
    this.up = false;
    this.baseline = this.last = null;
    this.d.send('guide:done', { sessionId: null, offerKeep: false });
    return true;
  }

  say(text, quiet) {
    void quiet;
    this.up = true;
    this.d.send('guide:state', { state: 'explaining', task: 'solve' });
    this.d.send('guide:bubble', { task: 'solve', anchor: 'knot', text, actions: [{ id: 'solve-done', label: 'OK' }] });
  }

  hint(text, ms) { this.d.send('guide:hint', { text, ms: ms || 3500 }); }
}

module.exports = { Assignment, classifyAsk, friendlyError, SETTLED, BIG_CHANGE, TEXT_NEW, TEXT_GONE, MIN_GAP_MS, POKE_LOOKS_MS };
