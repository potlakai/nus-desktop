// The guide loop with every dependency faked: capture, probe, model, renderer.
const test = require('node:test');
const assert = require('node:assert/strict');
const { GuideSession } = require('../src/guide/session');
const { createWalkthroughs } = require('../src/guide/walkthroughs');

const CAP = { dataUrl: 'data:image/png;base64,AAAA', width: 1280, height: 720, pxWidth: 1920, pxHeight: 1080, display: { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 } };
const ELEMENTS = [
  { id: 1, name: 'Assignments', type: 'Hyperlink', rect: { x: 100, y: 200, w: 120, h: 24 } },
  { id: 2, name: 'Submit Assignment', type: 'Button', rect: { x: 1500, y: 900, w: 160, h: 40 } },
];

function fakeProbe() {
  const calls = [];
  const probe = {
    available: true,
    watching: null,
    calls,
    async request(op, params) {
      calls.push({ op, params });
      if (op === 'fg') return { hwnd: 77, title: 'Canvas - Chrome', process: 'chrome', pid: 500 };
      if (op === 'uia.list') return { elements: ELEMENTS };
      if (op === 'uia.frompoint') return { element: { name: 'Submit Assignment', type: 'Button', rect: ELEMENTS[1].rect } };
      if (op === 'uia.find') return { element: null };
      return {};
    },
    async watch(o) { probe.watching = o; return { ok: true }; },
    async unwatch() { probe.watching = null; return { ok: true }; },
    status() { return { watching: probe.watching }; },
  };
  return probe;
}

function harness(replies, opts = {}) {
  const sent = [];
  const logs = [];
  let hashN = 0;
  const probe = opts.probe === null ? null : fakeProbe();
  const g = new GuideSession({
    capture: async () => CAP,
    probe,
    llm: () => ({ ready: opts.ready !== false, provider: 'gemini', async complete() { const r = replies.shift(); if (r instanceof Error) throw r; return typeof r === 'string' ? r : JSON.stringify(r); } }),
    send: (ch, p) => sent.push([ch, p]),
    screenToDip: (p) => p,
    dipToScreen: (p) => p,
    winBounds: () => ({ x: 0, y: 0, width: 1920, height: 1040 }),
    hashCapture: () => { hashN += 1; const v = opts.sameScreen ? 1 : hashN; const h = Uint8Array.from({ length: 32 }, (_, i) => (v * 73 + i * 31) & 255); return { whole: h, crop: h }; },
    selfPid: 999,
    log: (m) => logs.push(m),
    sleep: async () => {},
    now: () => 1000,
    onKeep: opts.onKeep || (() => {}),
    walkthroughs: opts.walkthroughs || null,
  });
  return { g, sent, logs, probe };
}

const states = (sent) => sent.filter(([c]) => c === 'guide:state').map(([, p]) => p.state);
const last = (sent, ch) => { const m = sent.filter(([c]) => c === ch); return m.length ? m[m.length - 1][1] : null; };

test('an ask reads once (amber), points at a verified element, and lands the bubble at the tip', async () => {
  const { g, sent, probe } = harness([{ instruction: 'Click Assignments', target: { kind: 'element', id: 1 }, confidence: 0.9, done: false }]);
  await g.start('submit my essay on canvas', 'typed');
  assert.deepEqual(states(sent), ['reading', 'unwinding']);
  const t = last(sent, 'guide:target');
  assert.deepEqual(t.bbox, { x: 100, y: 200, w: 120, h: 24 });
  assert.equal(t.instruction, 'Click Assignments');
  assert.equal(t.kicker, 'step 1');
  assert.deepEqual(t.actions, [{ id: 'next', label: 'Next' }]);
  assert.equal(probe.calls.filter((c) => c.op === 'uia.list').length, 1);
  g.onArrived();
  assert.equal(g.status().state, 'pointing');
  assert.deepEqual(probe.watching, { keys: [27], click: true, fg: false });
});

