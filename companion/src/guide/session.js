// The guide session: one ask, one thread at a time. Main owns this state
// machine; the renderer only draws what it is told.
//
//   idle -> reading (AMBER, the only state that captures) -> unwinding ->
//   pointing -> [click on the target, or Next] -> reading -> ... -> done
//   any active state + dismiss -> winding -> idle
//
// Speed (2026-09-21). The model's answer is unchanged; what changed is how
// long the person waits for the thread:
//   - the screenshot and the control walk run side by side, not in a row;
//   - a snapshot taken while the person was still talking is picked up here;
//   - Jev may pick the control from the Windows list in ~0.2 s and the thread
//     goes out at once ("quick"), while the model reads the same screenshot.
//     The model always runs and always wins: same control = the bubble takes
//     its wording in place; another control = the thread moves; no control =
//     the thread comes back.
//
// Pure JS with injected dependencies so it can be tested without Electron:
//   capture()                  -> { dataUrl, width, height, pxWidth, pxHeight, display }
//   probe                      -> the Windows probe (or null), request/watch/unwatch/available
//   llm()                      -> createLLM(settings): { ready, complete({system, turns, imageDataUrl, json}) }
//   send(channel, payload)     -> to the overlay renderer
//   screenToDip / dipToScreen  -> Electron screen conversions
//   winBounds()                -> overlay window bounds (DIPs)
//   hashCapture(cap, physRect) -> { whole, crop } bitmap hashes
//   walkthroughs               -> createWalkthroughs(): find/record/miss (or null)
//   snapshot                   -> createSnapshotter(): take() (or null)
//   fastPoint                  -> createFastPointer(): mode(), pick() (or null)
//   planMode()                 -> 'inline' asks the model for its expected next steps
//   onTiming(rec), onFast(rec) -> one record per step, for the bench and the shadow log
//   selfPid, log, sleep, now, onKeep(record)
'use strict';

const { buildPointRequest, parsePointReply, validatePoint, CONF_SURE } = require('./pointing');
const { guessClick } = require('./click-guess');
// When the screen cannot be read. A Mac names its own place for the permission (a tester's Mac, 2026-11-15:
// the Windows line showed there); Windows keeps its line exactly.
const CAPTURE_FAILED_LINE = process.platform === 'darwin'
  ? 'I could not read the screen. Allow Nus Companion in System Settings, Privacy & Security, Screen & System Audio Recording, then quit me and open me again.'
  : 'I could not read the screen. On Windows, allow screen capture for Nūs and try again.';
// A capture can fail with something that is not an Error ("capture failed: undefined" on that Mac).
function whyFailed(e) { if (e == null) return 'no reason given'; if (e instanceof Error) return e.message || e.name; try { return typeof e === 'string' ? e : JSON.stringify(e); } catch (_) { return String(e); } }
const { normRectFromPhys, physRectFromNorm, physRectToWindow, reconcile, screenChanged, clickHits, iou, tokenOverlap } = require('./verify');
const { templateInstruction } = require('./fastpoint');
const { SETTLE_AFTER_CLICK_MS } = require('./settle');
const { ReplyStream } = require('./reply-stream');
const { chooseElement } = require('./chooser');
const { sensitiveTarget, REFUSAL } = require('./sensitive');
const { regionFor } = require('./region');
const { plainAskError } = require('../ask-error');
const { buildScreenAnswer, answerMs } = require('./screen-answer');
const { answerish, handsAskBack, noClickLine } = require('./screen-ask');
const { resolveMark, sameMark, MAX_MARKS } = require('./marks');
const { difference } = require('./settle');

const MAX_STEPS = 12;
const MODEL_TIMEOUT_MS = 75000;   // Claude Code cold start + an image read can take a while
const SETTLE_MS = 450;          // fixed nap after a click, only when no screen watcher is wired
const EXPLAIN_MS = 10000;       // an explanation bubble goes away on its own
const FAST_PREV_MS = 600;       // after the thread moves off a quick pick, a click on the old spot still counts
const VK_ESCAPE = 27;
// Drawing on the screen (src/guide/marks.js).
const DRAW_LIST_BUDGET_MS = 900;  // the control walk for an answer that may draw
const DRAW_LIST_WAIT_MS = 350;    // how long the ask waits for that walk after the capture is in
const MARKS_LINGER_MS = 4000;     // an answer with marks stays up this much longer
const MARKS_SETTLE_MS = 1500;     // the bubble and the strokes land before the screen is watched
const MARKS_WATCH_MS = 700;       // how often the screen is looked at while marks are up
const FOUND_MS = 12000;           // a thing found on the screen stays ringed this long
const FOUND_FRAME_SHARE = 0.3;    // wider than this share of the screen, it gets a frame, not a ring
const PAGE_WAIT_MS = 1500;        // how long a drawing answer waits for the window's own words
const PEN_WAIT_LINE = 'Checking it line by line.';
const PEN_PUBLIK_MODEL = 'publik-smart';   // a check of someone's work, on publik: the careful tier
const MARKS_LIGHT = 0.55;        // brightness (0..1) under a mark from which the page counts as light
const MARKS_MOVED = 8;           // mean gray change (0..255) that means the screen moved (a scroll is 10 to 40)
// A step may be kept for replay only when the model stood behind it.
const TRUSTED = new Set(['model', 'agree', 'replay']);

// The control list as Jev gets it: straight from the probe, with each control's
// place worked out inside its own window (known before any screenshot exists).
function jevElements(list, fg) {
  const w = fg && fg.rect && fg.rect.w > 0 && fg.rect.h > 0 ? fg.rect : null;
  return (list || []).filter((e) => e && e.rect).map((e) => ({
    id: e.id, name: e.name, type: e.type, automationId: e.automationId, rect: e.rect,
    box: w ? [(e.rect.x - w.x) / w.w, (e.rect.y - w.y) / w.h, e.rect.w / w.w, e.rect.h / w.h] : null,
  }));
}

