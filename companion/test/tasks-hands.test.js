'use strict';
// Hands as the first task executor: the adapter round an unchanged HandsAgent
// under the supervisor, with a fake model. The flag off leaves the shipped
// routing alone; on, a Hands ask is journaled from queued to applied, its
// card is a needs-you event answered through the agent's own store, Esc
// cancels it with a measured time, and "keep going" carries the same task on.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const consent = require('../src/hands/consent');
const { HandsAgent } = require('../src/hands/agent');
const { createJournal } = require('../src/tasks/journal');
const { createSupervisor } = require('../src/tasks/supervisor');
const { createHandsExecutor, stepLine } = require('../src/tasks/executors/hands');
const { createSurface, snapshot } = require('../src/tasks/surface');

const root = path.resolve(__dirname, '..', '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'nus-tasks-hands-')); }
const tick = () => new Promise((r) => setImmediate(r));
async function settle(n = 6) { for (let i = 0; i < n; i++) await tick(); }

const ELEMENTS = [
  { id: 1, name: 'Insert', type: 'TabItem', rect: { x: 100, y: 40, w: 60, h: 24 } },
  { id: 2, name: 'Submit Assignment', type: 'Button', rect: { x: 500, y: 600, w: 160, h: 40 } },
  { id: 7, name: 'Comment', type: 'Edit', rect: { x: 100, y: 500, w: 400, h: 60 } },
];
const CAP = { dataUrl: 'data:image/jpeg;base64,AAAA', width: 1280, height: 720 };

// A HandsAgent with every dependency faked, the way hands.test.js builds one.
function agentRig(replies, opts = {}) {
  const sent = [], spoken = [], logs = [], acted = [], active = [];
  const pending = consent.createPending();
  const clock = opts.clock || { t: 1000 };
  const actions = {
    findElement: (q, els) => els.find((e) => (q.id != null && e.id === Number(q.id)) || (q.text && e.name.toLowerCase().includes(String(q.text).toLowerCase()))) || null,
    async run(name, args) { acted.push([name, args]); return { ok: true, report: 'done', settle: 0 }; },
  };
  const agent = new HandsAgent({
    read: async () => ({ fg: { title: 'Canvas - Chrome', process: 'chrome' }, cap: CAP, elements: ELEMENTS, originPhys: { x: 0, y: 0 } }),
    llm: () => ({ ready: true, provider: 'test', async complete(p) { const next = replies.shift(); if (next === undefined) throw new Error('model timed out'); if (p.onDelta) p.onDelta(next); return next; } }),
    actions, consent: { preview: consent.preview, pending },
    send: (ch, p) => sent.push([ch, p]), speak: (t, first) => spoken.push([t, first]),
    watcher: { async waitForChange() { return { changed: true, settled: true }; } },
    fingerprint: () => new Uint8Array(4), retract: () => sent.push(['retract']), log: (m) => logs.push(m), sleep: async () => {}, now: () => clock.t,
    onActive: (on) => active.push(on), ...(opts.maxSteps ? { maxSteps: opts.maxSteps } : {}),
  });
  return { agent, sent, spoken, logs, pending, acted, active, clock };
}
const last = (sent, ch) => { const m = sent.filter(([c]) => c === ch); return m.length ? m[m.length - 1][1] : null; };

function rig(replies, opts = {}) {
  const a = agentRig(replies, opts);
  const journal = createJournal({ dir: tmp(), now: () => new Date(a.clock.t).toISOString() });
  const overlay = [];
  const surface = createSurface({ send: (ch, p) => overlay.push([ch, p]), now: () => a.clock.t });
  const events = [];
  const timers = [];
  const hands = createHandsExecutor({ agent: () => a.agent, now: () => a.clock.t, setTimer: (fn, ms) => { const h = { fn, ms }; timers.push(h); return h; }, clearTimer: (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); } });
  const sup = createSupervisor({ journal, executors: [hands], now: () => a.clock.t, setTimer: (fn, ms) => { const h = { fn, ms }; timers.push(h); return h; }, clearTimer: () => {}, onEvent: (ev) => { events.push(ev); surface.onEvent(ev, journal.get(ev.id)); } });
  return Object.assign(a, { journal, sup, hands, events, overlay, timers, types: (id) => events.filter((e) => e.id === id).map((e) => e.type) });
}