test('a click on the target re-reads and points at the next step; done finishes and offers keep', async () => {
  const kept = [];
  const { g, sent, probe } = harness([
    { instruction: 'Click Assignments', target: { kind: 'element', id: 1 }, confidence: 0.9 },
    { instruction: 'Click Submit Assignment. This sends it.', target: { kind: 'element', id: 2 }, confidence: 0.8 },
    { instruction: 'Submitted. You are done.', target: null, confidence: 0.9, done: true },
  ], { onKeep: (r) => kept.push(r) });
  await g.start('submit my essay', 'typed');
  g.onArrived();
  g.onClick({ x: 5, y: 5 });                       // nowhere near the target: ignored
  assert.equal(g.status().state, 'pointing');
  await g.onClick({ x: 160, y: 212 });             // on Assignments
  assert.equal(probe.watching, null, 'watch stops while reading');
  const t2 = last(sent, 'guide:target');
  assert.equal(t2.kicker, 'step 2');
  assert.deepEqual(t2.bbox, { x: 1500, y: 900, w: 160, h: 40 });
  g.onArrived();
  await g.onClick({ x: 1580, y: 920 });
  assert.equal(g.status().state, 'done');
  assert.equal(last(sent, 'guide:bubble').text, 'Submitted. You are done.');
  g.keep();
  assert.equal(kept.length, 1);
  assert.equal(kept[0].steps.length, 2);
  assert.equal(kept[0].steps[0].name, 'Assignments');
});

test('Next advances without a click; Esc from the probe winds back', async () => {
  const { g, sent } = harness([
    { instruction: 'Type your name in the box', target: { kind: 'element', id: 1 }, confidence: 0.9 },
    { instruction: 'Click Submit Assignment', target: { kind: 'element', id: 2 }, confidence: 0.9 },
  ]);
  await g.start('fill the form', 'typed');
  g.onArrived();
  await g.onAction('next');
  assert.equal(last(sent, 'guide:target').kicker, 'step 2');
  g.onArrived();
  g.onKey(27, true);
  assert.equal(g.status().state, 'idle');
  const done = last(sent, 'guide:done');
  assert.equal(done.offerKeep, false, 'a dismissed session never offers keep');
  assert.equal(typeof done.sessionId, 'string');
});

test('the model may refuse to point: null target explains, low confidence explains, a wrong id explains', async () => {
  const a = harness([{ instruction: 'Open Canvas first.', target: null, note: 'The front window is not Canvas.', confidence: 0.9 }]);
  await a.g.start('submit', 'typed');
  assert.equal(a.g.status().state, 'explaining');
  assert.match(last(a.sent, 'guide:bubble').text, /Open Canvas first\. The front window is not Canvas\./);
  assert.equal(a.sent.some(([c]) => c === 'guide:target'), false, 'no thread');
  a.g.dismiss('test');

  const b = harness([{ instruction: 'Click X', target: { kind: 'element', id: 42 }, confidence: 0.9 }]);
  await b.g.start('x', 'typed');
  assert.equal(b.g.status().state, 'explaining');
  assert.equal(b.sent.some(([c]) => c === 'guide:target'), false);
  b.g.dismiss('test');
});

test('a bbox only becomes a thread when Windows agrees; otherwise it says so', async () => {
  const agree = harness([{ instruction: 'Click Submit Assignment', target: { kind: 'bbox', x: 0.78, y: 0.83, w: 0.09, h: 0.04, label: 'Submit Assignment' }, confidence: 0.8 }]);
  await agree.g.start('submit', 'typed');
  assert.deepEqual(last(agree.sent, 'guide:target').bbox, { x: 1500, y: 900, w: 160, h: 40 }, 'the UIA rect, not the model box');
  agree.g.dismiss('test');

  const disagree = harness([{ instruction: 'Click Cancel', target: { kind: 'bbox', x: 0.1, y: 0.1, w: 0.05, h: 0.03, label: 'Cancel' }, confidence: 0.8 }]);
  disagree.probe.request = async (op) => (op === 'fg' ? { hwnd: 77, title: 'x', process: 'x', pid: 1 } : op === 'uia.list' ? { elements: ELEMENTS } : { element: null });
  await disagree.g.start('cancel', 'typed');
  // 2026-09-15: Windows not confirming the box no longer stops the walkthrough
  // (CapCut exposes nothing to UI Automation). The model's box is pointed at
  // and labelled a best guess instead.
  assert.equal(disagree.g.status().state, 'unwinding');
  const guess = last(disagree.sent, 'guide:target');
  assert.match(guess.kicker, /best guess/);
  assert.match(guess.hint, /Best guess from the screenshot\. Click it and I will re-read the screen\./);
  assert.equal(disagree.sent.some(([c, p]) => c === 'guide:bubble' && /could not find that control/.test(p.text)), false);
  disagree.g.dismiss('test');
});