// [DONE] ends the walk only when there is nothing left to click. The model
// also writes [DONE] on the one click that finishes the goal ("Click the Night
// light toggle to turn it on. [POINT:21] [DONE]"): measured 2026-11-15 on
// publik-fast, 38 of 168 guide replies did this and 30 of them named the right
// control, which the app then dropped. Such a reply is pointed at; the next
// step's fresh screenshot ends the walk.
const ALREADY = /\b(?:already|is now|are now|you're all set|you are all set|all done)\b/i;
function endsHere(reply) {
  if (!reply || !reply.done) return false;
  return !reply.target || noClickLine(reply.instruction) || ALREADY.test(String(reply.instruction || ''));
}

function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, reject) => { t = setTimeout(() => reject(new Error(label + ' timed out')), ms); if (t.unref) t.unref(); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

class GuideSession {
  constructor(deps) {
    this.d = Object.assign({ log: () => {}, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: () => Date.now(), selfPid: -1, onKeep: () => {} }, deps);
    this.state = 'idle';
    this.gen = 0;               // bumps on every dismiss; stale async work checks it
    this.session = null;        // { id, task, source, startedAt, app, steps:[], target, hashes, unchanged, epoch, seq, ... }
    this.explainTimer = null;
    this.modelsInFlight = 0;
    // The last session, kept for a few minutes so "and how do I resize it?"
    // can lean on what was just done instead of starting from nothing.
    this.recent = null;
  }

  static get FOLLOW_UP_MS() { return 180000; }
  recentlyEnded() { return !!(this.recent && this.d.now() - this.recent.endedAt < GuideSession.FOLLOW_UP_MS); }
  remember(s, how) {
    if (!s) return;
    this.recent = { task: s.task, app: s.app ? s.app.process : '', steps: s.steps.map((st) => st.instruction).filter(Boolean), how, endedAt: this.d.now() };
  }
  // What the model is told about the previous session, when this ask reads
  // like a follow-up (short, starts with "and", "what if", "why", a pronoun, or
  // lands within the window and names nothing new).
  previousFor(task) {
    if (!this.recentlyEnded()) return null;
    const r = this.recent;
    const t = String(task || '').trim();
    const looksLikeFollowUp = /^(and|also|then|now|what if|why|how about|what about|can i|could i|ok|okay|it|that|this|next|after that)\b/i.test(t) || t.split(/\s+/).length <= 5;
    return looksLikeFollowUp ? { task: r.task, steps: r.steps.slice(-4), how: r.how } : null;
  }

  status() {
    return { state: this.state, sessionId: this.session ? this.session.id : null, task: this.session ? this.session.task : null, steps: this.session ? this.session.steps.length : 0 };
  }

  active() { return this.state !== 'idle'; }

  setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.d.send('guide:state', { state, task: 'guide', sessionId: this.session ? this.session.id : null });
  }

  // ---- entry points -------------------------------------------------------
  // opts.askedAt: when the words were heard or typed, so the timing line can
  // show what the person actually waited, routing included.
  async start(text, source, opts) {
    const task = String(text || '').trim();
    if (!task) return false;
    if (this.active()) { this.d.log('busy, ignoring ask'); this.d.send('status', { message: 'Still on the last one. Esc winds it back.' }); return false; }
    const gen = ++this.gen;
    const now = this.d.now();
    // opts.answer: a question about the screen (src/guide/screen-ask.js mode),
    // answered in words from one screenshot. No pointer, no steps.
    const answer = opts && opts.answer ? (opts.answer === true ? 'ask' : String(opts.answer)) : null;
    // opts.page: the ask is about the whole page ("summarize this"). The
    // window's own words are read too, so the answer covers what runs past
    // the screen and can still mark what is on it.
    this.session = { id: 'g' + now.toString(36), task, source: source || 'typed', startedAt: now, askedAt: (opts && opts.askedAt) || now, clickAt: null, app: null, steps: [], target: null, hashes: null, unchanged: 0, replay: null, epoch: 0, seq: 0, prevTarget: null, plan: null, T: null, answer, page: !!(answer && opts && opts.page) };
    this.d.log('start: ' + task);
    await this.begin(gen);
    return true;
  }

  // A kept walkthrough for this app and ask replays without a model call;
  // anything else goes to the live loop.
  async begin(gen) {
    const s = this.session;
    if (!s || gen !== this.gen) return;
    this.setState('reading');
    // The first read may already be done: it was started while the person was
    // still talking. It carries its own front window.
    let snap = null;
    if (this.d.snapshot) { try { snap = await this.d.snapshot.take({}); } catch (e) { this.d.log('snapshot failed: ' + e.message); } }
    if (gen !== this.gen) return;
    const fg = snap ? snap.fg : await this.foreground();
    if (gen !== this.gen) return;
    s.app = fg ? { title: fg.title || '', process: fg.process || '', hwnd: fg.hwnd } : null;
    s.frame = fg && fg.rect && fg.rect.w > 0 ? fg.rect : null;
    if (s.answer) { await this.answerScreen(gen, { fg, snap }); return; }
    const wt = fg && this.d.walkthroughs ? this.d.walkthroughs.find({ process: fg.process, title: fg.title, task: s.task }) : null;
    if (wt && wt.steps && wt.steps.length) {
      s.replay = { key: wt.key, steps: wt.steps, index: 0 };
      this.d.log('replay: ' + wt.key + ' (' + wt.steps.length + ' steps)');
      await this.replayStep(gen, fg);
      return;
    }
    await this.readAndPoint(gen, undefined, null, fg, snap);
  }

  async foreground() {
    const probe = this.d.probe && this.d.probe.available ? this.d.probe : null;
    if (!probe) return null;
    let fg = null;
    // Our own window is never "the app": the probe walks past it.
    try { fg = await probe.request('fg', { ignorePid: this.d.selfPid }, 2500); } catch (e) { this.d.log('fg failed: ' + e.message); }
    if (fg && fg.pid === this.d.selfPid) fg = null;
    return fg && fg.hwnd ? fg : null;
  }

  // One saved step: resolve the control by name through UI Automation. A
  // miss hands this step (and the rest of the session) to the live loop,
  // with the saved step as a hint, and counts against the walkthrough.
  async replayStep(gen, fgKnown) {
    const s = this.session;
    if (!s || !s.replay || gen !== this.gen) return;
    const probe = this.d.probe && this.d.probe.available ? this.d.probe : null;
    const saved = s.replay.steps[s.replay.index];
    if (!saved || !saved.target || !saved.target.name || !probe) { await this.replayMiss(gen, saved, fgKnown); return; }
    this.setState('reading');
    s.epoch += 1;
    s.T = this.newTiming('replay');
    const fg = fgKnown !== undefined ? fgKnown : await this.foreground();
    if (gen !== this.gen) return;
    if (fg) { s.app = { title: fg.title || '', process: fg.process || '', hwnd: fg.hwnd }; s.frame = fg.rect && fg.rect.w > 0 ? fg.rect : null; }
    let found = null;
    if (fg) {
      try {
        const r = await probe.request('uia.find', { hwnd: fg.hwnd, name: saved.target.name, type: saved.target.type || '' }, 3000);
        // An exact name or a name that starts with the saved one (80); a mere
        // substring (60) replayed "Save" onto "Save As" with no model call.
        if (r && r.element && r.element.rect && Number(r.score) >= 80) found = r.element;
      } catch (e) { this.d.log('replay find failed: ' + e.message); }
    }
    if (gen !== this.gen) return;
    if (!found) { await this.replayMiss(gen, saved, fg); return; }
    // A kept step must not replay into a private field either.
    if (sensitiveTarget(found) || sensitiveTarget(saved.target)) { this.d.log('replay refused: sensitive field'); s.replay = null; this.explain(REFUSAL); return; }
    s.target = { rect: found.rect, name: found.name || saved.target.name, type: found.type || saved.target.type, automationId: found.automationId || '', instruction: saved.instruction, note: '', verified: true, source: 'replay', modelMs: 0, confirmed: 'replay' };
    s.hashes = null;
    this.pointAt(s.target, gen, { replay: true });
  }

  replayMiss(gen, saved, fgKnown) {
    const s = this.session;
    if (!s || !s.replay) return;
    const stale = this.d.walkthroughs && this.d.walkthroughs.miss ? this.d.walkthroughs.miss(s.replay.key) : false;
    this.d.log('replay miss on step ' + (s.replay.index + 1) + (stale ? ' (walkthrough retired)' : ''));
    s.replay = null;
    return this.readAndPoint(gen, 'miss', saved || null, fgKnown);
  }

  dismiss(reason) {
    if (!this.active()) return;
    this.d.log('dismiss: ' + reason);
    this.gen++;
    this.clearExplain();
    this.stopWatch();
    this.setState('winding');
    this.d.send('guide:done', { sessionId: this.session ? this.session.id : null, offerKeep: false });
    this.remember(this.session, 'dismissed');
    this.state = 'idle';
    this.session = null;
  }

  // seq: which guide:target this arrival is for. An arrival for a target the
  // thread has since been moved off is ignored.
  onArrived(seq) {
    if (this.state !== 'unwinding') return;
    const s = this.session;
    if (seq != null && s && Number(seq) !== s.seq) return;
    this.setState('pointing');
    if (s && s.T) this.d.log('timing step=' + (s.steps.length + 1) + ' arrive=' + (this.d.now() - s.T.t0) + ' total=' + (s.T.wait + this.d.now() - s.T.t0));
    this.startWatch();
  }

  onClick(point) {
    const s = this.session;
    if (!s || !s.target) return;
    if (this.state === 'pointing' && clickHits(point, s.target.rect)) {
      this.d.log('click on target');
      return this.advance('click');
    }
    // The thread just moved off a quick pick and the click was already on its
    // way to the old spot: it still counts, as a click on that control.
    const pv = s.prevTarget;
    if (pv && this.d.now() <= pv.until && (this.state === 'pointing' || this.state === 'unwinding') && clickHits(point, pv.target.rect)) {
      this.d.log('click on the quick pick the model moved off');
      return this.advance('click', pv.target);
    }
  }

  onKey(vk, down) {
    if (vk === VK_ESCAPE && down && this.active()) this.dismiss('esc');
  }

  onAction(id) {
    if (id === 'next') return this.state === 'pointing' ? this.advance('next') : undefined;
    if (id === 'dismiss' || id === 'notnow') this.dismiss(id);
    return undefined;
  }

  // Keep = remember: the walkthrough is saved for replay and the summary
  // goes to the desktop. Skip = forget both.
  keep() {
    const s = this.lastRecord;
    if (s) {
      try { if (this.d.walkthroughs && this.d.walkthroughs.record) this.d.walkthroughs.record(s); } catch (e) { this.d.log('walkthrough save failed: ' + e.message); }
      try { this.d.onKeep(s); } catch (e) { this.d.log('keep failed: ' + e.message); }
    }
    this.lastRecord = null;
  }

  skip() { this.lastRecord = null; }

  // ---- the loop -----------------------------------------------------------
  // clicked: the control that was actually clicked, when it is not s.target.
  async advance(how, clicked) {
    const s = this.session;
    if (!s) return;
    const gen = this.gen;
    this.stopWatch();
    const t = clicked || s.target || {};
    s.steps.push({ instruction: t.instruction || '', name: t.name || '', type: t.type || '', automationId: t.automationId || '', boxNorm: t.boxNorm || null, outcome: how === 'click' ? 'clicked' : 'moved on', confirmed: clicked ? 'disagree' : (t.confirmed || 'model') });
    // gen only moves on dismiss. The step counter is what tells a model reply
    // that the person has already gone past the step it was for.
    s.epoch += 1;
    s.prevTarget = null;
    s.clickAt = this.d.now();
    // The last step, taken: done now. (A click on a quick pick the model moved
    // off is another control, so that one still reads the screen.)
    const last = !!s.lastStep && !clicked && !s.replay;
    s.lastStep = false;
    if (last) { this.d.log('last step taken (' + how + '): finished without another read'); this.finish(); return; }
    this.setState('reading');
    // After a click: watch the screen until it has moved and held still, or
    // until the cap. The pre-click fingerprint is the baseline, so a reaction
    // that lands before the first frame still counts. "Next" clicked nothing,
    // so there is nothing to wait for.
    s.moved = null;
    if (how === 'click' && this.d.watcher) {
      try {
        const r = await this.d.watcher.waitForChange(SETTLE_AFTER_CLICK_MS, s.hashes && s.hashes.kind === 'gray' ? s.hashes.whole : null, () => gen !== this.gen);
        s.moved = r.changed;
        this.d.log('settle: ' + (r.settled ? 'moved and still' : r.changed ? 'moved, not still' : 'no change') + ' after ' + r.ms + 'ms (' + r.frames + ' frames)');
      } catch (e) { this.d.log('settle failed: ' + e.message); await this.d.sleep(SETTLE_MS); }
    } else if (how === 'click') {
      await this.d.sleep(SETTLE_MS);
    }
    if (gen !== this.gen) return;
    if (s.steps.length >= MAX_STEPS) { this.finish('That is as far as I go in one session.'); return; }
    if (s.replay) {
      s.replay.index += 1;
      if (s.replay.index >= s.replay.steps.length) { this.finish('Done, same as last time.'); return; }
      await this.replayStep(gen);
      return;
    }
    await this.readAndPoint(gen, how);
  }

  newTiming(how) {
    const s = this.session, now = this.d.now();
    return { t0: now, how: how || 'ask', wait: now - (s.clickAt || s.askedAt || now), fg: 0, cap: 0, uia: 0, uiaInfo: '', jev: null, model: null, recon: 0, prefetch: this.d.snapshot ? 'miss' : 'off', provider: '' };
  }

  // fgKnown: the front window when the caller already looked it up (null is
  // an answer: our own window is in front). snap: a prefetched first read.
  async readAndPoint(gen, how, hint, fgKnown, snap) {
    const s = this.session;
    if (!s || gen !== this.gen) return;
    this.setState('reading');
    const epoch = ++s.epoch;
    s.prevTarget = null;
    const T = s.T = this.newTiming(how);
    const now = () => this.d.now();
    const probe = this.d.probe && this.d.probe.available ? this.d.probe : null;

    // Jev needs only the control list, so it is asked the moment the list is
    // in, while the screenshot is still being encoded. A fetch in flight delays
    // nothing; the model still starts the instant its screenshot exists.
    const mode = this.fastMode();
    const stepIndex = s.steps.length;
    const askJev = (res, front) => {
      if (mode === '0' || !res || !Array.isArray(res.elements)) return null;
      const els = jevElements(res.elements, front);
      if (!els.length) return null;
      return Promise.resolve().then(() => this.d.fastPoint.pick({ task: s.task, window: front ? { title: front.title || '', process: front.process || '' } : {}, steps: s.steps.slice(), planned: this.plannedFor(stepIndex), elements: els })).catch((e) => { this.d.log('fast failed: ' + e.message); return null; });
    };

    // The front window (our own window means the user is talking to the Knot,
    // not to an app), one capture, and the controls Windows knows about.
    let fg = null, cap = null, listRes = null, fastP = null;
    if (snap && snap.cap) {
      fg = snap.fg; cap = snap.cap; listRes = snap.list;
      T.prefetch = 'hit(' + snap.age + 'ms)';
      // What the early read cost, so the line still shows where the time went.
      if (snap.capMs != null) { T.cap = snap.capMs; T.fg = snap.fgMs; T.uia = snap.uiaMs; }
      fastP = askJev(listRes, fg);
    } else {
      // The window first (about 25 ms), then the capture and the control walk
      // together. Encoding a full-resolution PNG blocks this process for a few
      // hundred ms (live 2026-09-21: a 22 ms window lookup was seen as 374 ms
      // because its reply sat unread behind the encode), so the walk has to be
      // on its way to the probe before the capture starts.
      const tf = now();
      fg = fgKnown !== undefined ? fgKnown : await this.foreground();
      T.fg = now() - tf;
      if (gen !== this.gen) return;
      let listP = null;
      if (probe && fg && fg.hwnd) {
        const tu = now();
        listP = probe.request('uia.list', { hwnd: fg.hwnd, max: 150, budgetMs: 1200 }, 3000).then((r) => { T.uia = now() - tu; return r; }, (e) => { this.d.log('uia.list failed: ' + e.message); return null; });
        const front = fg;
        fastP = listP.then((r) => askJev(r, front));
      }
      const tc = now();
      cap = await Promise.resolve().then(() => this.d.capture()).then((c) => { T.cap = now() - tc; return c; }, (e) => { this.d.log('capture failed: ' + whyFailed(e)); return null; });
      // The walk is awaited even when the screen turns out unchanged below: a
      // walk still queued in the probe would swallow the person's next click.
      listRes = listP ? await listP : null;
    }
    if (gen !== this.gen) return;
    s.app = fg ? { title: fg.title || '', process: fg.process || '', hwnd: fg.hwnd } : null;
    s.frame = fg && fg.rect && fg.rect.w > 0 ? fg.rect : null;
    if (!cap || !cap.dataUrl) { this.explain(CAPTURE_FAILED_LINE); return; }
    const originPhys = this.d.dipToScreen({ x: cap.display.bounds.x, y: cap.display.bounds.y });

    // Did the last click change anything? Same screen twice = say so. A change
    // the watcher saw land (a menu that opened and closed again, a page that
    // moved on) counts even when the settled picture looks like the old one.
    if (how === 'click' && s.hashes && s.moved !== true) {
      const next = this.safeHash(cap, s.target ? s.target.rect : null);
      if (next && !screenChanged(s.hashes, next)) {
        s.unchanged += 1;
        if (s.unchanged >= 2) { this.explain('That did not seem to take. Try the click once more, or tell me what you see.'); return; }
        // Point at the same control again rather than burning a model call,
        // but only a control the model stood behind.
        const lastStep = s.steps[s.steps.length - 1];
        if (s.target && (!lastStep || TRUSTED.has(lastStep.confirmed))) {
          s.hashes = next;
          this.pointAt(s.target, gen, { again: true });
          return;
        }
      } else {
        s.unchanged = 0;
      }
    }

    const elements = ((listRes && listRes.elements) || []).filter((e) => e.rect).map((e) => ({ id: e.id, name: e.name, type: e.type, automationId: e.automationId, rect: e.rect, box: (() => { const n = normRectFromPhys(e.rect, cap, originPhys); return [n.x, n.y, n.w, n.h]; })() }));
    // The panes and groups round them, for the region mark when a sentence names an area.
    s.containers = ((listRes && listRes.containers) || []).filter((e) => e && e.rect);
    T.uiaInfo = elements.length + ',' + (listRes && listRes.visited != null ? listRes.visited : '?') + ',' + (listRes && listRes.truncated ? 'trunc' : 'full') + (listRes && listRes.ms != null ? ',' + listRes.ms + 'ms' : '');

    // The model: exactly the request it has always been sent.
    const llm = this.d.llm();
    if (!llm || !llm.ready) { this.explain('No AI is set up yet, so I cannot guide you. Add a free Gemini key or an Anthropic key under Settings > Keys, or sign in to Claude Code. The checklist there tests each one.', { fail: true, provider: '', err: 'No AI is set up' }); return; }
    T.provider = llm.provider || '';
    const req = buildPointRequest({ task: s.task, history: s.steps, window: s.app || { title: '(no app in front)', process: '' }, elements, hint: hint || null, plan: this.planInline(), previous: s.steps.length ? null : this.previousFor(s.task) });
    const ctx = { gen, epoch, stepIndex, fg, cap, originPhys, elements, probe, provider: T.provider };
    const t0 = now();
    this.modelsInFlight += 1;
    // The reply streams: each finished sentence is spoken (and shown by the
    // Knot) while the model is still writing its tags, so the person hears
    // the step seconds before the thread lands. Tags never reach the voice.
    // firstSpeech is stamped when the first sentence goes to the voice, not
    // when the whole reply lands (the ledger showed it equal to model_done).
    const rs = new ReplyStream();
    let said = 0;
    // An ask that reads like a question waits for the whole reply: it may end
    // in an answer instead of a step, and "Nothing to click here" must not be
    // heard first. A step that hands the ask back ("Type 'summarize' in the
    // box") or says there is nothing to click is never spoken (2026-11-11).
    const holdSpeech = answerish(s.task);
    const speak = (ev) => {
      if (ev.type !== 'speech' || holdSpeech || rs.muted) return;
      if (handsAskBack(ev.text, s.task) || noClickLine(ev.text)) { rs.muted = true; return; }
      if (said === 0 && T.firstSpeech == null) T.firstSpeech = now() - t0;
      this.sayEarly(ev.text, said++ === 0, epoch);
    };
    const onDelta = (text) => {
      if (gen !== this.gen || s.epoch !== epoch) return;
      for (const ev of rs.feed(text)) speak(ev);
    };
    const modelP = withTimeout(llm.complete({ system: req.system, turns: [{ role: 'user', text: req.text }], imageDataUrl: cap.dataUrl, json: false, maxTokens: 400, onDelta }), MODEL_TIMEOUT_MS, 'model')
      .then((raw) => {
        if (gen === this.gen && s.epoch === epoch) for (const ev of rs.end()) speak(ev);
        if (said > 0 && gen === this.gen) s.saidStep = epoch;
        return { raw, ms: now() - t0 };
      }, (err) => ({ err, ms: now() - t0 }))
      .finally(() => { this.modelsInFlight -= 1; });

    // Jev was asked when the control list came in. Live: the thread goes out on its pick.
    let fast = null, prov = null;
    if (fastP && mode === '1') {
      const first = await Promise.race([fastP.then((f) => ({ f })), modelP.then(() => ({}))]);
      if (gen !== this.gen) return;
      if (first.f) { fast = first.f; T.jev = fast.ms; if (fast.accept && s.epoch === epoch) prov = this.pointFast(fast, ctx); }
    }

    const m = await modelP;
    // Whatever Jev has said by now (its own deadline is well under the model's).
    if (fastP && !fast) { fast = await Promise.race([fastP, new Promise((r) => setTimeout(() => r(null), 0))]); if (fast) T.jev = fast.ms; }
    if (gen !== this.gen) return;
    // The person clicked the quick pick and moved on before this reply landed:
    // it may only be written down, never shown, and must not touch the probe.
    if (s.epoch !== epoch) { this.lateConfirm(ctx, m, prov, fast, mode); return; }
    T.model = m.ms;

    const outcome = await this.resolveReply(m, ctx, hint);
    if (gen !== this.gen) return;
    if (s.epoch !== epoch) { this.lateConfirm(ctx, m, prov, fast, mode); return; }
    this.recordFast(ctx, fast, mode, outcome, prov);

    if (outcome.kind === 'point') {
      // The model said this click finishes it ([DONE] with a target): the click
      // itself ends the walk, with no second screenshot and model call after it.
      s.lastStep = !!(outcome.reply && outcome.reply.done);
      if (outcome.plan) s.plan = { base: ctx.stepIndex, next: outcome.plan };
      if (prov && this.sameControl(outcome, prov, ctx)) { this.confirmFast(outcome.target, prov, gen); return; }
      if (prov) { s.prevTarget = { target: Object.assign({}, prov, { confirmed: 'disagree' }), until: now() + FAST_PREV_MS }; this.d.log('fast: the model picked another control, moving the thread'); }
      s.target = outcome.target;
      s.hashes = this.safeHash(cap, outcome.target.rect);
      this.pointAt(s.target, gen, {});
      return;
    }
    if (prov) this.retract();
    // Nothing to click for what was really a question: answer it from the same screenshot.
    if (outcome.kind === 'answer') { this.d.log('pointing gave way to an answer (' + outcome.why + ')'); await this.answerScreen(gen, { fg, cap, why: outcome.why, list: listRes }); return; }
    if (outcome.kind === 'finish') this.finish(outcome.text); else this.explain(outcome.text, { fail: outcome.why === 'fail', provider: outcome.provider, err: outcome.err });
  }

  // One screenshot, one question, answered in words (src/guide/screen-answer.js).
  // have: { fg, cap } already read, or { fg, snap } from the early read.
  async answerScreen(gen, have = {}) {
    const s = this.session;
    if (!s || gen !== this.gen) return;
    this.setState('reading');
    const epoch = ++s.epoch;
    s.prevTarget = null;
    s.target = null;
    const T = s.T = this.newTiming('answer');
    const now = () => this.d.now();
    let fg = have.fg, cap = have.cap || null;
    // Drawing (src/guide/marks.js): the answer marks what it talks about. It
    // needs what Windows knows is on the screen: the control list, and the
    // words with their places. Both are read beside the capture and the model
    // call, never in front of them.
    const drawing = this.drawOn() && (s.answer || 'ask') !== 'read';
    // The red pen (a check of their work) marks words, so it needs no control
    // walk, and it is worth the careful brain: the quick one called wrong work
    // right (live 2026-11-23, and the paid check before it).
    const pen = drawing && s.answer === 'check';
    // It takes about 8 s to its first word (measured on publik-smart; the quick
    // tier caught 2 of 5 mistakes and the middle one wrote nothing), so the wait
    // is said and shown: asked by voice, the line is spoken after the short ack.
    if (pen) {
      this.d.send('guide:hint', { text: PEN_WAIT_LINE, ms: 12000 });
      if (s.source === 'voice') this.d.send('guide:say', { text: PEN_WAIT_LINE, first: true, sessionId: s.id, stream: 'guide:' + s.id });
    }
    const probe = this.d.probe && this.d.probe.available ? this.d.probe : null;
    let listP = drawing && !pen && have.list ? Promise.resolve(have.list) : null;
    const walk = () => { if (drawing && !pen && !listP && probe && fg && fg.hwnd) listP = probe.request('uia.list', { hwnd: fg.hwnd, max: 150, budgetMs: DRAW_LIST_BUDGET_MS }, 2500).catch((e) => { this.d.log('uia.list failed: ' + e.message); return null; }); };
    if (!cap && have.snap && have.snap.cap) {
      cap = have.snap.cap; fg = have.snap.fg;
      if (drawing && !pen && !listP && have.snap.list) listP = Promise.resolve(have.snap.list);
      T.prefetch = 'hit(' + have.snap.age + 'ms)';
      if (have.snap.capMs != null) { T.cap = have.snap.capMs; T.fg = have.snap.fgMs; }
    }
    if (!cap) {
      if (fg === undefined) { const tf = now(); fg = await this.foreground(); T.fg = now() - tf; if (gen !== this.gen) return; }
      walk();
      const tc = now();
      cap = await Promise.resolve().then(() => this.d.capture()).then((c) => { T.cap = now() - tc; return c; }, (e) => { this.d.log('capture failed: ' + whyFailed(e)); return null; });
    } else walk();
    if (gen !== this.gen) return;
    if (fg) s.app = { title: fg.title || '', process: fg.process || '', hwnd: fg.hwnd };
    if (!cap || !cap.dataUrl) { this.explain(CAPTURE_FAILED_LINE); return; }
    const llm = this.d.llm();
    if (!llm || !llm.ready) { this.explain('No AI is set up yet, so I cannot answer. Open Settings to sign in or add a key.', { fail: true, provider: '', err: 'No AI is set up' }); return; }
    T.provider = llm.provider || '';
    const originPhys = this.d.dipToScreen({ x: cap.display.bounds.x, y: cap.display.bounds.y });
    const toElements = (res) => ((res && res.elements) || []).filter((e) => e && e.rect).map((e) => ({ id: e.id, name: e.name, type: e.type, automationId: e.automationId, isPassword: e.isPassword === true, rect: e.rect, box: (() => { const n = normRectFromPhys(e.rect, cap, originPhys); return [n.x, n.y, n.w, n.h]; })() }));
    // The list goes into the ask when it is in by now (it usually is: the walk
    // started before the capture). A slow walk does not hold the answer up: the
    // model then marks by words and boxes, and the list still places them.
    let listed = null;
    if (listP) {
      const tu = now();
      const res = await Promise.race([listP, this.d.sleep(DRAW_LIST_WAIT_MS).then(() => undefined)]);
      if (gen !== this.gen) return;
      if (res !== undefined) { listed = toElements(res); T.uia = now() - tu; T.uiaInfo = String(listed.length); }
    }
    // The words and where they are, read off this same screen by Windows.
    const wordsP = drawing && this.d.readWords
      ? Promise.resolve().then(() => this.d.readWords(cap)).catch((e) => { this.d.log('marks: no word boxes (' + e.message + ')'); return null; })
      : Promise.resolve(null);
    // The window's own words, for an ask about the whole page.
    let pageText = null;
    if (s.page && this.d.pageText) {
      const tp = now();
      pageText = await Promise.race([Promise.resolve().then(() => this.d.pageText(fg)).catch(() => null), this.d.sleep(PAGE_WAIT_MS).then(() => null)]);
      if (gen !== this.gen) return;
      T.page = now() - tp;
    }
    const req = buildScreenAnswer({ ask: s.task, mode: s.answer || 'ask', window: s.app || {}, draw: drawing, elements: listed, pageText });
    this.d.log('answer from the screen (' + (s.answer || 'ask') + (have.why ? ', pointer: ' + have.why : '') + (drawing ? ', drawing, ' + (listed ? listed.length + ' controls' : 'no control list') : '') + (s.page ? ', ' + (pageText ? pageText.length + ' chars of the page' : 'no page words') : '') + ')');
    const rs = new ReplyStream({ marks: drawing });
    let said = 0;
    const t0 = now();
    const speak = (ev) => {
      if (gen !== this.gen || s.epoch !== epoch) return;
      if (said === 0 && T.firstSpeech == null) T.firstSpeech = now() - t0;
      this.sayEarly(ev.text, said++ === 0, epoch, ev.sentence);
    };
    // Each mark is placed as soon as the list and the words are in, in the
    // order the answer made them, and sent with the number of its sentence so
    // the overlay draws it as that sentence is spoken.
    const tally = { asked: 0, drawn: 0, dropped: 0, sources: [], missed: [] };
    const sent = [];
    let chain = Promise.resolve();
    const mark = (ev) => {
      if (gen !== this.gen || s.epoch !== epoch) return;
      tally.asked += 1;
      if (tally.asked > MAX_MARKS) { tally.dropped += 1; return; }
      chain = chain.then(async () => {
        const [ocr, res] = await Promise.all([wordsP, listP || Promise.resolve(null)]);
        if (gen !== this.gen || s.epoch !== epoch) return;
        const elements = listed || toElements(res);
        const placed = resolveMark(ev, { elements, ocr, cap, originPhys, ids: !!listed });
        if (!placed && tally.missed.length < MAX_MARKS) tally.missed.push(ev.shape + ' ' + (ev.target.kind === 'words' ? '"' + String(ev.target.text).slice(0, 40) + '"' : ev.target.kind === 'element' ? 'id ' + ev.target.id : 'a box'));
        if (!placed || sent.some((m) => sameMark(m, placed))) { tally.dropped += 1; this.d.log('marks: not drawn (' + (placed ? 'same place twice' : 'could not place ' + ev.shape + ' ' + JSON.stringify(ev.target)) + ')'); return; }
        sent.push(placed);
        tally.drawn += 1; tally.sources.push(placed.source);
        if (T.firstMark == null) T.firstMark = now() - t0;
        const win = (r) => physRectToWindow(r, this.d.winBounds(), this.d.screenToDip);
        const out = placed.shape === 'arrow'
          ? Object.assign({ shape: 'arrow', from: win(placed.from), to: win(placed.to), verified: placed.verified }, placed.bow ? { bow: placed.bow } : {})
          : Object.assign({ shape: placed.shape, rects: placed.rects.map(win), verified: placed.verified }, placed.fix ? { fix: placed.fix } : {}, placed.above ? { above: true } : {});
        // A bright page under it: the overlay draws a dark line there, not a white one.
        if (this.onLight(cap, placed.shape === 'arrow' ? [placed.from, placed.to] : placed.rects)) out.light = true;
        // By voice the mark waits for its sentence; typed, it is drawn as it comes.
        this.d.send('guide:marks', { sessionId: s.id, sid: s.source === 'voice' && ev.sentence != null ? ev.sentence : null, marks: [out] });
      }).catch((e) => { this.d.log('marks: ' + e.message); });
    };
    const take = (ev) => { if (ev.type === 'speech') speak(ev); else if (ev.type === 'mark') mark(ev); };
    let raw = null, err = null, streamed = false;
    this.modelsInFlight += 1;
    try {
      raw = await withTimeout(llm.complete({ system: req.system, turns: [{ role: 'user', text: req.text }], imageDataUrl: cap.dataUrl, json: false, maxTokens: req.maxTokens, ...(pen && T.provider === 'publik' ? { model: PEN_PUBLIK_MODEL } : {}), onDelta: (piece) => { streamed = true; for (const ev of rs.feed(piece)) take(ev); } }), MODEL_TIMEOUT_MS, 'model');
    } catch (e) { err = e; } finally { this.modelsInFlight -= 1; }
    // The walk is awaited even when the answer is not shown: one still queued
    // in the probe would hold up the next thing asked of it.
    if (listP) await listP;
    if (gen !== this.gen || s.epoch !== epoch) return;
    T.model = now() - t0;
    if (err) { this.d.log('answer failed: ' + err.message); this.explain(plainAskError(T.provider, err), { fail: true, provider: T.provider, err }); return; }
    // A brain that does not stream hands the whole reply back at the end.
    // Every sentence of it is taken, in order (before 0.1.38 only the last one
    // reached the voice: the rest were dropped with feed's return value).
    if (!streamed && raw) for (const ev of rs.feed(String(raw))) take(ev);
    for (const ev of rs.end()) take(ev);
    if (said > 0) s.saidStep = epoch;
    const text = rs.spoken.join(' ').trim();
    this.explain(text || 'I did not get an answer back. Try asking again.', { ms: answerMs(text) + (tally.asked ? MARKS_LINGER_MS : 0), kicker: 'answer', end: 'answer' });
    if (!tally.asked) return;
    // Once the marks are down: count them, and take them off when the screen
    // under them moves (a scroll, another window), so none sits on the wrong thing.
    chain.then(() => {
      this.d.log('marks: drew ' + tally.drawn + ' of ' + tally.asked + (tally.sources.length ? ' (' + tally.sources.join(', ') + ')' : '') + (T.firstMark != null ? ', first at ' + T.firstMark + 'ms' : ''));
      try { if (this.d.onMarks) this.d.onMarks({ session: s.id, asked: tally.asked, drawn: tally.drawn, dropped: tally.dropped, sources: tally.sources.slice(), missed: tally.missed.slice(), model: req.pen ? 'pen' : '', modelMs: T.model, firstMs: T.firstSpeech, provider: T.provider, app: s.app ? s.app.process : '' }); } catch (_) { /* counting never breaks an answer */ }
      if (tally.drawn && gen === this.gen) this.watchMarks(gen, s.id);
    });
  }

  // Is the screen bright where these rects are? From the picture already taken
  // (brightness(cap, rect) -> 0..1). Not knowing is "dark": the white thread.
  onLight(cap, rects) {
    if (typeof this.d.brightness !== 'function') return false;
    let sum = 0, n = 0;
    for (const r of rects || []) {
      let v = null;
      try { v = this.d.brightness(cap, r); } catch (_) { v = null; }
      if (Number.isFinite(v)) { sum += v; n += 1; }
    }
    return n > 0 && sum / n >= MARKS_LIGHT;
  }

  // A thing found on the screen with no model (src/guide/find.js): each place
  // gets a ring (a frame when it is long), the Knot says one short line, and
  // it is held and let go like an answer: Esc, the talk key, the timer, or the
  // screen moving under it. rects are physical pixels on the captured display.
  found(task, source, { rects, cap, line, askedAt } = {}) {
    if (this.active() || !Array.isArray(rects) || !rects.length || !cap) return false;
    const gen = ++this.gen;
    const now = this.d.now();
    this.session = { id: 'g' + now.toString(36), task: String(task || ''), source: source || 'typed', startedAt: now, askedAt: askedAt || now, clickAt: null, app: null, steps: [], target: null, hashes: null, unchanged: 0, replay: null, epoch: 1, seq: 0, prevTarget: null, plan: null, T: null, answer: 'find' };
    const s = this.session;
    s.T = this.newTiming('find');
    this.d.log('found on the screen: ' + rects.length + ' place(s) for "' + s.task.slice(0, 60) + '"');
    const win = (r) => physRectToWindow(r, this.d.winBounds(), this.d.screenToDip);
    const marks = rects.slice(0, MAX_MARKS).map((r) => {
      // frame: a whole item (a video with its picture) gets a frame, as a long line does.
      const m = { shape: r.frame || r.w > cap.pxWidth * FOUND_FRAME_SHARE ? 'box' : 'circle', rects: [win({ x: r.x, y: r.y, w: r.w, h: r.h })], verified: true };
      if (this.onLight(cap, [r])) m.light = true;
      return m;
    });
    this.d.send('guide:marks', { sessionId: s.id, sid: null, marks });
    this.explain(line || 'Here it is.', { ms: FOUND_MS, kicker: 'found', end: 'answer' });
    try { if (this.d.onMarks) this.d.onMarks({ session: s.id, asked: marks.length, drawn: marks.length, dropped: 0, sources: marks.map(() => 'find'), provider: '', app: '' }); } catch (_) { /* counting never breaks it */ }
    this.watchMarks(gen, s.id);
    return true;
  }

  // Whether answers may draw on the screen (Settings, Draw on the screen).
  drawOn() { try { return !!(this.d.drawOn && this.d.drawOn()); } catch (_) { return false; } }

  // The marks stay while the answer is up and the screen holds still. A
  // screen that has clearly moved takes them off: a ring left on whatever
  // scrolled under it would be pointing at the wrong thing.
  async watchMarks(gen, sessionId) {
    const w = this.d.watcher;
    if (!w || typeof w.grab !== 'function') return;
    const live = () => gen === this.gen && this.state === 'explaining';
    // The bubble and the last strokes are part of the picture to compare against.
    await this.d.sleep(MARKS_SETTLE_MS);
    let base = null;
    while (live()) {
      let frame = null;
      try { frame = await w.grab(); } catch (_) { frame = null; }
      if (!live()) return;
      if (frame && !base) base = frame;
      else if (frame && difference(base, frame) >= MARKS_MOVED) {
        this.d.log('marks: the screen moved, taking them off');
        this.d.send('guide:marks:clear', { sessionId, why: 'moved' });
        return;
      }
      await this.d.sleep(MARKS_WATCH_MS);
    }
  }

  // The model's raw reply -> what to do. { kind:'point', target, reply, plan } |
  // { kind:'explain', text, why } | { kind:'finish', text }.
  async resolveReply(m, ctx) {
    const s = this.session;
    const { cap, originPhys, elements, probe, fg } = ctx;
    if (m.err) {
      this.d.log('model failed: ' + m.err.message);
      // Provider errors read as a wall of JSON otherwise (src/ask-error.js).
      return { kind: 'explain', why: 'fail', text: plainAskError(ctx.provider, m.err), provider: ctx.provider, err: m.err };
    }
    const modelMs = m.ms;
    const parsed = parsePointReply(m.raw);
    const v = validatePoint(parsed, elements, { verified: !!probe, image: cap && { width: cap.width, height: cap.height } });
    this.d.log(`model ${modelMs}ms: ${v.ok ? 'ok' : 'rejected'} (${v.reason})` + (parsed && parsed.target ? ' target=' + JSON.stringify(parsed.target) : ''));
    // A question, not a task: the model said so ([ANSWER]), or found nothing to
    // click for it, or the step it wrote hands the ask back to the person
    // ("Type 'summarize for me' in the box", live 2026-11-11). Answer instead.
    const question = s && answerish(s.task);
    if (v.reply && v.reply.answer) return { kind: 'answer', why: 'model said answer' };
    if (v.reply && handsAskBack(v.reply.instruction, s ? s.task : '')) return { kind: 'answer', why: 'step handed the ask back' };
    if (question && (!v.ok || !v.reply)) return { kind: 'answer', why: 'no valid step' };
    if (question && v.reply && !v.reply.target && (!v.reply.done || noClickLine(v.reply.instruction))) return { kind: 'answer', why: 'nothing to click' };
    if (!v.ok || !v.reply) return { kind: 'explain', why: 'invalid', text: 'I could not work out the next step from this screen. Tell me a little more, or open the app first.' };
    const reply = v.reply;
    if (endsHere(reply)) return { kind: 'finish', text: reply.instruction, reply };
    if (!reply.target) return { kind: 'explain', why: 'null', text: reply.instruction + (reply.note ? ' ' + reply.note : ''), reply };

    // Reconcile with Windows before anything moves.
    const tr = this.d.now();
    let bboxPhys = null, fromPoint = null, found = null;
    if (reply.target.kind === 'bbox') {
      bboxPhys = physRectFromNorm(reply.target, cap, originPhys);
      if (probe) {
        const cx = bboxPhys.x + bboxPhys.w / 2, cy = bboxPhys.y + bboxPhys.h / 2;
        // Both checks at once, short leash: they only upgrade a guess to a
        // verified box, so a slow answer is not worth waiting seconds for.
        const [fp, fd] = await Promise.all([
          probe.request('uia.frompoint', { x: cx, y: cy, ignorePid: this.d.selfPid }, 1500).catch(() => null),
          reply.target.label && fg && fg.hwnd ? probe.request('uia.find', { hwnd: fg.hwnd, name: reply.target.label }, 1500).catch(() => null) : Promise.resolve(null),
        ]);
        fromPoint = fp && fp.element;
        found = fd && fd.element;
        // Neither agreed: the model's box is often a little off the control. Look
        // at the controls around it (a ring of points plus the ones from the
        // list) and take a clear winner by words and distance (chooser.js).
        if (!reconcile({ target: reply.target, elements, bboxPhys, fromPoint, found, verified: true }).verified && reply.target.label) {
          const near = await this.ringProbe(probe, bboxPhys, elements);
          const pick = chooseElement(reply.target.label, { x: cx, y: cy }, near, { radius: Math.max(90, Math.hypot(bboxPhys.w, bboxPhys.h)) });
          if (pick) { fromPoint = Object.assign({}, pick.element, { ring: true }); this.d.log('reconcile: chose "' + (pick.element.name || '') + '" near the box (' + pick.score.toFixed(2) + ')'); }
        }
      }
    }
    if (s && s.T) s.T.recon = this.d.now() - tr;
    const hit = reconcile({ target: reply.target, elements, bboxPhys, fromPoint, found, verified: !!probe });
    if (!hit) {
      this.d.log('reconcile failed for ' + JSON.stringify(reply.target));
      return { kind: 'explain', why: 'reconcile', reply, text: 'I think the next step is: ' + reply.instruction + ' But I could not find that control for sure, so I will not point at it.' };
    }
    const chosen = reply.target.kind === 'element' ? elements.find((e) => Number(e.id) === Number(reply.target.id)) : null;
    // Never a password, card or identity field, whatever the model said.
    if (sensitiveTarget(chosen) || sensitiveTarget(fromPoint) || sensitiveTarget(found) || sensitiveTarget({ name: hit.name, type: hit.type || 'edit' })) {
      this.d.log('refused: sensitive field "' + (hit.name || '') + '"');
      return { kind: 'explain', why: 'sensitive', reply, text: REFUSAL };
    }
    const boxNorm = normRectFromPhys(hit.rect, cap, originPhys);
    // A hedged pick (low model confidence) is pointed at but labelled a best
    // guess, same as a box Windows could not confirm.
    const sure = hit.verified && reply.confidence >= CONF_SURE;
    const target = { rect: hit.rect, name: hit.name, type: hit.type, automationId: (chosen && chosen.automationId) || (fromPoint && fromPoint.automationId) || '', boxNorm, instruction: reply.instruction, note: reply.note, verified: sure, source: hit.source, modelMs, confirmed: 'model', id: chosen ? chosen.id : null };
    return { kind: 'point', target, reply, plan: reply.next && reply.next.length ? reply.next : null };
  }

  // ---- the quick pointer ----------------------------------------------------
  fastMode() {
    const fp = this.d.fastPoint;
    if (!fp || !fp.mode || !fp.pick) return '0';
    let mode = '0';
    try { mode = fp.mode(); } catch (_) { mode = '0'; }
    // The person clicked ahead and an earlier step's model call is still
    // running: this step waits for its own model rather than stacking more.
    if (mode === '1' && this.modelsInFlight > 0) return 'shadow';
    return mode;
  }

  planInline() { try { return Boolean(this.d.planMode && this.d.planMode() === 'inline'); } catch (_) { return false; } }

  // What the model, one or two replies ago, expected this step to be. It is
  // only ever shown to Jev, never fed back into the model's own prompt.
  plannedFor(stepIndex) {
    const p = this.session && this.session.plan;
    if (!p || !Array.isArray(p.next)) return null;
    return p.next[stepIndex - p.base - 1] || null;
  }

  pointFast(fast, ctx) {
    const s = this.session;
    const el = fast.element;
    if (sensitiveTarget(el)) { this.d.log('fast: refused a sensitive field'); return null; }
    const planned = fast.planned ? this.plannedFor(ctx.stepIndex) : null;
    const target = { rect: el.rect, name: el.name || '', type: el.type || '', automationId: el.automationId || '', boxNorm: normRectFromPhys(el.rect, ctx.cap, ctx.originPhys), instruction: (planned && planned.instruction) || templateInstruction(el), note: '', verified: true, source: 'fast', modelMs: 0, confirmed: 'pending', id: el.id };
    s.target = target;
    s.hashes = this.safeHash(ctx.cap, el.rect);
    this.d.log('fast: pointing at "' + target.name + '" conf=' + fast.confidence.toFixed(2) + ' jev=' + fast.ms + 'ms');
    this.pointAt(target, ctx.gen, { fast: true });
    return target;
  }

  // Same walk, so ids compare. A model bbox is "the same control" when it sits
  // on the quick pick or names it.
  sameControl(outcome, prov, ctx) {
    const t = outcome.reply && outcome.reply.target;
    if (!t || !prov) return false;
    if (t.kind === 'element') return Number(t.id) === Number(prov.id);
    const box = physRectFromNorm(t, ctx.cap, ctx.originPhys);
    return iou(box, prov.rect) >= 0.3 || (t.label ? tokenOverlap(t.label, prov.name) >= 0.5 : false);
  }

  // The model agrees: its sentence, its confidence and its note take over in
  // place. The thread does not move.
  confirmFast(modelTarget, prov, gen) {
    const s = this.session;
    if (!s || gen !== this.gen) return;
    s.target = Object.assign({}, modelTarget, { rect: prov.rect, boxNorm: prov.boxNorm, confirmed: 'agree' });
    const b = this.bubbleFor(s.target, {});
    this.d.log('fast: the model agrees');
    this.logTiming('update');
    this.d.send('guide:update', { seq: s.seq, step: s.steps.length + 1, kicker: b.kicker, instruction: s.target.instruction, hint: b.hint, sessionId: s.id, speak: s.source === 'voice' && !this.saidThisStep() ? s.target.instruction : undefined });
  }

  retract() {
    const s = this.session;
    this.stopWatch();
    this.d.log('fast: the model has no control to point at, bringing the thread back');
    this.d.send('guide:retract', { sessionId: s ? s.id : null });
    if (s) { s.target = null; s.hashes = null; }
  }

  // A reply for a step the person already left. Bookkeeping only.
  lateConfirm(ctx, m, prov, fast, mode) {
    const s = this.session;
    const step = s && s.steps[ctx.stepIndex];
    let outcome = { kind: 'explain', why: 'fail' };
    if (!m.err) {
      const v = validatePoint(parsePointReply(m.raw), ctx.elements, { verified: !!ctx.probe, image: ctx.cap && { width: ctx.cap.width, height: ctx.cap.height } });
      if (v.ok && v.reply) outcome = endsHere(v.reply) ? { kind: 'finish', reply: v.reply } : v.reply.target ? { kind: 'point', reply: v.reply } : { kind: 'explain', why: 'null', reply: v.reply };
      else outcome = { kind: 'explain', why: 'invalid' };
    }
    const verdict = outcome.kind === 'point' ? (this.sameControl(outcome, prov, ctx) ? 'agree' : 'disagree') : (outcome.why === 'fail' || outcome.why === 'invalid') ? 'unknown' : 'disagree';
    if (step && step.confirmed === 'pending') {
      step.confirmed = verdict;
      if (verdict === 'agree' && outcome.reply.instruction) step.instruction = outcome.reply.instruction;
    }
    if (outcome.kind === 'point' && outcome.reply.next && outcome.reply.next.length && s && s.steps.length === ctx.stepIndex + 1) s.plan = { base: ctx.stepIndex, next: outcome.reply.next };
    this.d.log('fast: late reply for step ' + (ctx.stepIndex + 1) + ' (' + m.ms + 'ms): ' + verdict);
    this.recordFast(ctx, fast, mode, outcome, prov, true);
  }

  // One record per step for the shadow log: what Jev picked, what the model
  // picked, and whether they were the same control.
  recordFast(ctx, fast, mode, outcome, prov, late) {
    if (!fast) return;
    const s = this.session;
    const t = outcome.reply && outcome.reply.target;
    const model = outcome.kind === 'point' ? (t && t.kind === 'bbox' ? 'bbox' : 'element') : outcome.kind === 'finish' ? 'done' : (outcome.why || 'null');
    const same = outcome.kind === 'point' && fast.element ? this.sameControl(outcome, { id: fast.element.id, rect: fast.element.rect, name: fast.element.name }, ctx) : null;
    const verdict = !fast.element ? 'FAST_NONE' : outcome.kind === 'point' ? (same ? 'AGREE' : 'DISAGREE') : 'MODEL_' + String(model).toUpperCase();
    this.d.log('fast ' + mode + ' pick=' + fast.key + (fast.element ? ' "' + fast.element.name + '"' : '') + ' conf=' + Number(fast.confidence || 0).toFixed(2) + ' margin=' + (fast.margin == null ? '?' : fast.margin.toFixed(2)) + ' gate=' + fast.reason + ' jev=' + fast.ms + 'ms options=' + fast.options + ' -> ' + verdict + (late ? ' (late)' : ''));
    if (!this.d.onFast) return;
    try {
      this.d.onFast({
        at: this.d.now(), session: s ? s.id : null, task: s ? s.task : '', app: s && s.app ? s.app.process : '', step: ctx.stepIndex + 1, mode, shown: Boolean(prov), late: Boolean(late),
        fast: { key: fast.key, name: fast.element ? fast.element.name : '', type: fast.element ? fast.element.type : '', confidence: fast.confidence, margin: fast.margin, finished: fast.finished, rightApp: fast.rightApp, planned: Boolean(fast.planned), accept: fast.accept, reason: fast.reason, ms: fast.ms, options: fast.options },
        model: { kind: model, id: t && t.kind === 'element' ? t.id : null, name: t ? (t.name || t.label || '') : '', confidence: outcome.reply ? outcome.reply.confidence : null },
        same, verdict,
      });
    } catch (e) { this.d.log('fast record failed: ' + e.message); }
  }

  // The controls around a box: the one under each of six points on a ring
  // inside the box, plus every listed control whose rectangle is near it.
  // Each lookup is a short probe call; the ring runs them together.
  async ringProbe(probe, box, elements) {
    const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
    const rx = Math.max(6, box.w * 0.35), ry = Math.max(6, box.h * 0.35);
    const points = [0, 60, 120, 180, 240, 300].map((deg) => ({ x: Math.round(cx + rx * Math.cos(deg * Math.PI / 180)), y: Math.round(cy + ry * Math.sin(deg * Math.PI / 180)) }));
    const hits = await Promise.all(points.map((p) => probe.request('uia.frompoint', { x: p.x, y: p.y, ignorePid: this.d.selfPid }, 800).then((r) => r && r.element, () => null)));
    const seen = new Map();
    const add = (e) => { if (!e || !e.rect) return; const k = [e.rect.x, e.rect.y, e.rect.w, e.rect.h, (e.name || '').toLowerCase()].join('|'); if (!seen.has(k)) seen.set(k, e); };
    hits.forEach(add);
    const reach = Math.max(120, Math.hypot(box.w, box.h));
    for (const e of elements || []) if (e.rect && Math.hypot(e.rect.x + e.rect.w / 2 - cx, e.rect.y + e.rect.h / 2 - cy) <= reach) add(e);
    return Array.from(seen.values());
  }

  // ---- early speech -----------------------------------------------------------
  // A sentence the model has finished writing for this step. By voice it is
  // spoken at once (sentence two queues behind sentence one in the renderer);
  // either way the first one shows by the Knot while the thread is still to come.
  // sid: the sentence's number in an answer that draws, so a mark can wait for it.
  sayEarly(text, first, epoch, sid) {
    const s = this.session;
    if (!s || s.epoch !== epoch) return;
    if (first) this.d.send('guide:hint', { text, ms: 9000 });
    if (s.source === 'voice') this.d.send('guide:say', Object.assign({ text, first, sessionId: s.id, stream: 'guide:' + s.id }, sid != null ? { sid } : {}));
  }

  // Whether this step's words have already been spoken as they streamed.
  saidThisStep() { const s = this.session; return !!(s && s.saidStep === s.epoch); }

  // ---- drawing --------------------------------------------------------------
  bubbleFor(target, opts) {
    const step = this.session.steps.length + 1;
    if (opts.fast) return { kicker: 'step ' + step + ' · quick', hint: 'Quick pick. Checking it against your screen now.' };
    return {
      kicker: opts.again ? 'step ' + step + ' · again' : opts.replay ? 'step ' + step + ' · from last time' : target.verified ? 'step ' + step : 'step ' + step + ' · best guess',
      hint: opts.replay
        ? 'Same as last time. Click it and I will keep going. Or press Next.'
        : (target.note ? target.note + ' ' : '') + (target.verified ? 'Click it and I will re-read the screen.' : 'Best guess from the screenshot. Click it and I will re-read the screen.') + ' Or press Next.',
    };
  }

  pointAt(target, gen, opts) {
    const s = this.session;
    if (!s || gen !== this.gen) return;
    const bbox = physRectToWindow(target.rect, this.d.winBounds(), this.d.screenToDip);
    const step = s.steps.length + 1;
    const b = this.bubbleFor(target, opts);
    // The area the sentence names, when the read has a frame for it (region.js).
    const region = regionFor(target.instruction, target.rect, s.containers || [], s.frame);
    s.seq += 1;
    this.logTiming(opts.fast ? 'fast' : opts.again ? 'again' : opts.replay ? 'replay' : 'point');
    this.setState('unwinding');
    const payload = {
      bbox,
      // The window the target sits in, so a target that is a whole window or a
      // big panel can be marked by its corner instead of a point in its middle.
      window: s.frame ? physRectToWindow(s.frame, this.d.winBounds(), this.d.screenToDip) : undefined,
      region: region ? physRectToWindow(region, this.d.winBounds(), this.d.screenToDip) : undefined,
      task: 'guide',
      step,
      kicker: b.kicker,
      instruction: target.instruction,
      hint: b.hint,
      actions: [{ id: 'next', label: 'Next' }],
      sessionId: s.id,
      seq: s.seq,
      // The checklist: steps done so far, this one, and what the model expects next.
      plan: { done: s.steps.map((st) => st.instruction).filter(Boolean).slice(-6), current: target.instruction, next: (s.plan && s.plan.base === s.steps.length ? s.plan.next : []).map((n) => n.instruction).filter(Boolean).slice(0, 3) },
      // One spoken sentence, only when the user asked by voice, and only when
      // it was not already spoken as it streamed in.
      speak: s.source === 'voice' && !this.saidThisStep() ? target.instruction : undefined,
    };
    // A quick pick is silent: the one spoken sentence is the model's.
    if (opts.fast) payload.speak = undefined;
    this.d.send('guide:target', payload);
  }

  logTiming(end) {
    const s = this.session;
    const T = s && s.T;
    if (!T) return;
    const point = this.d.now() - T.t0;
    const rec = { at: this.d.now(), session: s.id, task: s.task, app: s.app ? s.app.process : '', step: s.steps.length + 1, how: T.how, end, wait: T.wait, fg: T.fg, cap: T.cap, uia: T.uia, uiaInfo: T.uiaInfo, jev: T.jev, model: T.model, recon: T.recon, point, total: T.wait + point, prefetch: T.prefetch, provider: T.provider, firstSpeech: T.firstSpeech == null ? null : T.firstSpeech };
    this.d.log(`timing step=${rec.step} how=${rec.how} end=${end} wait=${rec.wait} fg=${rec.fg} cap=${rec.cap} uia=${rec.uia}(${rec.uiaInfo}) jev=${rec.jev == null ? '-' : rec.jev} model=${rec.model == null ? '-' : rec.model} recon=${rec.recon} point=${point} total=${rec.total} prefetch=${rec.prefetch}` + (rec.provider ? ' via ' + rec.provider : '') + (rec.app ? ' in ' + rec.app : ''));
    try { if (this.d.onTiming) this.d.onTiming(rec); } catch (_) { /* logging never breaks a step */ }
  }

  // opts.fail: the model or a key failed, so the bubble says so (kind) and
  // carries the fix: Open Settings lands on the key checklist.
  explain(text, opts = {}) {
    const s = this.session;
    this.stopWatch();
    this.logTiming(opts.end || 'explain');
    this.setState('explaining');
    // A failed answer whose cause is the person's own key: the host may add one button (Switch to publik).
    let extra = [];
    if (opts.fail && opts.err && typeof this.d.failActions === 'function') { try { extra = this.d.failActions(opts.provider, opts.err) || []; } catch (_) { extra = []; } }
    const actions = opts.fail ? [{ id: 'settings', label: 'Open Settings', primary: true }, ...extra, { id: 'dismiss', label: 'OK' }] : [{ id: 'dismiss', label: 'OK' }];
    this.d.send('guide:bubble', { text, anchor: 'knot', task: 'ask', kind: opts.fail ? 'error' : '', kicker: opts.fail ? 'could not answer' : (opts.kicker || ''), actions, sessionId: s ? s.id : null, speak: s && s.source === 'voice' && !this.saidThisStep() ? text : undefined });
    this.clearExplain();
    // An answer stays up long enough to read (opts.ms); a step's note does not.
    this.explainTimer = setTimeout(() => { if (this.state === 'explaining') this.dismiss('explain-timeout'); }, opts.ms || EXPLAIN_MS);
    if (this.explainTimer.unref) this.explainTimer.unref();
  }

  finish(closing) {
    const s = this.session;
    if (!s) return;
    this.stopWatch();
    this.logTiming('finish');
    this.gen++;
    // A quick pick the model never stood behind must not be replayed forever
    // with no model call: such a session is not offered for keeping.
    const keepable = s.steps.length > 0 && s.steps.every((st) => TRUSTED.has(st.confirmed || 'model'));
    this.lastRecord = keepable ? { id: s.id, task: s.task, app: s.app, steps: s.steps.slice(), startedAt: s.startedAt, endedAt: this.d.now() } : null;
    this.setState('done');
    this.d.send('guide:bubble', { text: closing || 'Done.', anchor: 'knot', task: 'guide', sessionId: s.id, speak: s.source === 'voice' && !this.saidThisStep() ? (closing || 'Done.') : undefined });
    this.remember(s, 'finished');
    const id = s.id;
    setTimeout(() => {
      this.d.send('guide:done', { sessionId: id, summary: s.task, offerKeep: keepable });
      this.state = 'idle';
      this.session = null;
    }, 2400);
  }

  // ---- helpers --------------------------------------------------------------
  safeHash(cap, rect) {
    try { return this.d.hashCapture ? this.d.hashCapture(cap, rect) : null; } catch (e) { this.d.log('hash failed: ' + e.message); return null; }
  }

  startWatch(extraKeys) {
    const probe = this.d.probe && this.d.probe.available ? this.d.probe : null;
    if (!probe) { this.watchWithoutProbe(); return; }
    const keys = [VK_ESCAPE].concat(Array.isArray(extraKeys) ? extraKeys : []);
    probe.watch({ keys, click: true, fg: false }).catch((e) => this.d.log('watch failed: ' + e.message));
  }

  // No click watcher (a Mac): the click is seen as the cursor on the target, then the screen changing
  // (./click-guess.js). Only where the host says so (guessClicks), once per step.
  watchWithoutProbe() {
    const s = this.session;
    if (!this.d.guessClicks || !s || !s.target || !s.target.rect || !this.d.cursor || !this.d.watcher || this.state !== 'pointing') return;
    if (s.guessing === s.epoch) return;
    s.guessing = s.epoch;
    const gen = this.gen, epoch = s.epoch, rect = s.target.rect;
    const stale = () => gen !== this.gen || this.session !== s || s.epoch !== epoch || this.state !== 'pointing';
    guessClick({ rect, cursor: () => this.d.dipToScreen(this.d.cursor()), grab: () => this.d.watcher.grab(), isStale: stale })
      .then((r) => { if (r.clicked && !stale()) { this.d.log('click on target (' + r.why + ')'); this.advance('click'); } })
      .catch((e) => this.d.log('click guess failed: ' + e.message));
  }

  stopWatch() {
    const probe = this.d.probe;
    if (probe && probe.unwatch && probe.status && probe.status().watching) probe.unwatch().catch(() => {});
  }

  clearExplain() { if (this.explainTimer) { clearTimeout(this.explainTimer); this.explainTimer = null; } }
}

module.exports = { GuideSession, MAX_STEPS, SETTLE_MS, SETTLE_AFTER_CLICK_MS, FAST_PREV_MS, endsHere };
