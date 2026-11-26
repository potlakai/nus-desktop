'use strict';
// The Hands loop: read the screen, think, ask first when it matters, act,
// wait for the screen to settle, look again, until the goal is met or the
// person stops it.
//
//   idle -> running -> (asking -> running)* -> done | stopped
//
// Pure JS with injected dependencies so it runs in tests without Electron:
//   read()                     -> { fg, cap, elements (with physical rects and box fractions), originPhys }
//   llm()                      -> { ready, provider, complete({system, turns, imageDataUrl, onDelta}) }
//   actions                    -> createActions(): run(name, args, ctx)
//   consent                    -> { preview, pending: createPending() }
//   send(channel, payload)     -> the overlay renderer
//   speak(text, first)         -> early speech for voice asks (main decides)
//   watcher                    -> ScreenWatcher: waitForChange(ms, baseline, isStale)
//   fingerprint(cap)           -> the gray print of a capture, the watcher's baseline
//   retract()                  -> bring the thread home
//   memoryBlock()              -> what Nūs knows about the person, for the prompt
//   ledger, log, now, sleep
const { SYSTEM, userTurn } = require('./prompt');
const { AgentStream } = require('./reply');
const { settleSignature } = require('../guide/settle');
const { plainAskError } = require('../ask-error');

const MAX_STEPS = 15;
const EXTRA_STEPS = 10;            // granted a few at a time while clearly progressing
const MODEL_TIMEOUT_MS = 75000;
const REPEAT_LIMIT = 3;
const DONE_REJECTIONS = 2;
const RESUME_WINDOW_MS = 5 * 60 * 1000;
const FOLLOW_UP_WINDOW_MS = 2 * 60 * 1000;
const HISTORY_CARRY = 6;           // steps carried into a "keep going" run