test('1. with the flag off the shipped routing is untouched: Hands takes the ask straight, and agent.js is not required by the adapter for anything new', () => {
  const main = read('companion/index.js');
  assert.match(main, /function tasksOn\(\) \{ return store\.getSettings\(\)\.tasks === true \|\| process\.env\.NUS_TASKS === '1'; \}/);
  assert.match(main, /if \(tasksOn\(\)\) \{ submitHandsTask\(kind\.text, source\); return; \}\n\s*getAgent\(\)\.run\(kind\.text, source === 'typed' \? 'typed' : 'voice', \{ askedAt: heardAt \}\); return;/, 'off, the very next line is the old call');
  assert.match(main, /agent\.active\(\) && tasksOn\(\) && handsOn\(\) && !roomMic && isTask\(kind\.text\)/, 'a second ask queues only with the flag on, and never from the open mic');
  assert.match(read('companion/src/store.js'), /\n  tasks: false,/, 'off by default');
  assert.match(main, /const OVERLAY_BOOLEANS = new Set\(\[[^\]]*'tasks'/, 'the overlay may set it');
  assert.match(read('src/main-companion.js'), /for \(const key of \[[^\]]*'tasks'[^\]]*\]\) if \(typeof patch\[key\] === 'boolean'\)/, 'Home may set it');
  assert.match(read('companion/home/index.html'), /<input id="tasks" type="checkbox">Task list \(beta\)/);
  assert.match(read('companion/preload.js'), /'tasks:event'/, 'the one channel the renderer may hear');
  // Esc, "stop" and a dismiss all go through stopHands, which is the agent when there is no task.
  assert.match(main, /function stopHands\(reason\) \{\s*const t = tasks && tasks\.running\(\);\s*if \(t && t\.executor === 'hands'\) \{ tasks\.cancel\(t\.id, reason\)/);
  assert.match(main, /if \(agent && agent\.active\(\)\) stopHands\('esc'\)/);
  assert.match(main, /else if \(agent && agent\.active\(\)\) stopHands\('voice'\);/);
  assert.doesNotMatch(main, /agent\.stop\((?!reason\))/, 'no direct agent.stop left outside stopHands');
  // The adapter wraps the agent's dependencies; agent.js itself has no idea tasks exist.
  assert.doesNotMatch(read('companion/src/hands/agent.js'), /task(s)?\/|supervisor|journal/i);
  assert.match(read('companion/src/tasks/executors/hands.js'), /require\('\.\.\/\.\.\/hands\/agent'\)/);
});

test('2. the on path: a Hands run with a fake model is journaled from queued through running to applied, with verb lines, never the prose', async () => {
  const r = rig([
    '[GOAL: open lab 3 on canvas] Heading to Canvas. [DO:open_url {"url": "https://canvas.test"}]',
    'Opening the assignment now. [DO:click {"id": 1}] [DONE]',
  ]);
  const id = r.sup.submit({ request: 'go to canvas and open lab 3', source: 'voice', executor: 'hands' });
  await settle(20);
  const t = r.journal.get(id);
  assert.equal(t.state, 'applied');
  assert.deepEqual(r.types(id), ['queued', 'preparing', 'started', 'step', 'step', 'done']);
  const steps = r.events.filter((e) => e.id === id && e.type === 'step').map((e) => e.data);
  assert.deepEqual(steps, [{ n: 1, total: null, line: 'Opening a page' }, { n: 2, total: null, line: 'Clicking "Insert"' }], 'Hands does not know its steps: its budget is a cap');
  for (const s of steps) assert.doesNotMatch(s.line, /Heading|assignment/, 'the model\'s prose never reaches a step line');
  assert.equal(t.artifacts.summary, 'Opening the assignment now.');
  assert.equal(t.goal, 'open lab 3 on canvas', 'the goal the model worked out is kept for a resume');
  assert.equal(t.progress.n, 2);
  assert.equal(typeof t.metrics.first_progress, 'number');
  assert.equal(r.acted.length, 2, 'the real action path ran');
  assert.equal(last(r.sent, 'guide:bubble').kicker, 'done', 'the agent painted its own done bubble');
  // The surface sent only the task events for a Hands task: no second bubble, no second state.
  assert.ok(r.overlay.every(([ch]) => ch === 'tasks:event'), 'Hands paints for itself');
  const ev = r.overlay.find(([, p]) => p.type === 'done')[1];
  assert.equal(ev.task.state, 'applied'); assert.equal(ev.task.summary, 'Opening the assignment now.'); assert.equal(ev.task.request, 'go to canvas and open lab 3');
  assert.ok(!('artifacts' in ev.task) && !('consent' in ev.task), 'the snapshot carries no raw fields');
  assert.deepEqual(r.active, [true, false]);
});

test('3. a risky click is a needs-you event; the Knot\'s own Yes button answers it; Not now through the supervisor ends the task as declined', async () => {
  const yes = rig(['Submitting it. [DO:click {"id": 2}] [DONE]']);
  const a = yes.sup.submit({ request: 'submit lab 3', source: 'typed', executor: 'hands' });
  await settle(6);
  assert.equal(yes.journal.get(a).state, 'needs_input');
  const q = yes.journal.get(a).question;
  assert.equal(q.kind, 'consent'); assert.match(q.text, /Submit Assignment/);
  assert.deepEqual(q.options.map((o) => o.id), ['hands-yes', 'hands-no']);
  const card = last(yes.sent, 'guide:bubble');
  assert.equal(card.kicker, 'ask first', 'the Knot\'s card is the agent\'s, as today');
  assert.equal(yes.agent.answer(true), true, 'the button path index.js already has');
  await settle(10);
  assert.equal(yes.journal.get(a).state, 'applied');
  assert.deepEqual(yes.types(a), ['queued', 'preparing', 'started', 'needs_input', 'answered', 'step', 'done']);
  assert.deepEqual(yes.journal.get(a).consent[0].answer, true);
  assert.equal(yes.journal.get(a).consent[0].how, 'button');

  const no = rig(['Submitting it. [DO:click {"id": 2}] [DONE]']);
  const b = no.sup.submit({ request: 'submit lab 3', source: 'voice', executor: 'hands' });
  await settle(6);
  assert.equal(no.sup.answer(b, false, 'button'), true, 'the pill\'s Not now goes through the supervisor to the agent\'s store');
  await settle(10);
  assert.equal(no.journal.get(b).state, 'cancelled');
  assert.equal(no.events.find((e) => e.id === b && e.type === 'cancelled').data.reason, 'declined');
  assert.equal(no.acted.length, 0, 'nothing clicked');
  // A spoken yes still answers through the agent, as today.
  const spoken = rig(['Submitting it. [DO:click {"id": 2}] [DONE]']);
  const c = spoken.sup.submit({ request: 'submit lab 3', source: 'voice', executor: 'hands' });
  await settle(6);
  assert.equal(spoken.agent.spoken('yes go ahead'), 'yes');
  await settle(10);
  assert.equal(spoken.journal.get(c).state, 'applied');
  assert.equal(spoken.journal.get(c).consent[0].how, 'voice');
});

test('4. Esc cancels through the supervisor: the agent stops quietly, the model request is cut, and the journal holds the measured time', async () => {
  let release = null;
  const r = rig([]);
  r.agent.d.llm = () => ({ ready: true, provider: 'test', complete: (p) => new Promise((resolve, reject) => { release = resolve; if (p.signal) p.signal.addEventListener('abort', () => reject(new Error('aborted'))); }) });
  const id = r.sup.submit({ request: 'do a long thing', source: 'typed', executor: 'hands' });
  await settle(6);
  assert.equal(r.journal.get(id).state, 'running');
  assert.ok(release, 'the model is mid-request');
  const p = r.sup.cancel(id, 'esc');
  r.clock.t += 40;
  const ms = await p;
  assert.equal(ms, 40);
  const t = r.journal.get(id);
  assert.equal(t.state, 'cancelled'); assert.equal(t.metrics.cancel, 40);
  assert.equal(r.agent.active(), false);
  assert.ok(r.logs.some((m) => m === 'stop: esc'), 'the reason reached the agent');
  const bubbles = r.sent.filter(([c, p]) => c === 'guide:bubble' && p.text);
  assert.equal(bubbles.length, 0, 'Esc is silent, as today');
  assert.deepEqual(r.types(id), ['queued', 'preparing', 'started', 'cancelled']);
  // A stop that reached the agent directly (a new ask) is still journaled, without a time.
  const d = rig([]);
  d.agent.d.llm = () => ({ ready: true, provider: 'test', complete: (p) => new Promise((resolve, reject) => { if (p.signal) p.signal.addEventListener('abort', () => reject(new Error('aborted'))); }) });
  const did = d.sup.submit({ request: 'another long thing', source: 'typed', executor: 'hands' });
  await settle(4);
  d.agent.stop('voice');
  await settle(8);
  assert.equal(d.journal.get(did).state, 'cancelled');
  assert.equal(d.events.find((e) => e.id === did && e.type === 'cancelled').data.ms, null);
});

test('5. out of steps, the task parks on Keep going; "keep going" said to the host carries the same task on; Stop ends it as done', async () => {
  const r = rig([
    '[GOAL: tidy the folder] Step one. [DO:wait {"seconds": 1}]',
    'Step two. [DO:wait {"seconds": 1}]',
    'Step three. [DO:wait {"seconds": 1}] [DONE]',
  ], { maxSteps: 2 });
  const id = r.sup.submit({ request: 'tidy my downloads folder', source: 'typed', executor: 'hands' });
  await settle(14);
  let t = r.journal.get(id);
  assert.equal(t.state, 'needs_input');
  assert.equal(t.question.kind, 'keep_going');
  assert.match(t.question.text, /keep going/);
  assert.deepEqual(t.question.options.map((o) => o.label), ['Keep going', 'Stop']);
  assert.equal(r.agent.canResume(), true);
  // index.js's own path: agent.resume() on the words "keep going".
  assert.equal(await r.agent.resume('voice'), true);
  await settle(14);
  t = r.journal.get(id);
  assert.equal(t.state, 'applied');
  assert.equal(t.goal, 'tidy the folder');
  assert.deepEqual(r.types(id), ['queued', 'preparing', 'started', 'step', 'step', 'needs_input', 'answered', 'step', 'done']);
  assert.equal(r.events.find((e) => e.id === id && e.type === 'answered').data.value, true);
  assert.equal(r.sup.list().length, 1, 'the same task, not a second one');

  const s = rig(['[GOAL: x] One. [DO:wait {"seconds": 1}]', 'Two. [DO:wait {"seconds": 1}]'], { maxSteps: 1 });
  const sid = s.sup.submit({ request: 'a long thing', source: 'typed', executor: 'hands' });
  await settle(10);
  assert.equal(s.journal.get(sid).state, 'needs_input');
  assert.equal(s.sup.answer(sid, false, 'button'), true);
  await settle(6);
  assert.equal(s.journal.get(sid).state, 'applied');
  assert.equal(s.events.find((e) => e.id === sid && e.type === 'done').data.outcome, 'budget');
  // The pill's Keep going button resumes through the supervisor too.
  const k = rig(['[GOAL: x] One. [DO:wait {"seconds": 1}]', 'Two. [DO:wait {"seconds": 1}] [DONE]'], { maxSteps: 1 });
  const kid = k.sup.submit({ request: 'a long thing', source: 'typed', executor: 'hands' });
  await settle(10);
  assert.equal(k.sup.answer(kid, true, 'button'), true);
  await settle(14);
  assert.equal(k.journal.get(kid).state, 'applied');
  assert.equal(k.journal.get(kid).consent[0].how, 'button', 'and it says how it was answered');
  // Left alone, the hold expires with the agent's own resume window and the task is done as far as it got.
  const e = rig(['[GOAL: x] One. [DO:wait {"seconds": 1}]'], { maxSteps: 1 });
  const eid = e.sup.submit({ request: 'x', source: 'typed', executor: 'hands' });
  await settle(10);
  const hold = e.timers.find((h) => h.ms === 5 * 60 * 1000);
  assert.ok(hold, 'the hold has a timer on the resume window');
  hold.fn();
  await settle(6);
  assert.equal(e.journal.get(eid).state, 'applied');
});

test('6. a model failure is a final failure, never retried on the screen; the second ask waits its turn', async () => {
  const r = rig([]);
  const id = r.sup.submit({ request: 'x', source: 'typed', executor: 'hands' });
  await settle(10);
  const t = r.journal.get(id);
  assert.equal(t.state, 'failed');
  assert.equal(t.lastError.class, 'timeout');
  assert.equal(t.lastError.retryable, false);
  assert.equal(r.timers.filter((h) => h.ms === 5000).length, 0, 'no retry timer');
  const q = rig(['Opening it. [DO:click {"id": 1}] [DONE]', 'Opening it. [DO:click {"id": 1}] [DONE]']);
  const a = q.sup.submit({ request: 'one', source: 'typed', executor: 'hands' });
  const b = q.sup.submit({ request: 'two', source: 'typed', executor: 'hands' });
  assert.equal(q.journal.get(b).state, 'queued');
  await settle(24);
  assert.equal(q.journal.get(a).state, 'applied'); assert.equal(q.journal.get(b).state, 'applied');
  assert.deepEqual(q.active, [true, false, true, false], 'one agent run after the other');
});

test('6b. a Hands task still queued when the app closed never starts by itself: it waits for release', async () => {
  const dir = tmp();
  const first = agentRig([]);
  first.agent.d.llm = () => ({ ready: true, provider: 'test', complete: () => new Promise(() => {}) });
  const j1 = createJournal({ dir });
  const s1 = createSupervisor({ journal: j1, executors: [createHandsExecutor({ agent: () => first.agent })] });
  const running = s1.submit({ request: 'first', source: 'typed', executor: 'hands' });
  const queued = s1.submit({ request: 'second', source: 'typed', executor: 'hands' });
  await settle(4);
  // The app dies here; the next launch has a fresh agent and a fresh journal.
  const next = agentRig(['Opening it. [DO:click {"id": 1}] [DONE]']);
  const j2 = createJournal({ dir });
  const s2 = createSupervisor({ journal: j2, executors: [createHandsExecutor({ agent: () => next.agent })] });
  assert.deepEqual(s2.boot().map((t) => t.id), [running]);
  await settle(8);
  assert.equal(j2.get(queued).state, 'queued');
  assert.equal(j2.get(queued).held, true);
  assert.equal(next.active.length, 0, 'the agent never ran');
  assert.equal(s2.running(), null);
  const fresh = s2.submit({ request: 'a new ask', source: 'typed', executor: 'hands' });
  await settle(10);
  assert.equal(j2.get(fresh).state, 'applied', 'a held task does not block a new ask');
  assert.equal(j2.get(queued).state, 'queued');
  next.agent.d.llm = () => ({ ready: true, provider: 'test', async complete() { return 'Opening it. [DO:click {"id": 1}] [DONE]'; } });
  assert.equal(s2.release(queued), true);
  await settle(10);
  assert.equal(j2.get(queued).state, 'applied');
  assert.equal(s2.release(queued), false);
});

test('6c. an interrupted Hands task resumes with its goal and how far it got, and the model is told not to redo it', async () => {
  const dir = tmp();
  const a = agentRig(['[GOAL: write the list] Opening it. [DO:open_app {"name": "Notepad"}]', 'Typing. [DO:wait {"seconds": 1}]']);
  const prompts = [];
  const replies = ['[GOAL: write the list] Opening it. [DO:open_app {"name": "Notepad"}]'];
  a.agent.d.llm = () => ({ ready: true, provider: 'test', complete: (p) => { prompts.push(p); const n = replies.shift(); return n ? Promise.resolve(n) : new Promise(() => {}); } });
  const j1 = createJournal({ dir });
  const s1 = createSupervisor({ journal: j1, executors: [createHandsExecutor({ agent: () => a.agent })] });
  const id = s1.submit({ request: 'write my list in notepad', source: 'typed', executor: 'hands' });
  await settle(10);
  assert.equal(j1.get(id).progress.n, 1);
  const b = agentRig(['Back on it. [DO:click {"id": 1}] [DONE]']);
  const seen = [];
  const complete = b.agent.d.llm().complete;
  b.agent.d.llm = () => ({ ready: true, provider: 'test', complete: (p) => { seen.push(p.turns[0].text); return complete(p); } });
  const j2 = createJournal({ dir });
  const s2 = createSupervisor({ journal: j2, executors: [createHandsExecutor({ agent: () => b.agent })] });
  s2.boot();
  assert.equal(j2.get(id).state, 'interrupted');
  assert.equal(s2.resume(id), true);
  await settle(12);
  const t = j2.get(id);
  assert.equal(t.state, 'applied');
  assert.match(seen[0], /Goal: write the list/);
  assert.match(seen[0], /last step was: Opening Notepad/);
  assert.equal(t.progress.n, 2, 'the step count carries on');
});

test('7. step lines name the control, never the words typed; the surface paints for an executor that does not', () => {
  const agent = { d: { actions: { findElement: (q, els) => els.find((e) => e.id === Number(q.id)) || null } } };
  assert.equal(stepLine({ name: 'type', args: { id: 7, text: 'my secret essay' } }, { elements: ELEMENTS }, agent), 'Typing into "Comment"');
  assert.equal(stepLine({ name: 'click', args: { id: 2 } }, { elements: ELEMENTS }, agent), 'Clicking "Submit Assignment"');
  assert.equal(stepLine({ name: 'press', args: { keys: 'ctrl+s' } }, {}, agent), 'Pressing ctrl+s');
  assert.equal(stepLine({ name: 'open_app', args: { name: 'Notepad' } }, {}, agent), 'Opening Notepad');
  assert.equal(stepLine({ name: 'web_search', args: { query: 'private thing' } }, {}, agent), 'Searching the web');
  assert.equal(stepLine({ name: 'find_files', args: { query: 'tax return' } }, {}, agent), 'Looking for a file');
  const out = [];
  const s = createSurface({ send: (ch, p) => out.push([ch, p]), now: () => 5000 });
  const task = { id: 't1', createdAt: 'x', state: 'running', source: 'voice', executor: 'code', request: 'fix the test', goal: 'make npm test pass', artifacts: {}, attempt: 1, maxAttempts: 2 };
  s.onEvent({ type: 'started', id: 't1', data: {}, state: 'running' }, task);
  assert.deepEqual(out.map(([c]) => c), ['tasks:event', 'guide:state', 'guide:hint']);
  assert.equal(out[2][1].text, 'On it: make npm test pass');
  s.onEvent({ type: 'needs_input', id: 't1', data: { id: 'q1', kind: 'consent', text: 'Work in nus-site?', options: [{ id: 'yes', label: 'Yes', primary: true }, { id: 'no', label: 'Not now' }] }, state: 'needs_input' }, task);
  const card = last(out, 'guide:bubble');
  assert.deepEqual(card.actions, [{ id: 'task-yes', label: 'Yes', primary: true }, { id: 'task-no', label: 'Not now', primary: false }]);
  assert.equal(card.sessionId, 'task:t1'); assert.equal(card.speak, 'Work in nus-site?');
  s.onEvent({ type: 'review', id: 't1', data: { summary: 'Changed 2 files.' }, state: 'review' }, task);
  assert.deepEqual(last(out, 'guide:bubble').actions.map((a) => a.id), ['task-apply', 'task-discard']);
  s.onEvent({ type: 'failed', id: 't1', data: { class: 'auth', detail: 'not signed in' }, state: 'failed' }, task);
  assert.equal(last(out, 'guide:bubble').kind, 'error');
  assert.match(last(out, 'guide:bubble').text, /could not finish: not signed in/);
  const snap = snapshot({ id: 'a', createdAt: 'c', state: 'review', source: 'typed', executor: 'code', request: 'r', artifacts: { summary: 's', patch: 'C:\\secret\\p.patch' }, session: { id: 'sess' }, project: { name: 'site', root: 'C:\\x' }, lastError: null, attempt: 1, maxAttempts: 2 });
  assert.equal(snap.summary, 's'); assert.deepEqual(snap.project, { name: 'site' });
  assert.ok(!('session' in snap) && !JSON.stringify(snap).includes('C:\\\\'), 'no paths, no session ids');
  s.sync([task]);
  assert.equal(last(out, 'tasks:event').type, 'sync'); assert.equal(last(out, 'tasks:event').tasks.length, 1);
});
