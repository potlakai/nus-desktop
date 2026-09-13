// The guide session: one ask, one thread at a time. Main owns this state
// machine; the renderer only draws what it is told.
//
//   idle -> reading (AMBER, the only state that captures) -> unwinding ->
//   pointing -> [click on the target, or Next] -> reading -> ... -> done
//   any active state + dismiss -> winding -> idle
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
//   selfPid, log, sleep, now, onKeep(record)
'use strict';

const { buildPointRequest, parsePointReply, validatePoint } = require('./pointing');
const { sensitiveTarget } = require('./sensitive');
const { randomUUID } = require('crypto');
const { normRectFromPhys, physRectFromNorm, physRectToWindow, reconcile, screenChanged, clickHits } = require('./verify');

const MAX_STEPS = 12;
const MODEL_TIMEOUT_MS = 75000;   // Claude Code cold start + an image read can take a while
const SETTLE_MS = 450;          // let the app react to a click before re-reading
const EXPLAIN_MS = 10000;       // an explanation bubble goes away on its own
const VK_ESCAPE = 27;
const FOREGROUND_MEMORY_MS = 15000;
const REPLAY_FIND_RETRY_MS = 500; // Chromium wakes its accessibility tree on the first UIA query (2026-09-10) // the app the user was just in still counts while the Knot has focus

