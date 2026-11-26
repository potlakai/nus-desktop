// The guide loop's speed work: timing, one front-window lookup per step, the
// prefetched first read, and the quick pointer in shadow and live modes. The
// model here is a promise the test resolves, so the order of "Jev answered",
// "the person clicked" and "the model answered" is under control.
const test = require('node:test');
const assert = require('node:assert/strict');
const { GuideSession } = require('../src/guide/session');
const { createSnapshotter } = require('../src/guide/snapshot');
const { createWalkthroughs } = require('../src/guide/walkthroughs');

const CAP = { dataUrl: 'data:image/png;base64,AAAA', width: 1280, height: 720, pxWidth: 1920, pxHeight: 1080, display: { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 } };
const ELEMENTS = [
  { id: 1, name: 'Assignments', type: 'Hyperlink', rect: { x: 100, y: 200, w: 120, h: 24 } },
  { id: 2, name: 'Submit Assignment', type: 'Button', rect: { x: 1500, y: 900, w: 160, h: 40 } },
];
const FG = { hwnd: 77, title: 'Canvas - Chrome', process: 'chrome', pid: 500 };
const POINT1 = { instruction: 'Click Assignments', target: { kind: 'element', id: 1 }, confidence: 0.9, done: false };
const POINT2 = { instruction: 'Click Submit Assignment. This sends it.', target: { kind: 'element', id: 2 }, confidence: 0.9, done: false };

const tick = (ms) => new Promise((r) => setTimeout(r, ms || 5));
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve: (v) => resolve(typeof v === 'string' ? v : JSON.stringify(v)), reject }; }
const pickOf = (el, over) => Object.assign({ accept: true, reason: 'ok', element: el, key: 'e' + el.id, confidence: 0.95, margin: 0.8, finished: 0.02, rightApp: 0.97, ms: 150, options: 2 }, over || {});

function fakeProbe() {
  const calls = [];
  const probe = {
    available: true, watching: null, calls,
    async request(op, params) {
      calls.push({ op, params });
      if (op === 'fg') return FG;
      if (op === 'uia.list') return { elements: ELEMENTS, ms: 210, visited: 480, truncated: false };
      return { element: null };
    },
    async watch(o) { probe.watching = o; return { ok: true }; },
    async unwatch() { probe.watching = null; return { ok: true }; },
    status() { return { watching: probe.watching }; },
  };
  return probe;
}

// replies: values, Errors, or deferred()s. picks: what Jev "said", in order.
function harness(replies, opts = {}) {
  const sent = [], logs = [], prompts = [], timings = [], fastLog = [], pickInputs = [];
  let hashN = 0, clock = 1000, same = Boolean(opts.sameScreen);
  const probe = fakeProbe();
  const picks = (opts.picks || []).slice();
  const g = new GuideSession({
    capture: async () => CAP,
    probe,
    // The streaming callback is a fresh closure per step; the prompts kept here are what the model is asked.
    llm: () => ({ ready: true, provider: 'gemini', async complete(args) { const { onDelta, ...asked } = args; prompts.push(asked); const r = replies.shift(); if (r && r.promise) return r.promise; if (r instanceof Error) throw r; return typeof r === 'string' ? r : JSON.stringify(r); } }),
    send: (ch, p) => sent.push([ch, p]),
    screenToDip: (p) => p, dipToScreen: (p) => p,
    winBounds: () => ({ x: 0, y: 0, width: 1920, height: 1040 }),
    hashCapture: () => { hashN += 1; const v = same ? 1 : hashN; const h = Uint8Array.from({ length: 32 }, (_, i) => (v * 73 + i * 31) & 255); return { whole: h, crop: h }; },
    selfPid: 999,
    log: (m) => logs.push(m),
    sleep: async () => {},
    now: () => (opts.ticking ? (clock += 7) : clock),
    walkthroughs: opts.walkthroughs || null,
    snapshot: opts.snapshot || null,
    fastPoint: opts.mode ? { mode: () => opts.mode, pick: async (input) => { pickInputs.push(input); if (opts.pickThrows) throw new Error('jev down'); return picks.shift() || pickOf(ELEMENTS[0], { accept: false, reason: 'none', element: null, key: 'none' }); } } : null,
    planMode: () => opts.plan || '',
    onTiming: (r) => timings.push(r),
    onFast: (r) => fastLog.push(r),
  });
  return { g, sent, logs, probe, prompts, timings, fastLog, pickInputs, setClock: (v) => { clock = v; }, setSame: (v) => { same = v; } };
}