test('no probe: model-only pointing is allowed but flagged unverified', async () => {
  const { g, sent } = harness([{ instruction: 'Click Save', target: { kind: 'bbox', x: 0.5, y: 0.5, w: 0.05, h: 0.03, label: 'Save' }, confidence: 0.9 }], { probe: null });
  await g.start('save', 'typed');
  const t = last(sent, 'guide:target');
  assert.deepEqual(t.bbox, { x: 960, y: 540, w: 96, h: 32 });
  assert.match(t.hint, /Best guess from the screenshot/);
  assert.match(t.kicker, /best guess/);
  g.dismiss('test');
});

test('an unchanged screen after a click repeats the step once, then says so', async () => {
  const { g, sent } = harness([
    { instruction: 'Click Assignments', target: { kind: 'element', id: 1 }, confidence: 0.9 },
  ], { sameScreen: true });
  await g.start('go', 'typed');
  g.onArrived();
  await g.onClick({ x: 160, y: 212 });
  assert.equal(last(sent, 'guide:target').kicker, 'step 2 · again');
  g.onArrived();
  await g.onClick({ x: 160, y: 212 });
  assert.equal(g.status().state, 'explaining');
  assert.match(last(sent, 'guide:bubble').text, /did not seem to take/);
  g.dismiss('test');
});

test('no key, a dead model, and a busy session all explain instead of hanging', async () => {
  const noKey = harness([], { ready: false });
  await noKey.g.start('x', 'typed');
  assert.match(last(noKey.sent, 'guide:bubble').text, /Add your gemini key/);
  noKey.g.dismiss('test');

  const dead = harness([new Error('ECONNRESET')]);
  await dead.g.start('x', 'typed');
  assert.match(last(dead.sent, 'guide:bubble').text, /could not reach the model/);
  dead.g.dismiss('test');

  const busy = harness([{ instruction: 'Click Assignments', target: { kind: 'element', id: 1 }, confidence: 0.9 }]);
  await busy.g.start('one', 'typed');
  assert.equal(await busy.g.start('two', 'typed'), false);
  busy.g.dismiss('test');
});

test('the Knot itself in front is not an app: the session asks for the app, never points at the overlay', async () => {
  const { g, sent, probe } = harness([{ instruction: 'Open the app you need help with first.', target: null, confidence: 0.9 }]);
  probe.request = async (op) => (op === 'fg' ? { hwnd: 1, title: 'Nūs Companion', process: 'electron', pid: 999 } : { elements: [] });
  await g.start('help', 'typed');
  assert.equal(g.status().state, 'explaining');
  assert.equal(probe.calls.filter((c) => c.op === 'uia.list').length, 0, 'no control walk on our own window');
  g.dismiss('test');
});

test('a kept walkthrough replays by control name with zero model calls, then finishes', async () => {
  const modelCalls = [];
  const { g, sent, probe } = harness([
    { instruction: 'Click Assignments', target: { kind: 'element', id: 1 }, confidence: 0.9 },
    { instruction: 'Click Submit Assignment. This sends it.', target: { kind: 'element', id: 2 }, confidence: 0.8 },
    { instruction: 'Submitted.', target: null, confidence: 0.9, done: true },
  ], { walkthroughs: createWalkthroughs({}) });
  const store = g.d.walkthroughs;
  // First run: live, three model replies, then Keep.
  await g.start('submit my essay', 'typed');
  g.onArrived(); await g.onClick({ x: 160, y: 212 });
  g.onArrived(); await g.onClick({ x: 1580, y: 920 });
  assert.equal(g.status().state, 'done');
  g.keep();
  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0].steps, 2);
  // Let the done timer clear the session.
  await new Promise((r) => setTimeout(r, 2500));
  assert.equal(g.status().state, 'idle');

  // Second run: same app, same ask. No model; uia.find resolves each step.
  const before = probe.calls.length;
  probe.request = async (op, params) => {
    probe.calls.push({ op, params });
    if (op === 'fg') return { hwnd: 77, title: 'Canvas - Chrome', process: 'chrome', pid: 500 };
    if (op === 'uia.find') { const el = ELEMENTS.find((e) => e.name === params.name); return { element: el ? { ...el, automationId: '' } : null, score: el ? 100 : 0 }; }
    if (op === 'uia.list') { modelCalls.push('list'); return { elements: ELEMENTS }; }
    return {};
  };
  await g.start('submit my essay', 'typed');
  let t = last(sent, 'guide:target');
  assert.equal(t.kicker, 'step 1 · from last time');
  assert.deepEqual(t.bbox, { x: 100, y: 200, w: 120, h: 24 });
  assert.match(t.hint, /Same as last time/);
  g.onArrived(); await g.onClick({ x: 160, y: 212 });
  t = last(sent, 'guide:target');
  assert.equal(t.kicker, 'step 2 · from last time');
  g.onArrived(); await g.onClick({ x: 1580, y: 920 });
  assert.equal(g.status().state, 'done');
  assert.equal(last(sent, 'guide:bubble').text, 'Done, same as last time.');
  assert.equal(probe.calls.slice(before).filter((c) => c.op === 'uia.list').length, 0, 'no control walk');
  assert.equal(modelCalls.length, 0, 'no model call');
});

