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

const { buildPointRequest, parsePointReply, validatePoint, CONF_SURE } = require('./pointing');
const { normRectFromPhys, physRectFromNorm, physRectToWindow, reconcile, screenChanged, clickHits } = require('./verify');
const { sensitiveTarget } = require('./sensitive');

const MAX_STEPS = 12;
const MODEL_TIMEOUT_MS = 75000;   // Claude Code cold start + an image read can take a while
const SETTLE_MS = 450;          // let the app react to a click before re-reading
const EXPLAIN_MS = 10000;       // an explanation bubble goes away on its own
const VK_ESCAPE = 27;

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
    this.session = null;        // { id, task, source, startedAt, app, steps:[], target, hashes, unchanged }
    this.explainTimer = null;
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
  async start(text, source) {
    const task = String(text || '').trim();
    if (!task) return false;
    if (this.active()) { this.d.log('busy, ignoring ask'); this.d.send('status', { message: 'Still on the last one. Esc winds it back.' }); return false; }
    const gen = ++this.gen;
    this.session = { id: 'g' + this.d.now().toString(36), task, source: source || 'typed', startedAt: this.d.now(), app: null, steps: [], target: null, hashes: null, unchanged: 0, replay: null };
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
    return fg && fg.hwnd ? fg : null;
  }

  // One saved step: resolve the control by name through UI Automation. A
  // miss hands this step (and the rest of the session) to the live loop,
  // with the saved step as a hint, and counts against the walkthrough.
  async replayStep(gen) {
    const s = this.session;
    if (!s || !s.replay || gen !== this.gen) return;
    const probe = this.d.probe && this.d.probe.available ? this.d.probe : null;
    const saved = s.replay.steps[s.replay.index];
    if (!saved || !saved.target || !saved.target.name || !probe) { await this.replayMiss(gen, saved); return; }
    this.setState('reading');
    const fg = await this.foreground();
    if (gen !== this.gen) return;
    if (fg) s.app = { title: fg.title || '', process: fg.process || '', hwnd: fg.hwnd };
    let found = null;
    if (fg) {
      try {
        const r = await probe.request('uia.find', { hwnd: fg.hwnd, name: saved.target.name, type: saved.target.type || '' }, 3000);
        if (r && r.element && r.element.rect && Number(r.score) >= 60) found = r.element;
      } catch (e) { this.d.log('replay find failed: ' + e.message); }
    }
    if (gen !== this.gen) return;
    if (!found) { await this.replayMiss(gen, saved); return; }
    s.target = { rect: found.rect, name: found.name || saved.target.name, type: found.type || saved.target.type, automationId: found.automationId || '', instruction: saved.instruction, note: '', verified: true, source: 'replay', modelMs: 0 };
    s.hashes = null;
    this.pointAt(s.target, gen, { replay: true });
  }

  replayMiss(gen, saved) {
    const s = this.session;
    if (!s || !s.replay) return;
    const stale = this.d.walkthroughs && this.d.walkthroughs.miss ? this.d.walkthroughs.miss(s.replay.key) : false;
    this.d.log('replay miss on step ' + (s.replay.index + 1) + (stale ? ' (walkthrough retired)' : ''));
    s.replay = null;
    return this.readAndPoint(gen, 'miss', saved || null);
  }

  dismiss(reason) {
    if (!this.active()) return;
    this.d.log('dismiss: ' + reason);
    this.gen++;
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
    if (s.steps.length >= MAX_STEPS) { this.finish('That is as far as I go in one session.'); return; }
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
    if (!cap || !cap.dataUrl) { this.explain('I could not read the screen. On Windows, allow screen capture for Nūs and try again.'); return; }
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
        elements = (r.elements || []).filter((e) => e.rect).map((e) => ({ id: e.id, name: e.name, type: e.type, automationId: e.automationId, rect: e.rect, box: (() => { const n = normRectFromPhys(e.rect, cap, originPhys); return [n.x, n.y, n.w, n.h]; })() }));
      } catch (e) { this.d.log('uia.list failed: ' + e.message); }
    }
    if (gen !== this.gen) return;

    // The model.
    const llm = this.d.llm();
    if (!llm || !llm.ready) { this.explain('Add your ' + (llm && llm.provider ? llm.provider : 'AI') + ' key in Settings (the gear in the sheet) and I can guide you.'); return; }
    const req = buildPointRequest({ task: s.task, history: s.steps, window: s.app || { title: '(no app in front)', process: '' }, elements, hint: hint || null });
    let raw = null;
    const t0 = this.d.now();
    try {
      raw = await withTimeout(llm.complete({ system: req.system, turns: [{ role: 'user', text: req.text }], imageDataUrl: cap.dataUrl, json: true, maxTokens: 400 }), MODEL_TIMEOUT_MS, 'model');
    } catch (e) {
      this.d.log('model failed: ' + e.message);
      if (gen !== this.gen) return;
      this.explain('I could not reach the model (' + (e.message || 'error').slice(0, 80) + ').');
      return;
    }
    if (gen !== this.gen) return;
    const modelMs = this.d.now() - t0;
    const parsed = parsePointReply(raw);
    const v = validatePoint(parsed, elements, { verified: !!probe });
    this.d.log(`model ${modelMs}ms: ${v.ok ? 'ok' : 'rejected'} (${v.reason})` + (parsed && parsed.target ? ' target=' + JSON.stringify(parsed.target) : ''));
    if (!v.ok || !v.reply) { this.explain('I could not work out the next step from this screen. Tell me a little more, or open the app first.'); return; }
    const reply = v.reply;
    if (reply.done) { this.finish(reply.instruction); return; }
    if (!reply.target) { this.explain(reply.instruction + (reply.note ? ' ' + reply.note : '')); return; }

    // Reconcile with Windows before anything moves.
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
      }
    }
    if (gen !== this.gen) return;
    const hit = reconcile({ target: reply.target, elements, bboxPhys, fromPoint, found, verified: !!probe });
    if (!hit) {
      this.d.log('reconcile failed for ' + JSON.stringify(reply.target));
      this.explain('I think the next step is: ' + reply.instruction + ' But I could not find that control for sure, so I will not point at it.');
      return;
    }
    const chosen = reply.target.kind === 'element' ? elements.find((e) => Number(e.id) === Number(reply.target.id)) : null;
    // Enforced here, not only in the prompt: never point at a password, card
    // or ID field, whichever way the control was resolved.
    if (sensitiveTarget(chosen) || sensitiveTarget(fromPoint) || sensitiveTarget(found) || sensitiveTarget({ name: hit.name, type: hit.type })) {
      this.d.log('refused: sensitive field ' + JSON.stringify(hit.name || reply.target.label || ''));
      this.explain('That looks like a password or card field. I will not point at it. Fill it in yourself and ask again.');
      return;
    }
    const boxNorm = normRectFromPhys(hit.rect, cap, originPhys);
    // A hedged pick (low model confidence) is pointed at but labelled a best
    // guess, same as a box Windows could not confirm.
    const sure = hit.verified && reply.confidence >= CONF_SURE;
    s.target = { rect: hit.rect, name: hit.name, type: hit.type, automationId: (chosen && chosen.automationId) || (fromPoint && fromPoint.automationId) || '', boxNorm, instruction: reply.instruction, note: reply.note, verified: sure, source: hit.source, modelMs };
    s.hashes = this.safeHash(cap, hit.rect);
    this.pointAt(s.target, gen, {});
  }

  pointAt(target, gen, opts) {
    const s = this.session;
    if (!s || gen !== this.gen) return;
    const bbox = physRectToWindow(target.rect, this.d.winBounds(), this.d.screenToDip);
    const step = s.steps.length + 1;
    this.setState('unwinding');
    this.d.send('guide:target', {
      bbox,
      task: 'guide',
      step,
      kicker: opts.again ? 'step ' + step + ' · again' : opts.replay ? 'step ' + step + ' · from last time' : target.verified ? 'step ' + step : 'step ' + step + ' · best guess',
      instruction: target.instruction,
      hint: opts.replay
        ? 'Same as last time. Click it and I will keep going. Or press Next.'
        : (target.note ? target.note + ' ' : '') + (target.verified ? 'Click it and I will re-read the screen.' : 'Best guess from the screenshot. Click it and I will re-read the screen.') + ' Or press Next.',
      actions: [{ id: 'next', label: 'Next' }],
      sessionId: s.id,
      // One spoken sentence, only when the user asked by voice.
      speak: s.source === 'voice' ? target.instruction : undefined,
    });
  }

  explain(text) {
    const s = this.session;
    this.stopWatch();
    this.setState('explaining');
    this.d.send('guide:bubble', { text, anchor: 'knot', task: 'ask', actions: [{ id: 'dismiss', label: 'OK' }], sessionId: s ? s.id : null, speak: s && s.source === 'voice' ? text : undefined });
    this.clearExplain();
    this.explainTimer = setTimeout(() => { if (this.state === 'explaining') this.dismiss('explain-timeout'); }, EXPLAIN_MS);
    if (this.explainTimer.unref) this.explainTimer.unref();
  }

  finish(closing) {
    const s = this.session;
    if (!s) return;
    this.stopWatch();
    this.gen++;
    this.lastRecord = { id: s.id, task: s.task, app: s.app, steps: s.steps.slice(), startedAt: s.startedAt, endedAt: this.d.now() };
    this.setState('done');
    this.d.send('guide:bubble', { text: closing || 'Done.', anchor: 'knot', task: 'guide', sessionId: s.id, speak: s.source === 'voice' ? (closing || 'Done.') : undefined });
    const id = s.id;
    setTimeout(() => {
      this.d.send('guide:done', { sessionId: id, summary: s.task, offerKeep: s.steps.length > 0 });
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
    if (!probe) return;
    const keys = [VK_ESCAPE].concat(Array.isArray(extraKeys) ? extraKeys : []);
    probe.watch({ keys, click: true, fg: false }).catch((e) => this.d.log('watch failed: ' + e.message));
  }

  stopWatch() {
    const probe = this.d.probe;
    if (probe && probe.unwatch && probe.status && probe.status().watching) probe.unwatch().catch(() => {});
  }

  clearExplain() { if (this.explainTimer) { clearTimeout(this.explainTimer); this.explainTimer = null; } }
}

module.exports = { GuideSession, MAX_STEPS, SETTLE_MS };