const of = (sent, ch) => sent.filter(([c]) => c === ch).map(([, p]) => p);
const ops = (probe, op) => probe.calls.filter((c) => c.op === op).length;

// ---- timing and the free wins ------------------------------------------------
test('every step leaves one timing line with every stage in it', async () => {
  const { g, logs, timings } = harness([POINT1], { ticking: true });
  await g.start('submit my essay', 'typed', { askedAt: 900 });
  const line = logs.find((l) => /^timing step=1 /.test(l));
  assert.match(line, /how=ask end=point wait=\d+ fg=\d+ cap=\d+ uia=\d+\(2,480,full,210ms\) jev=- model=\d+ recon=\d+ point=\d+ total=\d+ prefetch=off via gemini/);
  assert.equal(timings.length, 1);
  for (const k of ['step', 'how', 'end', 'wait', 'fg', 'cap', 'uia', 'uiaInfo', 'jev', 'model', 'recon', 'point', 'total', 'prefetch', 'provider']) assert.ok(k in timings[0], k);
  assert.ok(timings[0].wait >= 100, 'the wait before the guide even started is counted');
  g.onArrived();
  assert.ok(logs.some((l) => /^timing step=1 arrive=\d+ total=\d+/.test(l)));
  g.dismiss('test');
});

test('the front window is looked up once per step, not twice', async () => {
  const { g, probe } = harness([POINT1, POINT2]);
  await g.start('submit my essay', 'typed');
  assert.equal(ops(probe, 'fg'), 1);
  assert.equal(ops(probe, 'uia.list'), 1);
  g.onArrived();
  await g.onClick({ x: 160, y: 212 });
  assert.equal(ops(probe, 'fg'), 2);
  assert.equal(ops(probe, 'uia.list'), 2);
  g.dismiss('test');
});

test('the screenshot is taken while the probe is busy, not after it', async () => {
  const order = [];
  const { g, probe } = harness([POINT1, POINT2]);
  g.d.capture = async () => { order.push('capture:start'); await tick(20); order.push('capture:end'); return CAP; };
  const request = probe.request.bind(probe);
  probe.request = async (op, p) => { order.push(op + ':start'); await tick(10); const r = await request(op, p); order.push(op + ':end'); return r; };
  await g.start('submit my essay', 'typed');
  // The window is looked up first; then the walk is sent to the probe BEFORE the
  // capture starts (the PNG encode blocks the process), and the two run together.
  const check = () => {
    assert.ok(order.indexOf('uia.list:start') < order.indexOf('capture:start'), 'the walk is on its way before the capture blocks anything');
    assert.ok(order.indexOf('capture:start') < order.indexOf('uia.list:end'), 'and the capture does not wait for it');
  };
  check();
  g.onArrived();
  order.length = 0;
  await g.onClick({ x: 160, y: 212 });
  assert.ok(order.indexOf('fg:end') < order.indexOf('uia.list:start'));
  check();
  g.dismiss('test');
});

test('Jev is asked as soon as the control list is in, not after the screenshot', async () => {
  const order = [];
  const h = harness([POINT1], { mode: 'shadow', picks: [pickOf(ELEMENTS[0])] });
  h.g.d.capture = async () => { await tick(40); order.push('capture:end'); return CAP; };
  const pick = h.g.d.fastPoint.pick;
  h.g.d.fastPoint.pick = async (input) => { order.push('jev:asked'); return pick(input); };
  await h.g.start('submit my essay', 'typed');
  assert.deepEqual(order, ['jev:asked', 'capture:end']);
  // Jev gets the probe's list with each control placed inside its own window.
  assert.deepEqual(h.pickInputs[0].elements.map((e) => e.id), [1, 2]);
  assert.deepEqual(h.pickInputs[0].window, { title: 'Canvas - Chrome', process: 'chrome' });
  h.g.dismiss('test');
});

