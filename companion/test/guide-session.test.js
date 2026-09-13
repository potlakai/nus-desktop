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
      if (op === 'uia.frompoint') return { element: ELEMENTS.find(e => params.x >= e.rect.x && params.x <= e.rect.x + e.rect.w && params.y >= e.rect.y && params.y <= e.rect.y + e.rect.h) || null };
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

test('pause and clarification retain the task without a new screenshot or a completed step', async () => {
  const { g, sent } = harness([{ instruction: 'Click Assignments', target: { kind: 'element', id: 1 }, confidence: .9 }, { instruction: 'Assignments contains your submitted work.' }]);
  let captures = 0; const original = g.d.capture; g.d.capture = () => { captures++; return original(); };
  await g.start('Find my essay', 'typed'); g.onArrived(); const id = g.session.id;
  g.pause(); assert.equal(g.state, 'paused');
  await g.followUp('Why this step?');
  assert.equal(g.session.id, id); assert.equal(g.session.task, 'Find my essay');
  assert.equal(g.session.steps.length, 0); assert.equal(captures, 1);
  assert.match(last(sent, 'guide:bubble').text, /submitted work/); g.dismiss('test');
});

test('a guide created before the probe starts uses the current probe after startup', async () => {
  let currentProbe = null;
  const g = new GuideSession({ get probe() { return currentProbe; }, log: () => {}, selfPid: 999 });
  assert.equal(await g.foreground(), null);
  currentProbe = fakeProbe();
  assert.equal((await g.foreground()).hwnd, 77);
  currentProbe = null;
  assert.equal(await g.foreground(), null);
});

test('an ask reads once (amber), points at a verified element, and lands the bubble at the tip', async () => {
  const { g, sent, probe } = harness([{ instruction: 'Click Assignments', target: { kind: 'element', id: 1 }, confidence: 0.9, done: false }]);
  await g.start('submit my essay on canvas', 'typed');
  assert.deepEqual(states(sent), ['reading', 'thinking', 'unwinding']);
  const t = last(sent, 'guide:target');
  assert.deepEqual(t.bbox, { x: 100, y: 200, w: 120, h: 24 });
  assert.equal(t.instruction, 'Click Assignments');
  assert.equal(t.kicker, 'step 1');
  assert.deepEqual(t.actions.map((a) => a.id), ['next', 'why', 'pause', 'refresh']);
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
  assert.deepEqual(probe.watching, { keys: [27], click: false, fg: false }, 'Escape remains active while clicks are ignored');
  const t2 = last(sent, 'guide:target');
  assert.equal(t2.kicker, 'step 2');
  assert.deepEqual(t2.bbox, { x: 1500, y: 900, w: 160, h: 40 });
  g.onArrived();
  await g.onClick({ x: 1580, y: 920 });
  assert.equal(g.status().state, 'explaining', 'a click does not prove task completion');
  assert.equal(g.keep().ok, false, 'unconfirmed outcomes cannot become saved walkthroughs');
  g.onAction('complete');
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
  assert.equal(disagree.g.status().state, 'explaining');
  assert.match(last(disagree.sent, 'guide:bubble').text, /could not find that control for sure/);
  disagree.g.dismiss('test');
});

test('no probe: explain without drawing an unverified pointer', async () => {
  const { g, sent } = harness([{ instruction: 'Click Save', target: { kind: 'bbox', x: 0.5, y: 0.5, w: 0.05, h: 0.03, label: 'Save' }, confidence: 0.9 }], { probe: null });
  await g.start('save', 'typed');
  const t = last(sent, 'guide:target');
  assert.equal(t, null);
  assert.match(last(sent, 'guide:bubble').text, /verified screen pointing is unavailable/);
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
  g.onAction('complete');
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
  assert.equal(g.status().state, 'explaining');
  g.onAction('complete');
  assert.equal(g.status().state, 'done');
  assert.equal(last(sent, 'guide:bubble').text, 'Done, same as last time.');
  assert.equal(probe.calls.slice(before).filter((c) => c.op === 'uia.list').length, 0, 'no control walk');
  assert.equal(modelCalls.length, 0, 'no model call');
});