function withTimeout(promise, ms, label, onTimeout = () => {}) {
  let t;
  const timeout = new Promise((_, reject) => { t = setTimeout(() => { onTimeout(); reject(new Error(label + ' timed out')); }, ms); if (t.unref) t.unref(); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

class GuideSession {
  constructor(deps) {
    this.d = Object.defineProperties({ log: () => {}, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: () => Date.now(), selfPid: -1, onKeep: () => {} }, Object.getOwnPropertyDescriptors(deps));
    this.state = 'idle';
    this.gen = 0;               // bumps on every dismiss; stale async work checks it
    this.session = null;        // { id, task, source, startedAt, app, steps:[], target, hashes, unchanged }
    this.explainTimer = null;
    this.finishTimer = null;
    this.keepTimer = null;
    this.lastRecord = null;
  }

  status() {
    return { state: this.state, sessionId: this.session ? this.session.id : null, task: this.session ? this.session.task : null, steps: this.session ? this.session.steps.length : 0 };
  }

  pause() {
    if (!this.session) return;
    this.gen++;
    this.modelAbort?.abort();
    this.clearExplain(); clearTimeout(this.finishTimer); this.finishTimer = null;
    this.stopWatch();
    this.setState('paused');
    this.showPaused();
  }
  // The paused bubble again, for when something else (a selection answer,
  // Escape on it) hid it: a paused walkthrough must never be invisible.
  showPaused() {
    if (!this.session || this.state !== 'paused') return false;
    this.d.send('guide:state', { state: 'paused', task: 'guide', sessionId: this.session.id });
    this.d.send('guide:bubble', { text: 'Paused. Your goal and steps are kept for this session.', sessionId: this.session.id, anchor: 'knot', task: 'ask', actions: [{ id: 'resume', label: 'Resume' }, { id: 'dismiss', label: 'End task' }] });
    return true;
  }

  async followUp(text) {
    const s = this.session;
    if (!s) return this.start(text, 'typed');
    if (!['paused', 'pointing', 'explaining'].includes(this.state)) { this.d.send('status', { message: 'Finishing this step. Pause or wait a moment.' }); return false; }
    if (/^(pause|wait|hold on)\b/i.test(text)) { this.pause(); return true; }
    const gen = ++this.gen;
    this.modelAbort?.abort();
    this.modelAbort = new AbortController();
    this.clearExplain(); this.stopWatch();
    s.unresolved = String(text).slice(0, 1000);
    if (/continue|resume|refresh|didn.t work|not work/i.test(text)) {
      s.replay = null;
      // Measured 2026-09-10: passing the user's words as the "last step" hint
      // made the model treat "that did not work" as the goal. Keep the real
      // last step as the hint and say what the user reported about it.
      const failed = /didn.t work|not work/i.test(text);
      return this.readAndPoint(gen, 'followup', { instruction: s.target && s.target.instruction ? s.target.instruction : '', target: s.target, failed: failed ? s.unresolved : '' });
    }
    this.setState('thinking');
    try {
      const context = this.d.context ? this.d.context(s) : '';
      const controller = this.modelAbort;
      // Plain words, not a JSON blob: the model kept answering "that is a
      // general question" when the step arrived as structured fields.
      const done = (s.steps || []).map((st, i) => (i + 1) + '. ' + st.instruction).join('\n');
      const current = s.target && s.target.instruction ? s.target.instruction : '';
      const brief = [
        'You are guiding the user through this goal on their screen: "' + s.task + '".',
        current ? 'The step currently on their screen is: "' + current + '"' + (s.target && s.target.name ? ' (the control is "' + s.target.name + '")' : '') + '. They have not done it yet.' : 'No step is on their screen yet.',
        done ? 'Steps they already completed:\n' + done : '',
        s.lastAnswer ? 'Your last answer: ' + String(s.lastAnswer).slice(0, 300) : '',
        'The user now asks, about that step: "' + s.unresolved + '"',
        'Answer that question. If it is "why", say why "' + (current || 'the next step') + '" moves them toward "' + s.task + '". If it is "simpler", say the same step in plainer words. Do not advance the task and do not say you looked at the screen again. Plain words, 1 to 3 sentences, no lists.',
        'Return JSON: {"instruction": "<your answer>"}',
      ].filter(Boolean).join('\n');
      const raw = await withTimeout(this.llm().complete({ system: 'You are Nūs, a quiet on-screen guide answering a question mid-walkthrough.' + context, turns: [{ role: 'user', text: brief }], json: true, maxTokens: 400, signal: controller.signal }), MODEL_TIMEOUT_MS, 'follow-up', () => controller.abort());
      if (gen !== this.gen) return false;
      const parsed = typeof raw === 'string' ? JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, '')) : raw;
      this.explain(String(parsed.instruction || 'Please ask that another way.').slice(0, 1500));
      return true;
    } catch (_) {
      if (gen === this.gen) this.explain('I could not answer that follow-up. Your place is kept; try again or Resume.');
      return false;
    }
  }

  active() { return this.state !== 'idle'; }

  setState(state) {
    if (this.state === state) return;
    this.state = state;
    if (['reading', 'unwinding', 'explaining'].includes(state)) this.startWatch([], false);
    this.d.send('guide:state', { state, task: 'guide', sessionId: this.session ? this.session.id : null });
  }

  // ---- entry points -------------------------------------------------------
  // The model for this session. A walkthrough started from a selected area is
  // pinned to Claude for its whole life (opts.providerLock 'anthropic'); an
  // ordinary ask keeps the Companion's provider preference.
  llm() {
    const lock = this.session && this.session.providerLock;
    return lock && this.d.llmFor ? this.d.llmFor(lock) : this.d.llm();
  }

  async start(text, source, opts = {}) {
    const task = String(text || '').trim();
    if (!task) return false;
    if (this.active()) { this.d.log('busy, ignoring ask'); this.d.send('status', { message: 'Still on the last one. Esc winds it back.' }); return false; }
    const gen = ++this.gen;
    this.skip();
    this.session = { id: 'g' + randomUUID(), task, source: source || 'typed', startedAt: this.d.now(), app: null, steps: [], target: null, hashes: null, unchanged: 0, replay: null, providerLock: opts.providerLock || null, prior: String(opts.prior || '').slice(0, 600) };
    this.d.log('guide session started' + (opts.providerLock ? ' (provider locked to ' + opts.providerLock + ')' : ''));
    await this.begin(gen);
    return true;
  }

  // A kept walkthrough for this app and ask replays without a model call;
  // anything else goes to the live loop.
  async begin(gen) {
    const s = this.session;
    if (!s || gen !== this.gen) return;
    this.setState('reading');
    const fg = await this.foreground();
    if (gen !== this.gen) return;
    s.app = fg ? { title: fg.title || '', process: fg.process || '', hwnd: fg.hwnd } : null;
    const wt = fg && this.d.walkthroughs ? this.d.walkthroughs.find({ process: fg.process, title: fg.title, task: s.task }) : null;
    if (wt && wt.steps && wt.steps.length) {
      s.replay = { key: wt.key, steps: wt.steps, index: 0 };
      this.d.log('replay: ' + wt.key + ' (' + wt.steps.length + ' steps)');
      await this.replayStep(gen);
      return;
    }
    await this.readAndPoint(gen);
  }

  async foreground() {
    const probe = this.d.probe && this.d.probe.available ? this.d.probe : null;
    if (!probe) return null;
    let fg = null;
    // Our own window is never "the app": the probe walks past it.
    try { fg = await probe.request('fg', { ignorePid: this.d.selfPid }, 2500); } catch (e) { this.d.log('fg failed: ' + e.message); }
    if (fg && fg.pid === this.d.selfPid) fg = null;
    if (fg && fg.hwnd) { this.lastFg = { fg, at: this.d.now() }; return fg; }
    // Measured 2026-09-10: typing at the Knot gives the Companion focus, so the
    // probe sees no other app in front and a kept walkthrough missed its first
    // step. The app the user was just in (seen within the last 15s) is the app
    // they mean.
    if (this.lastFg && this.d.now() - this.lastFg.at < FOREGROUND_MEMORY_MS) return this.lastFg.fg;
    // Before a session exists, main keeps the last real foreground it saw
    // while polling the cursor (deps.lastForeground -> { fg, at } or null).
    const remembered = typeof this.d.lastForeground === 'function' ? this.d.lastForeground() : null;
    if (remembered && remembered.fg && remembered.fg.hwnd && this.d.now() - remembered.at < FOREGROUND_MEMORY_MS) return remembered.fg;
    return null;
  }

  // One saved step: resolve the control by name through UI Automation. A
  // miss hands this step (and the rest of the session) to the live loop,
  // with the saved step as a hint, and counts against the walkthrough.
  async replayStep(gen) {
    const s = this.session;
    if (!s || !s.replay || gen !== this.gen) return;
    const probe = this.d.probe && this.d.probe.available ? this.d.probe : null;
    const saved = s.replay.steps[s.replay.index];
    if (!saved || !saved.target || !saved.target.name || !probe) { await this.replayMiss(gen, saved, !probe ? 'probe unavailable' : 'saved step has no control name'); return; }
    this.setState('reading');
    const fg = await this.foreground();
    if (gen !== this.gen) return;
    if (s.app && (!fg || fg.process !== s.app.process || fg.title !== s.app.title)) {
      s.replay = null; this.explain('The app or page changed. Resume to read the current screen instead of using saved steps.'); return;
    }
    if (fg) s.app = { title: fg.title || '', process: fg.process || '', hwnd: fg.hwnd };
    let found = null, why = 'no app in front';
    if (fg) {
      // Measured 2026-09-10: Chromium-rendered apps (Electron, Chrome, Teams)
      // expose only their native frame to the first UI Automation walk; the
      // page's controls appear a moment after that first query wakes the
      // accessibility tree. One retry after a short pause covers it.
      for (let attempt = 0; attempt < 2 && !found; attempt++) {
        if (attempt) { await this.d.sleep(REPLAY_FIND_RETRY_MS); if (gen !== this.gen) return; }
        try {
          const r = await probe.request('uia.find', { hwnd: fg.hwnd, name: saved.target.name, type: saved.target.type || '' }, 3000);
          if (r && r.element && r.element.rect && Number(r.score) >= 60) { found = r.element; if (attempt) this.d.log('replay find: matched on retry'); }
          else why = 'find score ' + (r ? Number(r.score) || 0 : 0) + (r && r.element && r.element.name ? ' (' + r.element.name + ')' : '') + ', searched ' + (r ? Number(r.searched) || 0 : 0) + (r && r.truncated ? ' (truncated)' : '') + ' in "' + (fg.title || '') + '" hwnd ' + fg.hwnd + (attempt ? ' (after retry)' : '');
        } catch (e) { why = 'find failed: ' + e.message; this.d.log('replay find failed: ' + e.message); }
      }
    }
    if (gen !== this.gen) return;
    if (!found) { await this.replayMiss(gen, saved, why); return; }
    if (sensitiveTarget(found) || sensitiveTarget(saved.target)) { this.explain('Enter sensitive details yourself. I will not point at that field.'); return; }
    s.target = { rect: found.rect, name: found.name || saved.target.name, type: found.type || saved.target.type, automationId: found.automationId || '', instruction: saved.instruction, note: '', verified: true, source: 'replay', modelMs: 0 };
    s.hashes = null;
    this.pointAt(s.target, gen, { replay: true });
  }

  replayMiss(gen, saved, why) {
    const s = this.session;
    if (!s || !s.replay) return;
    const stale = this.d.walkthroughs && this.d.walkthroughs.miss ? this.d.walkthroughs.miss(s.replay.key) : false;
    this.d.log('replay miss on step ' + (s.replay.index + 1) + (why ? ': ' + why : '') + (stale ? ' (walkthrough retired)' : ''));
    s.replay = null;
    return this.readAndPoint(gen, 'miss', saved || null);
  }

  dismiss(reason) {
    this.skip();
    clearTimeout(this.finishTimer); this.finishTimer = null;
    if (!this.active()) return;
    this.d.log('dismiss: ' + reason);
    this.gen++;
    this.modelAbort?.abort();
    this.clearExplain();
    this.stopWatch();
    this.setState('winding');
    this.d.send('guide:done', { sessionId: this.session ? this.session.id : null, offerKeep: false });
    this.state = 'idle';
    this.session = null;
  }

  onArrived() {
    if (this.state !== 'unwinding') return;
    this.setState('pointing');
    this.startWatch();
  }

  onClick(point) {
    if (this.state !== 'pointing' || !this.session || !this.session.target) return;
    if (!clickHits(point, this.session.target.rect)) return;
    this.d.log('click on target');
    return this.advance('click');
  }

  onKey(vk, down) {
    if (vk === VK_ESCAPE && down && this.active()) this.dismiss('esc');
  }

  onAction(id) {
    if (id === 'complete' && this.session && this.session.pendingCompletion != null) {
      this.session.confirmed = true;
      return this.finish(this.session.pendingCompletion);
    }
    if (id === 'pause') return this.pause();
    if (id === 'resume' || id === 'refresh') return this.followUp('Resume and refresh the screen');
    if (id === 'why') return this.followUp('Why is this the next step?');
    if (id === 'next') return ['pointing', 'unwinding'].includes(this.state) ? this.advance('next') : undefined;
    if (id === 'dismiss' || id === 'notnow') this.dismiss(id);
    return undefined;
  }

  // Keep = remember: the walkthrough is saved for replay and the summary
  // goes to the desktop. Skip = forget both.
  keep(sessionId) {
    const s = this.lastRecord;
    if (!s || (sessionId && s.id !== sessionId)) return { ok: false, error: 'This session is no longer available.' };
    try {
      if (this.d.walkthroughs && this.d.walkthroughs.record && !this.d.walkthroughs.record(s)) throw new Error('Walkthrough could not be saved');
      if (this.d.onKeep(s) === false) throw new Error('Summary could not be saved');
      this.skip();
      return { ok: true };
    } catch (e) { this.d.log('keep failed: ' + e.message); return { ok: false, error: 'Could not save. Try again or Skip.' }; }
  }

  skip(sessionId) { if (sessionId && this.lastRecord && this.lastRecord.id !== sessionId) return; clearTimeout(this.keepTimer); this.keepTimer = null; this.lastRecord = null; }

  // ---- the loop -----------------------------------------------------------
  async advance(how) {
    const s = this.session;
    if (!s) return;
    const gen = this.gen;
    this.stopWatch();
    const t = s.target || {};
    s.steps.push({ instruction: t.instruction || '', name: t.name || '', type: t.type || '', automationId: t.automationId || '', boxNorm: t.boxNorm || null, outcome: how === 'click' ? 'clicked' : 'moved on' });
    this.setState('reading');
    await this.d.sleep(SETTLE_MS);
    if (gen !== this.gen) return;
    if (s.steps.length >= MAX_STEPS) { this.pause(); return; }
    if (s.replay) {
      s.replay.index += 1;
      if (s.replay.index >= s.replay.steps.length) { this.finish('Done, same as last time.'); return; }
      await this.replayStep(gen);
      return;
    }
    await this.readAndPoint(gen, how);
  }

  async readAndPoint(gen, how, hint) {
    const s = this.session;
    if (!s || gen !== this.gen) return;
    this.setState('reading');
    const probe = this.d.probe && this.d.probe.available ? this.d.probe : null;

    // The front window. Our own window means the user is talking to the
    // Knot, not to an app.
    const fg = await this.foreground();
    if (gen !== this.gen) return;
    s.app = fg ? { title: fg.title || '', process: fg.process || '', hwnd: fg.hwnd } : null;

    // One capture, downscaled.
    let cap = null;
    try { cap = await this.d.capture(); } catch (e) { this.d.log('capture failed: ' + e.message); }
    if (gen !== this.gen) return;
    if (!cap || !cap.dataUrl) { this.explain('I could not read the screen. Check screen capture permissions for Nūs and try again.'); return; }
    const originPhys = this.d.dipToScreen({ x: cap.display.bounds.x, y: cap.display.bounds.y });

    // Did the last click change anything? Same screen twice = say so.
    if (how === 'click' && s.hashes) {
      const next = this.safeHash(cap, s.target ? s.target.rect : null);
      if (next && !screenChanged(s.hashes, next)) {
        s.unchanged += 1;
        if (s.unchanged >= 2) { this.explain('That did not seem to take. Try the click once more, or tell me what you see.'); return; }
        // Point at the same control again rather than burning a model call.
        s.hashes = next;
        this.pointAt(s.target, gen, { again: true });
        return;
      }
      s.unchanged = 0;
    }

    // The controls Windows knows about in the front window.
    let elements = [];
    if (probe && fg && fg.hwnd) {
      try {
        const r = await probe.request('uia.list', { hwnd: fg.hwnd, max: 150, budgetMs: 1200 }, 3000);
        elements = (r.elements || []).filter((e) => e.rect).map((e) => ({ id: e.id, name: e.name, type: e.type, isPassword: e.isPassword, automationId: e.automationId, rect: e.rect, box: (() => { const n = normRectFromPhys(e.rect, cap, originPhys); return [n.x, n.y, n.w, n.h]; })() }));
      } catch (e) { this.d.log('uia.list failed: ' + e.message); }
    }
    if (gen !== this.gen) return;

    // The model.
    const llm = this.llm();
    if (!llm || !llm.ready) { this.explain('Add your ' + (llm && llm.provider ? llm.provider : 'AI') + ' key in Settings (the gear in the sheet) and I can guide you.'); return; }
    const req = buildPointRequest({ task: s.task, history: s.steps, window: s.app || { title: '(no app in front)', process: '' }, elements, hint: hint || null, prior: s.prior || '' });
    if (this.d.context) req.system += this.d.context(s);
    this.setState('thinking');
    let raw = null;
    const t0 = this.d.now();
    this.modelAbort?.abort();
    const controller = this.modelAbort = new AbortController();
    try {
      raw = await withTimeout(llm.complete({ system: req.system, turns: [{ role: 'user', text: req.text }], imageDataUrl: cap.dataUrl, json: true, maxTokens: 400, signal: controller.signal }), MODEL_TIMEOUT_MS, 'model', () => controller.abort());
    } catch (e) {
      this.d.log('model failed: ' + e.message);
      if (gen !== this.gen) return;
      this.explain('I could not reach the model (' + (e.message || 'error').slice(0, 80) + ').');
      return;
    }
    if (gen !== this.gen) return;
    if (probe) {
      const live = await this.foreground();
      if (gen !== this.gen) return;
      if (!fg || !live || live.hwnd !== fg.hwnd || live.title !== fg.title) { this.explain('The app changed while I was reading. Ask again on the screen you want help with.'); return; }
    }
    const modelMs = this.d.now() - t0;
    const parsed = parsePointReply(raw);
    const v = validatePoint(parsed, elements, { verified: !!probe });
    this.d.log(`model ${modelMs}ms: ${v.ok ? 'ok' : 'rejected'} (${v.reason})` + (parsed && parsed.target ? ' target=' + JSON.stringify(parsed.target) : ''));
    if (!v.ok || !v.reply) { this.explain('I could not work out the next step from this screen. Tell me a little more, or open the app first.'); return; }
    const reply = v.reply;
    if (reply.done) { this.finish(reply.instruction); return; }
    if (!reply.target) { this.explain(reply.instruction + (reply.note ? ' ' + reply.note : '')); return; }

    if (!probe) { this.explain('I can explain the next step, but verified screen pointing is unavailable on this device. ' + reply.instruction); return; }

    // Reconcile with Windows before anything moves.
    let bboxPhys = null, fromPoint = null, found = null;
    if (reply.target.kind === 'bbox') {
      bboxPhys = physRectFromNorm(reply.target, cap, originPhys);
      if (probe) {
        const cx = bboxPhys.x + bboxPhys.w / 2, cy = bboxPhys.y + bboxPhys.h / 2;
        try { const r = await probe.request('uia.frompoint', { x: cx, y: cy, ignorePid: this.d.selfPid }, 2500); fromPoint = r && r.element; } catch (_) { /* fine */ }
        if (reply.target.label && fg && fg.hwnd) {
          try { const r = await probe.request('uia.find', { hwnd: fg.hwnd, name: reply.target.label }, 3000); found = r && r.element; } catch (_) { /* fine */ }
        }
      }
    }
    if (gen !== this.gen) return;
    let hit = reconcile({ target: reply.target, elements, bboxPhys, fromPoint, found, verified: !!probe });
    if (hit && reply.target.kind === 'element') {
      let live = null;
      try { const r = await probe.request('uia.frompoint', { x: hit.rect.x + hit.rect.w / 2, y: hit.rect.y + hit.rect.h / 2, ignorePid: this.d.selfPid }, 2500); live = r && r.element; } catch (_) {}
      if (gen !== this.gen) return;
      const checked = reconcile({ target: { kind: 'bbox', label: hit.name }, bboxPhys: hit.rect, fromPoint: live });
      hit = checked ? { ...hit, rect: checked.rect } : null;
    }
    if (!hit) {
      this.d.log('reconcile failed for ' + JSON.stringify(reply.target));
      this.explain('I think the next step is: ' + reply.instruction + ' But I could not find that control for sure, so I will not point at it.');
      return;
    }
    const chosen = reply.target.kind === 'element' ? elements.find((e) => Number(e.id) === Number(reply.target.id)) : null;
    const boxNorm = normRectFromPhys(hit.rect, cap, originPhys);
    s.target = { rect: hit.rect, name: hit.name, type: hit.type, automationId: (chosen && chosen.automationId) || (fromPoint && fromPoint.automationId) || '', boxNorm, instruction: reply.instruction, note: reply.note, verified: hit.verified, source: hit.source, modelMs };
    s.hashes = this.safeHash(cap, hit.rect);
    this.pointAt(s.target, gen, {});
  }

  pointAt(target, gen, opts) {
    const s = this.session;
    if (!s || gen !== this.gen) return;
    const bbox = physRectToWindow(target.rect, this.d.winBounds(), this.d.screenToDip);
    const bounds = this.d.winBounds();
    const cx = bbox.x + bbox.w / 2, cy = bbox.y + bbox.h / 2;
    if (![bbox.x, bbox.y, bbox.w, bbox.h].every(Number.isFinite) || cx < 0 || cy < 0 || cx > bounds.width || cy > bounds.height) { this.explain('That control is outside the Knot display. Move the app onto this display and ask again.'); return; }
    const step = s.steps.length + 1;
    this.setState('unwinding');
    this.d.send('guide:target', {
      bbox,
      task: 'guide',
      step,
      kicker: opts.again ? 'step ' + step + ' · again' : opts.replay ? 'step ' + step + ' · from last time' : 'step ' + step,
      instruction: target.instruction,
      hint: opts.replay
        ? 'Same as last time. Click it and I will keep going. Or press Next.'
        : (target.note ? target.note + ' ' : '') + (target.verified ? 'Click it and I will re-read the screen.' : 'Unverified: this box is the model\'s guess.') + ' Or press Next.',
      actions: [{ id: 'next', label: 'Next' }, { id: 'why', label: 'Why?' }, { id: 'pause', label: 'Pause' }, { id: 'refresh', label: 'Refresh screen' }],
      sessionId: s.id,
      generation: gen,
      // One spoken sentence, only when the user asked by voice.
      speak: s.source === 'voice' ? target.instruction : undefined,
    });
  }

  explain(text) {
    const s = this.session;
    if (s) s.lastAnswer = String(text);
    this.stopWatch();
    this.setState('explaining');
    this.d.send('guide:bubble', { text, anchor: 'knot', task: 'ask', actions: [{ id: 'resume', label: 'Resume' }, { id: 'dismiss', label: 'End task' }], sessionId: s ? s.id : null, speak: s && s.source === 'voice' ? text : undefined });
    this.clearExplain();
    // An answer to a question can be a few sentences: give reading time.
    // Reading speed belongs to the person: explanations wait for dismissal.
  }

  finish(closing) {
    const s = this.session;
    if (!s) return;
    if (s.steps.length && !s.confirmed) {
      s.pendingCompletion = closing || 'Done.';
      this.stopWatch(); this.setState('explaining');
      this.d.send('guide:bubble', { text: 'I reached the end of these steps. Did the task finish?', anchor: 'knot', task: 'ask', sessionId: s.id, actions: [{ id: 'complete', label: 'Yes, finished' }, { id: 'refresh', label: 'Not yet' }] });
      return;
    }
    this.stopWatch();
    this.gen++;
    this.lastRecord = { id: s.id, task: s.task, app: s.app, steps: s.steps.slice(), startedAt: s.startedAt, endedAt: this.d.now() };
    this.setState('done');
    this.d.send('guide:bubble', { text: closing || 'Done.', anchor: 'knot', task: 'guide', sessionId: s.id, speak: s.source === 'voice' ? (closing || 'Done.') : undefined });
    const id = s.id;
    const finishGen = this.gen;
    this.finishTimer = setTimeout(() => {
      if (finishGen !== this.gen || this.session !== s) return;
      this.d.send('guide:done', { sessionId: id, summary: s.task, offerKeep: s.steps.length > 0 });
      this.state = 'idle';
      this.session = null;
      this.finishTimer = null;
      this.keepTimer = setTimeout(() => this.skip(id), 12000);
      this.keepTimer.unref?.();
    }, 2400);
  }

  // ---- helpers --------------------------------------------------------------
  safeHash(cap, rect) {
    try { return this.d.hashCapture ? this.d.hashCapture(cap, rect) : null; } catch (e) { this.d.log('hash failed: ' + e.message); return null; }
  }

  startWatch(extraKeys, click = true) {
    const probe = this.d.probe && this.d.probe.available ? this.d.probe : null;
    if (!probe) return;
    const keys = [VK_ESCAPE].concat(Array.isArray(extraKeys) ? extraKeys : []);
    probe.watch({ keys, click, fg: false }).catch((e) => this.d.log('watch failed: ' + e.message));
  }

  stopWatch() {
    const probe = this.d.probe;
    if (probe && probe.unwatch && probe.status && probe.status().watching) probe.unwatch().catch(() => {});
  }

  clearExplain() { if (this.explainTimer) { clearTimeout(this.explainTimer); this.explainTimer = null; } }
}

module.exports = { GuideSession, MAX_STEPS, SETTLE_MS };