// ---- the prefetched first read -------------------------------------------------
test('a prefetched read is used as is: no second lookup, no second walk, and the very same prompt', async () => {
  const plain = harness([POINT1]);
  await plain.g.start('submit my essay', 'typed');
  plain.g.dismiss('test');

  const snapshot = { take: async () => ({ fg: FG, cap: CAP, list: { elements: ELEMENTS, ms: 200, visited: 480, truncated: false }, age: 320 }) };
  const pre = harness([POINT1], { snapshot });
  await pre.g.start('submit my essay', 'typed');
  assert.equal(ops(pre.probe, 'fg'), 0);
  assert.equal(ops(pre.probe, 'uia.list'), 0);
  assert.deepEqual(pre.prompts[0], plain.prompts[0], 'the model is asked exactly what it would have been asked');
  assert.deepEqual(of(pre.sent, 'guide:target')[0].bbox, { x: 100, y: 200, w: 120, h: 24 });
  assert.equal(pre.timings[0].prefetch, 'hit(320ms)');
  pre.g.dismiss('test');

  const none = harness([POINT1], { snapshot: { take: async () => null } });
  await none.g.start('submit my essay', 'typed');
  assert.equal(ops(none.probe, 'fg'), 1);
  assert.equal(none.timings[0].prefetch, 'miss');
  none.g.dismiss('test');
});

test('snapshot rules: fresh is used, older needs the same window, stale is dropped, in-flight is awaited, single use', async () => {
  let clock = 0, fgNow = FG;
  const calls = [];
  const probe = { available: true, async request(op) { calls.push(op); if (op === 'fg') return fgNow; return { elements: ELEMENTS, ms: 100 }; } };
  const make = () => createSnapshotter({ probe, capture: async () => CAP, selfPid: 999, now: () => clock });

  let s = make();
  assert.equal(s.kick('t'), true);
  assert.equal(s.kick('t'), false, 'one read at a time');
  let got = await s.take({});
  assert.deepEqual(got.fg, FG);
  assert.equal(got.list.elements.length, 2);
  assert.equal(got.age, 0);
  assert.equal(await s.take({}), null, 'single use');
  assert.deepEqual(calls, ['fg', 'uia.list']);

  s = make(); s.kick('t'); await tick(); clock += 2500; calls.length = 0;
  got = await s.take({});
  assert.ok(got, 'older than fresh, same window in front: still good');
  assert.deepEqual(calls, ['fg'], 'one cheap check, no second walk');

  s = make(); s.kick('t'); await tick(); clock += 2500; fgNow = { hwnd: 78, title: 'Other', process: 'notepad', pid: 600 };
  assert.equal(await s.take({}), null, 'another window came to the front');
  fgNow = FG;

  s = make(); s.kick('t'); await tick(); clock += 9000;
  assert.equal(await s.take({}), null, 'too old');

  // Our own window in front: a capture, no walk.
  calls.length = 0; fgNow = { hwnd: 1, title: 'Nūs', process: 'electron', pid: 999 };
  s = make(); s.kick('t');
  got = await s.take({});
  assert.equal(got.fg, null);
  assert.equal(got.list, null);
  assert.deepEqual(calls, ['fg']);
});

// ---- shadow mode changes nothing -----------------------------------------------
test('shadow mode: the renderer and the model see exactly what they see with the quick pointer off', async () => {
  const off = harness([POINT1, POINT2]);
  await off.g.start('submit my essay', 'typed');
  off.g.onArrived(); await off.g.onClick({ x: 160, y: 212 });

  const sh = harness([POINT1, POINT2], { mode: 'shadow', picks: [pickOf(ELEMENTS[0]), pickOf(ELEMENTS[0], { confidence: 0.91 })] });
  await sh.g.start('submit my essay', 'typed');
  sh.g.onArrived(); await sh.g.onClick({ x: 160, y: 212 });

  const strip = (sent) => sent.map(([c, p]) => [c, Object.assign({}, p, { sessionId: null })]);
  assert.deepEqual(strip(sh.sent), strip(off.sent));
  assert.deepEqual(sh.prompts, off.prompts);
  assert.equal(ops(sh.probe, 'uia.list'), 2, 'still one walk per step');
  assert.deepEqual(sh.fastLog.map((r) => r.verdict), ['AGREE', 'DISAGREE']);
  assert.equal(sh.fastLog[0].shown, false);
  assert.equal(sh.fastLog[1].fast.name, 'Assignments');
  assert.equal(sh.fastLog[1].model.id, 2);
  assert.ok(sh.logs.some((l) => /^fast shadow pick=e1 "Assignments" conf=0\.95 .* -> AGREE$/.test(l)));
  sh.g.dismiss('test'); off.g.dismiss('test');

  const broken = harness([POINT1], { mode: 'shadow', pickThrows: true });
  await broken.g.start('submit my essay', 'typed');
  assert.equal(of(broken.sent, 'guide:target')[0].kicker, 'step 1', 'Jev failing is the same as Jev being off');
  broken.g.dismiss('test');
});