function clip(s, n) { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

// Windows' own Alt+Tab switcher ("Task Switching", explorer.exe) was read as
// the front window twice live 2026-10-11. It is never the app the task is
// about: the reader skips it and looks again.
const SWITCHER_TITLES = /^(?:task switching|task view|snap assist|search|start|windows input experience)$/i;
function isSwitcher(fg) {
  if (!fg) return false;
  const title = String(fg.title || '').trim();
  const proc = String(fg.process || '').toLowerCase();
  if (SWITCHER_TITLES.test(title) && (!proc || /^(?:explorer|searchhost|startmenuexperiencehost|shellexperiencehost|textinputhost)$/.test(proc))) return true;
  return false;
}

// The apps a task may act in: the one in front when it started, and any that
// Hands itself opened. Live 2026-10-22: mid "select the first one" in Firefox,
// Word and then the Claude app came to the front, and Hands clicked "Table
// Grid" in Word and a row in Claude, then called it done. A window it did not
// open coming to the front now stops the task instead.
const OPENERS = new Set(['open_app', 'open_url', 'web_search', 'open_file']);
const OPEN_GRACE_READS = 3;        // looks after an opener in which a new app may come to the front
function appOf(fg) { return fg ? String(fg.process || '').toLowerCase() : ''; }

function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, reject) => { t = setTimeout(() => reject(new Error(label + ' timed out')), ms); if (t.unref) t.unref(); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

class HandsAgent {
  constructor(deps) {
    this.d = Object.assign({ log: () => {}, now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)), speak: () => {}, retract: () => {}, memoryBlock: () => '', onActive: () => {}, maxSteps: MAX_STEPS }, deps);
    this.state = 'idle';
    this.gen = 0;
    this.runId = 0;
    this.task = null;
  }

  active() { return this.state !== 'idle'; }
  // The id its bubbles carry, so a dismiss from an earlier run's bubble is told apart.
  bubbleId() { return 'hands:' + this.runId; }
  asking() { return this.state === 'asking'; }
  status() { return { state: this.state, goal: this.task ? this.task.goal : null, steps: this.task ? this.task.history.length : 0 }; }

  setState(state) {
    if (this.state === state) return;
    const was = this.state;
    this.state = state;
    if (was === 'idle') { try { this.d.onActive(true); } catch (_) { /* a hook never breaks the loop */ } }
    this.d.send('guide:state', { state: state === 'running' ? 'thinking' : state === 'asking' ? 'pointing' : state === 'idle' ? 'idle' : 'thinking', task: 'hands' });
  }

  // The person stopped it: Esc, "stop", a dismiss, a new ask.
  stop(reason) {
    if (!this.active()) return;
    this.d.log('stop: ' + reason);
    this.gen++;
    // The model request in flight is cut too (2026-10-31): before, Esc ended
    // the task but the reply kept streaming to completion, tokens and all.
    if (this.abort) { try { this.abort.abort(); } catch (_) { /* already done */ } this.abort = null; }
    if (this.d.consent && this.d.consent.pending) this.d.consent.pending.cancel(reason);
    this.finish('stopped', reason === 'esc' || reason === 'voice' ? '' : 'Okay, stopped.');
  }

  // The focus guard closed what this run is working in: it ends on the guard's
  // own line, and "keep going" does not take it back.
  refuse(line) {
    if (!this.active()) return;
    this.d.log('refused: ' + line);
    this.gen++;
    if (this.abort) { try { this.abort.abort(); } catch (_) { /* already done */ } this.abort = null; }
    if (this.d.consent && this.d.consent.pending) this.d.consent.pending.cancel('focus guard');
    this.finish('guarded', line);
  }

  // A card button, or a spoken answer while a card is up.
  answer(yes) { return this.d.consent && this.d.consent.pending ? this.d.consent.pending.answer(Boolean(yes), 'button') : false; }
  spoken(text, opts) { return this.d.consent && this.d.consent.pending ? this.d.consent.pending.spoken(text, opts) : null; }

  // "Keep going" after the step budget ran out: the same task, picking up
  // where it stopped, for a few minutes after.
  canResume() { return Boolean(this.last && (this.last.outcome === 'budget' || this.last.outcome === 'away') && this.d.now() - this.last.endedAt < RESUME_WINDOW_MS); }
  resume(source, opts = {}) {
    if (!this.canResume()) return false;
    const L = this.last;
    this.last = null;
    return this.run(L.request, source || L.source, Object.assign({}, opts, { goal: L.goal, history: L.history }));
  }

  // "Enter the recipient as ..." just after a run: more of the same task, with
  // what was done so far, not a new one. Not after a stop, a no or a failure.
  canFollowUp() { return Boolean(this.last && ['ok', 'budget', 'away', 'asked'].includes(this.last.outcome) && this.d.now() - this.last.endedAt < FOLLOW_UP_WINDOW_MS); }
  followUp(words, source, opts = {}) {
    if (!this.canFollowUp()) return false;
    const L = this.last;
    this.last = null;
    return this.run(words, source || L.source, Object.assign({}, opts, { goal: L.goal + '. Now also: ' + String(words || '').trim(), history: L.history }));
  }

  async run(request, source, opts = {}) {
    const text = String(request || '').trim();
    if (!text) return false;
    if (this.active()) { this.d.send('status', { message: 'Still on the last task. Esc stops it.' }); return false; }
    const gen = ++this.gen;
    this.runId++;
    const t0 = this.d.now();
    this.task = { request: text, goal: opts.goal || text, source: source || 'typed', askedAt: opts.askedAt || t0, history: Array.isArray(opts.history) ? opts.history.slice() : [], steps: 0, spoke: false, apps: new Set(), openGrace: 0, repeats: new Map(), budget: this.d.maxSteps, rejections: 0, lastSig: null, sameScreen: 0, files: null, outcome: 'ok', note: '' };
    this.setState('running');
    this.d.log('run: ' + text);
    try { await this.loop(gen); }
    catch (e) { if (gen === this.gen) { this.d.log('loop failed: ' + e.message); this.finish('error', 'I could not keep going (' + clip(e.message, 120) + ').'); } }
    return true;
  }

  async loop(gen) {
    const T = this.task;
    for (let step = 0; gen === this.gen && this.active(); step++) {
      if (T.steps >= T.budget) { this.finish('budget', 'That is as far as I got in one go. Say "keep going" to continue.'); return; }
      const screen = await this.d.read();
      if (gen !== this.gen) return;
      // A window with no readable controls (the phantom "Settings" seen at the
      // start of voice tasks) or the bare desktop neither becomes the task's
      // app nor stops it.
      const app = appOf(screen.fg);
      const real = app && !isSwitcher(screen.fg) && !/^program manager$/i.test(String(screen.fg.title || '').trim()) && (screen.elements || []).length > 0;
      if (real) {
        if (!T.apps.size || T.openGrace > 0) T.apps.add(app);
        else if (!T.apps.has(app)) {
          this.d.log('away: "' + clip(screen.fg.title, 60) + '" (' + app + ') came to the front; this task works in ' + Array.from(T.apps).join(', '));
          this.finish('away', 'I stopped: ' + clip(screen.fg.title || app, 50) + ' came to the front, and I did not open it. Say "keep going" to carry on there.');
          return;
        }
      }
      if (T.openGrace > 0) T.openGrace--;
      const sig = (screen.fg ? (screen.fg.title || '') + '|' : '') + settleSignature(screen.elements);
      T.sameScreen = sig === T.lastSig ? T.sameScreen + 1 : 0;
      T.lastSig = sig;
      let note = T.note; T.note = '';
      if (T.sameScreen >= 2) note = (note ? note + ' ' : '') + 'Nothing on screen has changed for two steps: do something genuinely different, or stop and say what is in the way.';
      const llm = this.d.llm();
      if (!llm || !llm.ready) { this.finish('error', 'No AI is set up, so I cannot do that. Add a key or sign in to Claude Code in Settings.'); return; }
      const prompt = userTurn({ goal: T.goal, request: T.request, window: screen.fg ? { title: screen.fg.title, process: screen.fg.process } : null, elements: screen.elements, history: T.history, note, memory: this.d.memoryBlock() });
      const rs = new AgentStream();
      let said = 0;
      const onDelta = (piece) => { if (gen !== this.gen) return; for (const s of rs.feed(piece)) this.d.speak(s, said++ === 0); };
      const t0 = this.d.now();
      let raw;
      const ac = typeof AbortController === 'function' ? new AbortController() : null;
      this.abort = ac;
      try { raw = await withTimeout(llm.complete({ system: SYSTEM, turns: [{ role: 'user', text: prompt }], imageDataUrl: screen.cap ? screen.cap.dataUrl : undefined, json: false, maxTokens: 700, onDelta, signal: ac ? ac.signal : undefined }), MODEL_TIMEOUT_MS, 'model'); }
      catch (e) { if (gen !== this.gen) return; this.d.log('model failed: ' + clip(e.message, 400)); this.finish('error', plainAskError(llm && llm.provider, e)); return; }
      finally { if (this.abort === ac) this.abort = null; }
      if (gen !== this.gen) return;
      for (const s of rs.end()) this.d.speak(s, said++ === 0);
      // A provider that did not stream hands the whole reply back at once:
      // read it through a fresh stream so it is spoken and parsed the same way.
      let reply = rs;
      if (!rs.raw && typeof raw === 'string' && raw) {
        reply = new AgentStream();
        for (const s of reply.feed(raw).concat(reply.end())) this.d.speak(s, said++ === 0);
      }
      const tags = reply.tags();
      const prose = reply.prose() || clip(String(raw || '').replace(/\[[^\]]*\]/g, ''), 200);
      const modelMs = this.d.now() - t0;
      this.d.log('step ' + (T.steps + 1) + ' model ' + modelMs + ' ms, window "' + clip(screen.fg && screen.fg.title, 60) + '", ' + screen.elements.length + ' controls: ' + clip(String(raw || reply.raw || ''), 300));
      if (tags.goal && T.history.length === 0) T.goal = tags.goal;
      if (tags.muted) this.d.log('model wrote tool markup as text; the rest of that reply was dropped');
      if (tags.emptyType) { this.d.log('model sent an empty type; dropped'); T.note = 'You sent [DO:type] with no text. Never do that: if you do not know what the user wants typed, ask them in one sentence, with no action.'; }

      // Carry out the actions in order; a card or a failure ends the chain.
      const ctx = { elements: screen.elements, cap: screen.cap, originPhys: screen.originPhys, fg: screen.fg, files: T.files, browser: T.browser || null, target: T.target || null };
      const results = [];
      let halted = false, changed = null;
      for (const action of tags.actions) {
        if (gen !== this.gen) return;
        const key = action.name + ' ' + JSON.stringify(action.args || {});
        const n = (T.repeats.get(key) || 0) + 1; T.repeats.set(key, n);
        if (n >= REPEAT_LIMIT) { results.push({ action: action.name, ok: false, report: 'that is the same action for the third time; it is not working, try another way or stop' }); halted = true; break; }
        // An action that already failed once is not tried again as it was
        // (live 2026-10-22: the same text click failed four times, 8 s, before
        // the model used x,y). The second ask gets the hint and no click.
        if (T.failed && T.failed.has(key)) { results.push({ action: action.name, ok: false, report: 'that exact action already failed; do it another way (x and y from the screenshot, a different control, or keys) or stop' }); halted = true; break; }
        const card = this.cardFor(action, ctx);
        if (card) {
          const answered = await this.askFirst(card, action, gen);
          if (gen !== this.gen) return;
          if (!answered) { T.outcome = 'declined'; this.finish('declined', 'Okay, not doing that.'); return; }
        }
        const r = await this.d.actions.run(action.name, action.args, ctx);
        if (gen !== this.gen) return;
        if (ctx.files) T.files = ctx.files;
        if (ctx.browser) T.browser = ctx.browser;
        if (ctx.target) T.target = ctx.target;
        if (r.ok && OPENERS.has(action.name)) T.openGrace = OPEN_GRACE_READS;
        results.push({ action: action.name, ok: Boolean(r.ok), report: r.report || (r.ok ? 'done' : 'failed'), unverified: Boolean(r.unverified) });
        this.d.log('do ' + action.name + ' ' + JSON.stringify(action.args || {}).slice(0, 120) + ' -> ' + (r.ok ? 'ok' : 'FAILED') + ': ' + (r.report || ''));
        // Not a step to work around: the person asked to stay off this. The run ends on the line.
        if (r.guarded) { T.history.push({ prose, results, modelMs }); this.finish('guarded', r.report); return; }
        if (!r.ok) { (T.failed || (T.failed = new Set())).add(key); halted = true; break; }
        if (!r.noLook) changed = await this.settle(r, screen, gen);
        if (gen !== this.gen) return;
      }
      T.history.push({ prose, results, modelMs });
      T.steps++;
      T.spoke = said > 0;
      if (this.d.ledger) { try { this.d.ledger.record({ feature: 'hands', provider: llm.provider || '', outcome: results.every((x) => x.ok) ? 'ok' : 'step-failed', ms: this.d.now() - t0, timings: { model_done: modelMs, first_speech: said ? 1 : null }, warm: typeof llm.warmHint === 'function' ? llm.warmHint() === true : undefined, note: clip(T.goal, 80) }); } catch (_) { /* never breaks a step */ } }

      // A clearly progressing task earns a few more steps, once.
      if (T.steps === T.budget - 2 && results.length && results.every((x) => x.ok) && T.budget < MAX_STEPS + EXTRA_STEPS) T.budget += 5;

      if (tags.done && !halted) {
        // Believe "done" only when the last action reported fine and, after a click, the screen moved.
        const lastRes = results.length ? results[results.length - 1] : null;
        const lastClick = lastRes && ['click', 'press', 'type'].includes(lastRes.action);
        if (lastClick && changed === false && T.rejections < DONE_REJECTIONS) { T.rejections++; T.note = 'You said done, but the screen did not change after that step. Check it actually worked.'; continue; }
        // A paste the field could not confirm (live 2026-10-13: an empty YouTube
        // search box was called done): look once more before believing it.
        if (lastRes && lastRes.action === 'type' && lastRes.unverified && T.rejections < DONE_REJECTIONS) { T.rejections++; T.note = 'You said done, but the text you typed could not be confirmed in the box. Look at the screen: if it is not there, type it again or use the site\'s search address.'; continue; }
        // Already said aloud as it streamed: the closing bubble shows it, quietly.
        this.finish('ok', prose || 'Done.', { quiet: T.spoke });
        return;
      }
      if (!tags.actions.length) {
        // No action and no done: the model stopped to ask or to explain. That ends the task with its words.
        this.finish(halted ? 'stuck' : 'asked', prose || 'I need something from you before I can go on.', { quiet: T.spoke && !halted });
        return;
      }
    }
  }

  cardFor(action, ctx) {
    let targetName = '', fieldName = '', toName = '', fileName = '';
    try {
      // A type step names its box with text_target (its text is the words to
      // type); a click names it with text. Same lookup the action itself uses.
      if (action.name === 'click') { const el = this.d.actions.findElement ? this.d.actions.findElement({ id: action.args.id, text: action.args.text, near: action.args.near }, ctx.elements) : null; if (el) { targetName = el.name || ''; fieldName = el.name || ''; } }
      if (action.name === 'type') { const el = this.d.actions.findElement ? this.d.actions.findElement({ id: action.args.id, text: action.args.text_target, near: action.args.near }, ctx.elements) : null; if (el) { targetName = el.name || ''; fieldName = el.name || ''; } }
      if (action.name === 'drag') { const el = this.d.actions.findElement ? this.d.actions.findElement({ id: action.args.to_id, text: action.args.to_text }, ctx.elements) : null; if (el) toName = el.name || ''; }
      if (action.name === 'open_file') { const hit = ctx.files && ctx.files[Number(action.args.index) - 1]; if (hit) fileName = hit.name || ''; }
    } catch (_) { /* a name is a courtesy */ }
    return this.d.consent.preview(action, { targetName, fieldName, toName, fileName, windowTitle: ctx.fg ? ctx.fg.title : '', nearby: '' });
  }

  // The card by the Knot: Yes or Not now, or a spoken answer. Resolves true on yes.
  async askFirst(card, action, gen) {
    const T = this.task;
    this.setState('asking');
    const spoken = card.title + (card.detail ? ' ' + card.detail : '') + (card.firm ? ' Press Yes to go ahead.' : ' Say yes to go ahead.');
    this.d.send('guide:bubble', { text: card.title, hint: card.detail || '', kicker: 'ask first', anchor: 'knot', task: 'hands', actions: [{ id: 'hands-yes', label: 'Yes', primary: true }, { id: 'hands-no', label: 'Not now' }], sessionId: this.bubbleId(), speak: T.source === 'voice' ? spoken : undefined });
    const ans = await this.d.consent.pending.ask(card, action, {});
    if (gen !== this.gen) return false;
    this.setState('running');
    if (!ans.answered) { this.d.log('card ' + (ans.reason || 'unanswered')); return false; }
    this.d.log('card answered ' + (ans.yes ? 'yes' : 'no') + ' (' + ans.how + ')');
    return ans.yes;
  }

  // After an action: wait for the screen to move and hold still (watcher), up to
  // the action's own cap. A screen that has not moved at all by `giveUp` is not
  // going to (live 2026-10-11: clicks and page opens sat out their whole 4 to
  // 5 s cap on a screen that never changed). -> true (moved), false (did not),
  // null (no watcher).
  async settle(r, screen, gen) {
    const ms = Math.max(300, Number(r.settle) || 1500);
    const giveUpMs = Math.min(ms, Math.max(300, Number(r.giveUp) || Math.min(ms, 1200)));
    if (r.lookAfter) await this.d.sleep(r.lookAfter);
    if (!this.d.watcher) { await this.d.sleep(Math.min(ms, 800)); return null; }
    const baseline = this.d.fingerprint && screen.cap ? this.d.fingerprint(screen.cap) : null;
    try { const out = await this.d.watcher.waitForChange(ms, baseline, () => gen !== this.gen, { giveUpMs }); return Boolean(out.changed); }
    catch (_) { return null; }
  }

  finish(outcome, text, opts = {}) {
    const T = this.task;
    if (!T) return;
    T.outcome = outcome;
    this.d.retract();
    if (text) this.d.send('guide:bubble', { text, anchor: 'knot', task: 'hands', kicker: outcome === 'ok' ? 'done' : outcome === 'declined' || outcome === 'away' || outcome === 'guarded' ? 'stopped' : '', kind: outcome === 'error' ? 'error' : '', actions: [{ id: 'dismiss', label: 'OK' }], sessionId: this.bubbleId(), speak: T.source === 'voice' && !opts.quiet ? text : undefined });
    this.d.log('finish ' + outcome + ' after ' + T.history.length + ' steps: ' + clip(text, 80));
    this.gen++;
    this.state = 'idle';
    this.last = { goal: T.goal, request: T.request, source: T.source, outcome, steps: T.history.length, history: T.history.slice(-HISTORY_CARRY), endedAt: this.d.now() };
    this.task = null;
    this.d.send('guide:state', { state: 'idle', task: 'hands' });
    try { this.d.onActive(false); } catch (_) { /* a hook never breaks the loop */ }
  }
}

module.exports = { HandsAgent, isSwitcher, MAX_STEPS, EXTRA_STEPS, REPEAT_LIMIT, DONE_REJECTIONS, RESUME_WINDOW_MS };