test('a replay miss hands the step to the live loop with the saved step as a hint, and two misses retire the walkthrough', async () => {
  const store = createWalkthroughs({});
  store.record({ task: 'submit my essay', app: { process: 'chrome', title: 'Canvas' }, steps: [{ instruction: 'Click Assignments', name: 'Assignments (old)', type: 'Hyperlink' }] });
  const prompts = [];
  const { g, sent, probe } = harness([{ instruction: 'Click Assignments', target: { kind: 'element', id: 1 }, confidence: 0.9 }], { walkthroughs: store });
  g.d.llm = () => ({ ready: true, provider: 'gemini', async complete({ turns }) { prompts.push(turns[0].text); return JSON.stringify({ instruction: 'Click Assignments', target: { kind: 'element', id: 1 }, confidence: 0.9 }); } });
  probe.request = async (op, params) => {
    probe.calls.push({ op, params });
    if (op === 'fg') return { hwnd: 77, title: 'Canvas', process: 'chrome', pid: 500 };
    if (op === 'uia.find') return { element: null, score: 0 };
    if (op === 'uia.list') return { elements: ELEMENTS };
    return {};
  };
  await g.start('submit my essay', 'typed');
  const t = last(sent, 'guide:target');
  assert.equal(t.kicker, 'step 1', 'live, not replay');
  assert.match(prompts[0], /Last time, at this point, the step was: Click Assignments \(control "Assignments \(old\)"\)/);
  assert.equal(store.get(store.keyFor('chrome', 'submit my essay')).misses, 1);
  g.dismiss('test');
  await g.start('submit my essay', 'typed');
  assert.equal(store.get(store.keyFor('chrome', 'submit my essay')).stale, true, 'retired after the second miss');
  g.dismiss('test');
});

test('Skip forgets: nothing is saved for replay', async () => {
  const store = createWalkthroughs({});
  const { g } = harness([
    { instruction: 'Click Assignments', target: { kind: 'element', id: 1 }, confidence: 0.9 },
    { instruction: 'Done.', target: null, confidence: 0.9, done: true },
  ], { walkthroughs: store });
  await g.start('submit', 'typed');
  g.onArrived(); await g.onClick({ x: 160, y: 212 });
  g.skip();
  assert.equal(store.list().length, 0);
});

test('a resolved password field is refused even when the model points at it', async () => {
  const h = harness([{ instruction: 'Type your password', target: { kind: 'bbox', x: 0.1, y: 0.1, w: 0.05, h: 0.03, label: 'Password' }, confidence: 0.9 }]);
  h.probe.request = async (op) => (op === 'fg' ? { hwnd: 77, title: 'x', process: 'x', pid: 1 } : op === 'uia.list' ? { elements: ELEMENTS } : { element: { name: 'Password', type: 'Edit', rect: { x: 180, y: 100, w: 100, h: 40 } } });
  await h.g.start('log in', 'typed');
  assert.equal(h.g.status().state, 'explaining');
  assert.match(last(h.sent, 'guide:bubble').text, /password or card field/);
  assert.equal(h.sent.some(([c]) => c === 'guide:target'), false, 'no thread');
  h.g.dismiss('test');
});