test('shadow counts a quick pick as wrong when the model says done or points nowhere', async () => {
  const a = harness([{ instruction: 'All done.', target: null, confidence: 0.9, done: true }], { mode: 'shadow', picks: [pickOf(ELEMENTS[0])] });
  await a.g.start('submit my essay', 'typed');
  assert.equal(a.fastLog[0].verdict, 'MODEL_DONE');
  const b = harness([{ instruction: 'Open Canvas first.', target: null, note: 'Wrong app.', confidence: 0.9 }], { mode: 'shadow', picks: [pickOf(ELEMENTS[0])] });
  await b.g.start('submit my essay', 'typed');
  assert.equal(b.fastLog[0].verdict, 'MODEL_NULL');
  assert.equal(b.fastLog[0].same, null);
  b.g.dismiss('test');
});

// ---- live ----------------------------------------------------------------------
test('live, the model agrees: the thread goes out on Jev\'s pick, silent, then takes the model\'s words in place', async () => {
  const d1 = deferred();
  const h = harness([d1], { mode: '1', picks: [pickOf(ELEMENTS[0])] });
  const run = h.g.start('submit my essay', 'voice');
  await tick();
  const quick = of(h.sent, 'guide:target');
  assert.equal(quick.length, 1, 'pointing before the model has answered');
  assert.equal(quick[0].kicker, 'step 1 · quick');
  assert.equal(quick[0].instruction, 'Click "Assignments".');
  assert.deepEqual(quick[0].bbox, { x: 100, y: 200, w: 120, h: 24 });
  assert.equal(quick[0].speak, undefined, 'a quick pick is never spoken');
  assert.equal(quick[0].seq, 1);
  assert.equal(h.prompts.length, 1, 'the model was already running');

  d1.resolve(POINT1);
  await run;
  assert.equal(of(h.sent, 'guide:target').length, 1, 'the thread did not move');
  const up = of(h.sent, 'guide:update');
  assert.equal(up.length, 1);
  assert.equal(up[0].instruction, 'Click Assignments');
  assert.equal(up[0].kicker, 'step 1');
  assert.equal(up[0].seq, 1);
  assert.equal(up[0].speak, 'Click Assignments', 'the one spoken sentence is the model\'s');
  assert.equal(h.fastLog[0].verdict, 'AGREE');
  assert.equal(h.fastLog[0].shown, true);
  assert.ok(h.timings.some((t) => t.end === 'fast') && h.timings.some((t) => t.end === 'update'));
  h.g.onArrived(1);
  assert.equal(h.g.status().state, 'pointing');
  h.g.dismiss('test');
});

test('live, the model picks another control: the thread moves, and a click already on its way to the old spot still counts', async () => {
  const d1 = deferred();
  const h = harness([d1, { instruction: 'Submitted.', target: null, confidence: 0.9, done: true }], { mode: '1', picks: [pickOf(ELEMENTS[0])] });
  const run = h.g.start('submit my essay', 'typed');
  await tick();
  h.g.onArrived(1);
  d1.resolve(POINT2);
  await run;
  const targets = of(h.sent, 'guide:target');
  assert.equal(targets.length, 2);
  assert.equal(targets[1].kicker, 'step 1');
  assert.equal(targets[1].seq, 2);
  assert.deepEqual(targets[1].bbox, { x: 1500, y: 900, w: 160, h: 40 });
  assert.equal(of(h.sent, 'guide:update').length, 0);
  assert.equal(h.g.status().state, 'unwinding');
  h.g.onArrived(1);
  assert.equal(h.g.status().state, 'unwinding', 'an arrival for the target the thread left is ignored');

  await h.g.onClick({ x: 160, y: 212 });           // the old quick pick, inside the grace window
  assert.equal(h.g.status().state, 'done');
  assert.equal(h.g.session.steps[0].name, 'Assignments', 'history records what was really clicked');
  assert.equal(h.g.session.steps[0].confirmed, 'disagree');
  assert.equal(h.g.lastRecord, null, 'a step the model did not stand behind is never offered for keeping');
});