test('a replay find that sees only the native frame retries once before it counts as a miss (Chromium accessibility wakes on the first UIA query, 2026-09-10)', async () => {
  const store = createWalkthroughs({});
  store.record({ task: 'submit my essay', app: { process: 'chrome', title: 'Canvas' }, steps: [{ instruction: 'Click Assignments', name: 'Assignments', type: 'Hyperlink' }] });
  const { g, sent, probe, logs } = harness([], { walkthroughs: store });
  let finds = 0; const sleeps = [];
  g.d.sleep = async (ms) => { sleeps.push(ms); };
  g.d.llm = () => { throw new Error('no model call expected on a replay'); };
  probe.request = async (op, params) => {
    probe.calls.push({ op, params });
    if (op === 'fg') return { hwnd: 77, title: 'Canvas', process: 'chrome', pid: 500 };
    if (op === 'uia.find') { finds += 1; return finds === 1 ? { element: null, score: 0, searched: 4 } : { element: { ...ELEMENTS[0], automationId: '' }, score: 100, searched: 5 }; }
    return {};
  };
  await g.start('submit my essay', 'typed');
  const t = last(sent, 'guide:target');
  assert.equal(finds, 2, 'one retry');
  assert.deepEqual(sleeps, [500], 'a short pause before the retry');
  assert.equal(t.kicker, 'step 1 · from last time');
  assert.ok(logs.includes('replay find: matched on retry'));
  assert.equal(store.get(store.keyFor('chrome', 'submit my essay')).misses, 0, 'not counted against the walkthrough');
  g.dismiss('test');
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
    if (op === 'uia.frompoint') return { element: ELEMENTS[0] };
    if (op === 'uia.list') return { elements: ELEMENTS };
    return {};
  };
  const logs = []; const origLog = g.d.log; g.d.log = (m) => { logs.push(String(m)); if (typeof origLog === 'function') origLog(m); };
  await g.start('submit my essay', 'typed');
  const t = last(sent, 'guide:target');
  assert.equal(t.kicker, 'step 1', 'live, not replay');
  assert.ok(logs.some((l) => /^replay miss on step 1: find score 0, searched 0 in "Canvas" hwnd 77 \(after retry\)$/.test(l)), 'the miss log says what the probe saw (2026-09-10): ' + JSON.stringify(logs));
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

test('Escape during a pending model call prevents its late answer from pointing', async () => {
  const { g, sent, probe } = harness([]);
  let release;
  g.d.llm = () => ({ ready: true, complete: () => new Promise(r => { release = r; }) });
  const pending = g.start('help', 'typed');
  await new Promise(setImmediate);
  assert.ok(probe.watching.keys.includes(27));
  g.onKey(27, true);
  release(JSON.stringify({ instruction: 'Click Assignments', target: { kind: 'element', id: 1 }, confidence: .9 }));
  await pending;
  assert.equal(g.status().state, 'idle');
  assert.equal(last(sent, 'guide:target'), null);
});

test('switching apps while the model thinks prevents stale pointing', async () => {
  const { g, sent, probe } = harness([]);
  const request = probe.request;
  g.d.llm = () => ({ ready: true, complete: async () => {
    probe.request = (op, params) => op === 'fg' ? Promise.resolve({ hwnd: 88, title: 'Different app', pid: 501 }) : request(op, params);
    return JSON.stringify({ instruction: 'Click Assignments', target: { kind: 'element', id: 1 }, confidence: .9 });
  } });
  await g.start('help', 'typed');
  assert.equal(last(sent, 'guide:target'), null);
  assert.match(last(sent, 'guide:bubble').text, /app changed/);
  g.dismiss('test');
});

test('a verified control outside the selected display never gets a strand', async () => {
  const { g, sent } = harness([{ instruction: 'Click Assignments', target: { kind: 'element', id: 1 }, confidence: .9 }]);
  g.d.winBounds = () => ({ x: 0, y: 0, width: 100, height: 100 });
  await g.start('help', 'typed');
  assert.equal(last(sent, 'guide:target'), null);
  assert.match(last(sent, 'guide:bubble').text, /outside the Knot display/);
  g.dismiss('test');
});

test('mid-walkthrough questions carry the goal and current step in plain words; "did not work" keeps the real last step (2026-09-10)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'guide', 'session.js'), 'utf8');
  const pointing = fs.readFileSync(path.join(__dirname, '..', 'src', 'guide', 'pointing.js'), 'utf8');
  const main = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.match(src, /'The step currently on their screen is: "' \+ current \+ '"'/);
  assert.match(src, /If it is "why", say why "' \+ \(current \|\| 'the next step'\) \+ '" moves them toward/);
  assert.match(src, /return this\.readAndPoint\(gen, 'followup', \{ instruction: s\.target && s\.target\.instruction \? s\.target\.instruction : '', target: s\.target, failed: failed \? s\.unresolved : '' \}\);/);
  assert.match(pointing, /input\.hint && input\.hint\.failed \? \['The user tried that step and says it did not work: '/);
  assert.match(src, /showPaused\(\) \{\n\s+if \(!this\.session \|\| this\.state !== 'paused'\) return false;/);
  assert.equal((main.match(/if \(guide && guide\.status\(\)\.state === 'paused'\) setTimeout\(\(\) => guide && guide\.showPaused\(\), 900\)/g) || []).length, 3, 'renderer dismiss, global Escape and selection cancel re-show a paused walkthrough (the Escape guard is asserted below)');
  assert.match(main, /if \(reason === 'esc' && guide && guide\.status\(\)\.state === 'paused' && Date\.now\(\) - lastInspectionClearedAt < 1500\)/);
});

test('a walkthrough started from a selection is pinned to Claude and carries the selection answer as prior context (Phase 2)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'guide', 'session.js'), 'utf8');
  const pointing = fs.readFileSync(path.join(__dirname, '..', 'src', 'guide', 'pointing.js'), 'utf8');
  const main = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.match(src, /llm\(\) \{\n\s+const lock = this\.session && this\.session\.providerLock;\n\s+return lock && this\.d\.llmFor \? this\.d\.llmFor\(lock\) : this\.d\.llm\(\);/);
  assert.equal((src.match(/this\.d\.llm\(\)/g) || []).length, 1, 'every model call goes through llm() so the lock cannot be bypassed');
  assert.match(src, /async start\(text, source, opts = \{\}\)/);
  assert.match(src, /providerLock: opts\.providerLock \|\| null, prior: String\(opts\.prior \|\| ''\)\.slice\(0, 600\)/);
  assert.match(src, /hint: hint \|\| null, prior: s\.prior \|\| '' \}\);/);
  assert.match(pointing, /input\.prior \? \['Earlier, about this screen, you told the user: ' \+ clip\(input\.prior, 300\)\] : \[\]/);
  assert.match(main, /llmFor: \(lock\) => \(lock === 'anthropic' \? claudeClient\(store\.getSettings\(\), createLLM, hooks\.desktopComplete\) : guideLlm\(\)\)/);
  assert.match(main, /getGuide\(\)\.start\(task, 'typed', \{ providerLock: 'anthropic', prior \}\);/);
  assert.match(main, /clearInspection\(\);\n\s+send\('guide:done', \{ offerKeep: false \}\);\n\s+if \(guide && guide\.active\(\)\) guide\.dismiss\('replaced-by-walkthrough'\);/, 'the snapshot is dropped before the walkthrough starts');
  assert.match(main, /\.\.\.\(guideIntent \? \[\{ id: 'walkthrough', label: 'Walk me through it' \}\] : \[\]\)/);
  assert.match(main, /Walk me through it takes a fresh screen picture at each step and sends it to Claude\. /, 'one inline sentence, no repeated prompts');
  assert.match(main, /if \(p && p\.action === 'walkthrough'\) \{ startWalkthroughFromSelection\(\); return; \}/);
  assert.match(main, /\.\.\.\(pausedWalkthrough \? \[\{ id: 'resume-walkthrough', label: 'Resume walkthrough' \}\] : \[\]\)/);
});

test('the app the user was just in still counts while the Knot has focus (replay miss, 2026-09-10)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'guide', 'session.js'), 'utf8');
  const main = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.match(src, /const FOREGROUND_MEMORY_MS = 15000;/);
  assert.match(src, /if \(fg && fg\.hwnd\) \{ this\.lastFg = \{ fg, at: this\.d\.now\(\) \}; return fg; \}/);
  assert.match(src, /const remembered = typeof this\.d\.lastForeground === 'function' \? this\.d\.lastForeground\(\) : null;/);
  assert.match(main, /const FOREGROUND_POLL_TICKS = 8;/);
  assert.match(main, /probe\.request\('fg', \{ ignorePid: process\.pid \}, 1500\)\.then\(\(fg\) => \{ if \(fg && fg\.hwnd && fg\.pid !== process\.pid\) lastForeground = \{ fg, at: Date\.now\(\) \}; \}\)/);
  assert.match(main, /lastForeground: \(\) => lastForeground,/);
});