test('live, after the grace window a click on the old spot is just a miss', async () => {
  const d1 = deferred();
  const h = harness([d1], { mode: '1', picks: [pickOf(ELEMENTS[0])] });
  const run = h.g.start('submit my essay', 'typed');
  await tick();
  d1.resolve(POINT2);
  await run;
  h.g.onArrived(2);
  h.setClock(1000 + 601);
  await h.g.onClick({ x: 160, y: 212 });
  assert.equal(h.g.status().state, 'pointing');
  assert.equal(h.g.session.steps.length, 0);
  h.g.dismiss('test');
});

test('live, the model has nothing to point at: the thread comes back and the model\'s words are shown', async () => {
  const d1 = deferred();
  const a = harness([d1], { mode: '1', picks: [pickOf(ELEMENTS[0])] });
  const run = a.g.start('submit my essay', 'typed');
  await tick();
  d1.resolve({ instruction: 'Open Canvas first.', target: null, note: 'The front window is not Canvas.', confidence: 0.9 });
  await run;
  const chans = a.sent.map(([c]) => c);
  assert.ok(chans.indexOf('guide:retract') > chans.indexOf('guide:target'));
  assert.ok(chans.lastIndexOf('guide:bubble') > chans.indexOf('guide:retract'));
  assert.equal(a.g.status().state, 'explaining');
  assert.equal(a.g.session.target, null);
  a.g.dismiss('test');

  const d2 = deferred();
  const b = harness([d2], { mode: '1', picks: [pickOf(ELEMENTS[0])] });
  const run2 = b.g.start('submit my essay', 'typed');
  await tick();
  d2.resolve({ instruction: 'Already submitted.', target: null, confidence: 0.9, done: true });
  await run2;
  assert.equal(of(b.sent, 'guide:retract').length, 1);
  assert.equal(b.g.status().state, 'done');

  const d3 = deferred();
  const c = harness([d3], { mode: '1', picks: [pickOf(ELEMENTS[0])] });
  const run3 = c.g.start('submit my essay', 'typed');
  await tick();
  d3.reject(new Error('ECONNRESET'));
  await run3;
  assert.equal(of(c.sent, 'guide:retract').length, 1);
  assert.match(of(c.sent, 'guide:bubble').pop().text, /could not reach .*Check your internet/);
  c.g.dismiss('test');
});

test('live, the person clicks the quick pick before the model answers: the late reply is written down and never shown', async () => {
  const d1 = deferred(), d2 = deferred();
  const h = harness([d1, d2], { mode: '1', picks: [pickOf(ELEMENTS[0]), pickOf(ELEMENTS[1])] });
  const run = h.g.start('submit my essay', 'typed');
  await tick();
  h.g.onArrived(1);
  const adv = h.g.onClick({ x: 160, y: 212 });
  await tick();
  assert.equal(h.g.session.steps[0].confirmed, 'pending');
  assert.equal(h.g.session.steps[0].instruction, 'Click "Assignments".');
  assert.equal(h.prompts.length, 2, 'step 2 is already with the model');
  assert.equal(of(h.sent, 'guide:target').length, 1, 'no second quick pick while an earlier model call is still out');

  const before = h.sent.length, probeBefore = h.probe.calls.length;
  d1.resolve(POINT1);
  await run;
  assert.equal(h.sent.length, before, 'the late reply sends nothing to the renderer');
  assert.equal(h.probe.calls.length, probeBefore, 'and never touches the probe');
  assert.equal(h.g.session.steps[0].confirmed, 'agree');
  assert.equal(h.g.session.steps[0].instruction, 'Click Assignments', 'history takes the model\'s wording');

  d2.resolve(POINT2);
  await adv;
  const t = of(h.sent, 'guide:target');
  assert.equal(t.length, 2);
  assert.equal(t[1].kicker, 'step 2');
  assert.deepEqual(h.fastLog.map((r) => [r.step, r.verdict, r.late]), [[1, 'AGREE', true], [2, 'AGREE', false]]);
  h.g.dismiss('test');
});

test('live, a clicked-ahead quick pick the model disagreed with blocks Keep and the "again" shortcut', async () => {
  const d1 = deferred(), d2 = deferred();
  const h = harness([d1, d2, { instruction: 'Done.', target: null, confidence: 0.9, done: true }], { mode: '1', sameScreen: true, picks: [pickOf(ELEMENTS[0])] });
  const run = h.g.start('submit my essay', 'typed');
  await tick();
  h.g.onArrived(1);
  const adv = h.g.onClick({ x: 160, y: 212 });
  await tick();
  d1.resolve(POINT2);                                   // the model wanted the other control
  await run;
  assert.equal(h.g.session.steps[0].confirmed, 'disagree');
  // The screen did not change, but the control was never the model's: no "again", ask the model.
  assert.equal(h.prompts.length, 2);
  d2.resolve(POINT2);
  await adv;
  assert.equal(of(h.sent, 'guide:target').pop().kicker, 'step 2');
  h.g.onArrived(2);
  h.setClock(5000);
  h.setSame(false);
  await h.g.onClick({ x: 1580, y: 920 });
  assert.equal(h.g.status().state, 'done');
  assert.equal(h.g.lastRecord, null);
});

test('Next during the quick stage moves on like a click; Esc mid-flight drops everything', async () => {
  const d1 = deferred(), d2 = deferred();
  const h = harness([d1, d2], { mode: '1', picks: [pickOf(ELEMENTS[0])] });
  const run = h.g.start('submit my essay', 'typed');
  await tick();
  h.g.onArrived(1);
  const adv = h.g.onAction('next');
  await tick();
  assert.equal(h.g.session.steps[0].outcome, 'moved on');
  h.g.onKey(27, true);
  assert.equal(h.g.status().state, 'idle');
  const before = h.sent.length;
  d1.resolve(POINT1); d2.resolve(POINT2);
  await run; await adv;
  assert.equal(h.sent.length, before, 'replies for a dismissed session are dropped');
});

test('a kept walkthrough still replays with no model and no Jev', async () => {
  const store = createWalkthroughs({});
  store.record({ task: 'submit my essay', app: { process: 'chrome', title: 'Canvas - Chrome' }, steps: [{ instruction: 'Click Assignments', name: 'Assignments', type: 'Hyperlink' }] });
  const h = harness([], { mode: '1', walkthroughs: store, picks: [pickOf(ELEMENTS[0])] });
  h.probe.request = async (op, params) => { h.probe.calls.push({ op, params }); if (op === 'fg') return FG; if (op === 'uia.find') return { element: Object.assign({}, ELEMENTS[0], { automationId: '' }), score: 100 }; return {}; };
  await h.g.start('submit my essay', 'typed');
  assert.equal(of(h.sent, 'guide:target')[0].kicker, 'step 1 · from last time');
  assert.equal(h.prompts.length, 0);
  assert.equal(h.pickInputs.length, 0);
  assert.equal(ops(h.probe, 'fg'), 1, 'replay also looks the window up once');
  h.g.dismiss('test');
});

// ---- plan-ahead ------------------------------------------------------------------
test('the model\'s plan reaches Jev on the next step and never reaches the model\'s own prompt', async () => {
  const withPlan = Object.assign({}, POINT1, { next: [{ instruction: 'Click Submit Assignment. This sends it.', control: 'Submit Assignment' }, 'junk', { nope: 1 }] });
  const h = harness([withPlan, POINT2], { mode: 'shadow', plan: 'inline', picks: [pickOf(ELEMENTS[0]), pickOf(ELEMENTS[1])] });
  await h.g.start('submit my essay', 'typed');
  assert.match(h.prompts[0].system, /you may add \[NEXT:/);
  h.g.onArrived(); await h.g.onClick({ x: 160, y: 212 });
  assert.equal(h.pickInputs[0].planned, null);
  assert.deepEqual(h.pickInputs[1].planned, { instruction: 'Click Submit Assignment. This sends it.', control: 'Submit Assignment' });
  assert.equal(/Submit Assignment\. This sends it/.test(h.prompts[1].turns[0].text.split('Controls in the front window')[0].replace(/Steps already done:[\s\S]*/, '')), false);
  h.g.dismiss('test');

  const plain = harness([POINT1, POINT2]);
  await plain.g.start('submit my essay', 'typed');
  plain.g.onArrived(); await plain.g.onClick({ x: 160, y: 212 });
  assert.equal(h.prompts[1].turns[0].text, plain.prompts[1].turns[0].text, 'step 2 asks the model the same thing with or without a plan in hand');
  assert.equal(/you may add \[NEXT:/.test(plain.prompts[0].system), false, 'off unless asked for');
  plain.g.dismiss('test');
});
