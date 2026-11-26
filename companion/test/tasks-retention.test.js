'use strict';
// Keeping task data in bounds: compaction at boot (finished tasks past an age or
// a count leave the journal and the events file) and the delete Home offers (a
// running task stops, then memory and files go, then the overlay's list empties).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const consent = require('../src/hands/consent');
const { HandsAgent } = require('../src/hands/agent');
const { createJournal, RETENTION } = require('../src/tasks/journal');
const { createSupervisor, CLEAR_WAIT_MS } = require('../src/tasks/supervisor');
const { createHandsExecutor } = require('../src/tasks/executors/hands');
const { createProjects, contextFor } = require('../src/tasks/projects');
const { createSurface } = require('../src/tasks/surface');

const root = path.resolve(__dirname, '..', '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'nus-retain-')); }
const tick = () => new Promise((r) => setImmediate(r));
async function settle(n = 12) { for (let i = 0; i < n; i++) await tick(); }
const DAY = 24 * 3600 * 1000;
const START = Date.parse('2026-01-01T12:00:00Z');

function clock(start = START) {
  let t = start;
  const fn = () => new Date(t).toISOString();
  fn.ms = () => t;
  fn.tick = (ms) => { t += ms; };
  return fn;
}
// Timers that fire only when told to.
function fakeTimers() {
  const list = [];
  return { setTimer: (fn, ms) => { const h = { fn, ms }; list.push(h); return h; }, clearTimer: (h) => { const i = list.indexOf(h); if (i >= 0) list.splice(i, 1); }, fire: (ms) => { for (const h of list.filter((x) => x.ms === ms)) { list.splice(list.indexOf(h), 1); h.fn(); } }, get pending() { return list.length; } };
}
// An executor that does what its task's request says: 'wait' sits until the
// signal, 'hang' never returns, 'fail' fails in a way worth a retry, and anything else is done.
function executor() {
  const ex = {
    name: 'fake', started: [], late: null,
    canRun: (t) => t.executor === 'fake',
    async run(task, ctx) {
      ex.started.push(task.request);
      ctx.emit('started', {});
      ctx.emit('step', { n: 1, line: 'Working on ' + task.request });
      if (task.request.startsWith('wait')) { await new Promise((resolve) => ctx.signal.addEventListener('abort', resolve, { once: true })); return; }
      if (task.request.startsWith('hang')) { ex.late = (type, data) => ctx.emit(type, data); await new Promise(() => {}); }
      if (task.request.startsWith('fail')) { ctx.emit('failed', { class: 'network', detail: 'offline' }); return; }
      ctx.emit('done', { summary: 'finished ' + task.request });
    },
  };
  return ex;
}
function rig(opts = {}) {
  const dir = opts.dir || tmp();
  const now = opts.now || clock();
  const timers = opts.timers || fakeTimers();
  const journal = createJournal({ dir, now });
  const ex = executor();
  const events = [], logs = [];
  const sup = createSupervisor({ journal, executors: [ex], now: now.ms, setTimer: timers.setTimer, clearTimer: timers.clearTimer, onEvent: (e) => events.push(e), log: (m) => logs.push(m) });
  return { dir, now, timers, journal, ex, sup, events, logs, tasksFile: journal.file, eventsFile: sup.eventsFile };
}
// One finished task, told through the supervisor so it has event lines too.
async function finish(r, request) { const id = r.sup.submit({ request, executor: 'fake' }); await settle(); assert.equal(r.journal.get(id).state, 'applied'); return id; }
const has = (file, words) => fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes(words);

// ---- compaction -----------------------------------------------------------

test('1. the rule is 30 days and 200 tasks', () => {
  assert.deepEqual(RETENTION, { maxAgeDays: 30, maxFinished: 200 });
});

test('2. past the age, a finished task leaves memory, the journal and the events', async () => {
  const r = rig();
  const old = await finish(r, 'old secret ask');
  r.now.tick(29 * DAY);
  const young = await finish(r, 'young ask');
  r.now.tick(1 * DAY + 1000);
  const again = rig({ dir: r.dir, now: r.now });
  assert.deepEqual(again.sup.compact().removed, [old]);
  assert.equal(again.journal.get(old), null);
  assert.equal(again.journal.get(young).request, 'young ask');
  assert.equal(has(again.tasksFile, 'old secret ask'), false);
  assert.equal(has(again.eventsFile, old), false);
  assert.equal(has(again.eventsFile, young), true, 'the kept task keeps its events');
});

test('3. exactly at the age it stays: the age is counted from when it ended', async () => {
  const r = rig();
  const id = r.sup.submit({ request: 'wait a long time', executor: 'fake' });
  await settle();
  r.now.tick(10 * DAY);
  await r.sup.cancel(id);
  r.now.tick(30 * DAY);
  assert.deepEqual(r.journal.compact().removed, [], '40 days after it was asked, 30 after it ended');
  r.now.tick(1);
  assert.deepEqual(r.journal.compact().removed, [id]);
});

test('4. past the count, the oldest go, by when they ended', () => {
  const now = clock();
  const j = createJournal({ dir: tmp(), now });
  const ids = [];
  for (let i = 0; i < 5; i++) { ids.push(j.create({ request: 'ask ' + i })); j.update(ids[i], { state: 'cancelled' }); now.tick(1000); }
  // The first one asked ends last of all, so it is the newest by the rule.
  const late = j.create({ id: 'late', request: 'asked first', createdAt: new Date(START - DAY).toISOString() });
  j.update(late, { state: 'cancelled' });
  assert.deepEqual(j.compact({ maxFinished: 3 }).removed.sort(), [ids[0], ids[1], ids[2]].sort());
  assert.deepEqual(j.list().map((t) => t.id).sort(), [ids[3], ids[4], late].sort());
  assert.deepEqual(j.compact({ maxFinished: 3 }).removed, [], 'and nothing is due a second time');
});

test('5. the default count holds at 200', () => {
  const now = clock();
  const j = createJournal({ dir: tmp(), now });
  for (let i = 0; i < RETENTION.maxFinished + 5; i++) { j.update(j.create({ request: 'ask ' + i }), { state: 'cancelled' }); now.tick(1000); }
  assert.equal(j.compact().removed.length, 5);
  assert.equal(j.list().length, 200);
  assert.equal(j.list()[0].request, 'ask 5');
});

test('6. a task waiting on the person stays at any age, and any failed one counts as over', async () => {
  const now = clock();
  const dir = tmp();
  const j = createJournal({ dir, now });
  const queued = j.create({ request: 'held', held: true });
  const review = j.create({ request: 'to look at' });
  for (const state of ['preparing', 'running', 'verifying', 'review']) j.update(review, { state });
  const interrupted = j.create({ request: 'left mid-flight' });
  for (const state of ['preparing', 'running']) j.update(interrupted, { state });
  j.recover();
  const final = j.create({ request: 'failed for good' });
  j.update(final, { state: 'preparing' });
  j.update(final, { state: 'failed', lastError: { class: 'auth', detail: 'x', retryable: false } });
  const retryable = j.create({ request: 'failed with no retry left' });
  j.update(retryable, { state: 'preparing' });
  j.update(retryable, { state: 'failed', lastError: { class: 'network', detail: 'x', retryable: true } });
  now.tick(400 * DAY);
  assert.deepEqual(j.compact().removed.sort(), [final, retryable].sort());
  assert.deepEqual(j.list().map((t) => t.id).sort(), [queued, review, interrupted].sort());
});

test('7. what is kept replays the same after the rewrite, and the journal carries on', () => {
  const now = clock();
  const dir = tmp();
  const j = createJournal({ dir, now });
  const gone = j.create({ request: 'old' });
  j.update(gone, { state: 'cancelled' });
  now.tick(40 * DAY);
  const kept = j.create({ request: 'keeps its fields', goal: 'a goal', project: { id: 'p', name: 'P' } });
  j.update(kept, { state: 'preparing' });
  j.update(kept, { state: 'running', progress: { n: 3, total: null, line: 'Typing' } });
  const before = j.get(kept);
  j.compact();
  assert.deepEqual(j.get(kept), before);
  assert.equal(fs.readFileSync(j.file, 'utf8').trim().split('\n').length, 1, 'one line a task');
  assert.deepEqual(j.stats(), { records: 1, tasks: 1, skipped: 0 });
  const replay = createJournal({ dir, now });
  assert.deepEqual(replay.get(kept), before);
  assert.equal(replay.update(kept, { state: 'cancelled' }).state, 'cancelled', 'the state machine carries on from the rewritten line');
  assert.equal(createJournal({ dir, now }).get(kept).state, 'cancelled');
});

test('8. with nothing due, neither file is written', async () => {
  const r = rig();
  await finish(r, 'recent');
  const before = [fs.readFileSync(r.tasksFile, 'utf8'), fs.readFileSync(r.eventsFile, 'utf8')];
  const mtime = fs.statSync(r.tasksFile).mtimeMs;
  assert.deepEqual(r.sup.compact().removed, []);
  assert.deepEqual([fs.readFileSync(r.tasksFile, 'utf8'), fs.readFileSync(r.eventsFile, 'utf8')], before);
  assert.equal(fs.statSync(r.tasksFile).mtimeMs, mtime);
});

test('9. boot compacts, and a crash between the two files is tidied next time', async () => {
  const r = rig();
  const old = await finish(r, 'old');
  r.now.tick(31 * DAY);
  const young = await finish(r, 'young');
  // The crash: the journal was rewritten, the events were not, and a .tmp was left.
  r.journal.compact();
  assert.equal(has(r.eventsFile, old), true);
  fs.appendFileSync(r.eventsFile, '{"torn');
  fs.writeFileSync(r.tasksFile + '.tmp', 'old words');
  const again = rig({ dir: r.dir, now: r.now });
  again.sup.boot();
  assert.equal(has(again.eventsFile, old), false);
  assert.equal(has(again.eventsFile, young), true);
  assert.equal(has(again.eventsFile, '{"torn'), false);
  assert.equal(fs.existsSync(again.tasksFile + '.tmp'), false);
  assert.equal(again.sup.events(young).length > 0, true);
});

test('10. a compaction that cannot write never stops a boot', async () => {
  const r = rig();
  const old = await finish(r, 'old');
  r.now.tick(31 * DAY);
  const again = rig({ dir: r.dir, now: r.now });
  const waiting = again.journal.create({ request: 'wait here', executor: 'fake' });
  fs.mkdirSync(again.tasksFile + '.tmp/blocked', { recursive: true });   // a folder where the temp file goes
  assert.deepEqual(again.sup.boot(), []);
  assert.ok(again.logs.some((m) => /^compact failed/.test(m)), again.logs.join());
  assert.equal(again.journal.get(old).request, 'old', 'memory still matches the file');
  assert.equal(has(again.tasksFile, 'old'), true);
  await settle();
  assert.equal(again.journal.get(waiting).state, 'running', 'and the queue still starts');
});

test('11. a project outlives the tasks that fed it', async () => {
  const r = rig();
  const projects = createProjects({ dir: r.dir, now: r.now });
  const id = await finish(r, 'write the list');
  const p = projects.keep(r.journal.get(id), { name: 'Groceries' });
  r.now.tick(31 * DAY);
  assert.deepEqual(r.sup.compact().removed, [id]);
  const after = createProjects({ dir: r.dir, now: r.now });
  assert.equal(after.find('Groceries').id, p.id);
  assert.match(contextFor(after.find('Groceries')).goal, /write the list/);
});

// ---- delete ----------------------------------------------------------------

test('12. a delete cancels what is running, starts nothing queued, and empties everything', async () => {
  const r = rig();
  const projects = createProjects({ dir: r.dir, now: r.now });
  const done = await finish(r, 'finished one');
  projects.keep(r.journal.get(done), { name: 'Kept' });
  const running = r.sup.submit({ request: 'wait while running', executor: 'fake' });
  const queued = r.sup.submit({ request: 'queued behind it', executor: 'fake' });
  await settle();
  assert.equal(r.sup.running().id, running);
  // The cancel lands while the files are still there, so it cannot write after them.
  let filesAtCancel = null;
  r.sup.on((e) => { if (e.type === 'cancelled') filesAtCancel = fs.existsSync(r.tasksFile); });
  await r.sup.clear();
  projects.clear();
  assert.equal(filesAtCancel, true);
  assert.deepEqual(r.events.filter((e) => e.id === running && e.type === 'cancelled').map((e) => e.data.reason), ['deleted']);
  assert.equal(r.ex.started.includes('queued behind it'), false);
  assert.equal(r.sup.running(), null);
  assert.deepEqual(r.journal.list(), []);
  assert.equal(r.journal.get(queued), null);
  assert.deepEqual(r.journal.stats(), { records: 0, tasks: 0, skipped: 0 });
  assert.deepEqual(projects.list(), []);
  assert.equal(projects.newest(), null);
  for (const f of [r.tasksFile, r.eventsFile, projects.file]) assert.equal(fs.existsSync(f), false, f);
  // A restart finds nothing, and the system still works.
  assert.deepEqual(createJournal({ dir: r.dir, now: r.now }).list(), []);
  assert.deepEqual(createProjects({ dir: r.dir, now: r.now }).list(), []);
  const next = await finish(r, 'after the delete');
  assert.equal(r.journal.list().length, 1);
  assert.equal(has(r.tasksFile, 'wait while running'), false);
  assert.equal(r.sup.events(next).length > 0, true);
  assert.equal(projects.keep(r.journal.get(next), { name: 'New' }).name, 'New');
  assert.equal(has(projects.file, 'Kept'), false);
});

test('13. an executor that never answers does not hold the delete, and cannot write afterwards', async () => {
  const r = rig();
  r.sup.submit({ request: 'hang forever', executor: 'fake' });
  await settle();
  const clearing = r.sup.clear();
  await settle();
  assert.ok(fs.existsSync(r.tasksFile), 'it waits first');
  r.timers.fire(CLEAR_WAIT_MS);
  await clearing;
  assert.equal(fs.existsSync(r.tasksFile), false);
  assert.equal(r.sup.running(), null);
  r.ex.late('step', { n: 2, line: 'Still going' });
  r.ex.late('done', { summary: 'too late' });
  await settle();
  assert.equal(fs.existsSync(r.tasksFile), false);
  assert.equal(fs.existsSync(r.eventsFile), false);
  assert.equal(r.timers.pending, 0);
});

test('14. a retry waiting on its timer is dropped, and does not come back', async () => {
  const r = rig();
  const id = r.sup.submit({ request: 'fail once', executor: 'fake' });
  await settle();
  assert.equal(r.journal.get(id).state, 'failed');
  assert.equal(r.timers.pending, 1);
  await r.sup.clear();
  assert.equal(r.timers.pending, 0);
  assert.deepEqual(r.journal.list(), []);
  assert.equal(fs.existsSync(r.eventsFile), false);
});

test('15. a delete with nothing running, and a second one, are fine; a leftover .tmp goes too', async () => {
  const r = rig();
  const projects = createProjects({ dir: r.dir, now: r.now });
  fs.writeFileSync(r.tasksFile + '.tmp', 'words');
  fs.writeFileSync(r.eventsFile + '.tmp', 'words');
  fs.writeFileSync(projects.file + '.tmp', 'words');
  await r.sup.clear();
  projects.clear();
  await r.sup.clear();
  projects.clear();
  assert.deepEqual(fs.readdirSync(r.dir), []);
});

test('16. a real Hands task on a consent card: the card goes, nothing is pressed, and the list empties', async () => {
  const dir = tmp();
  const pending = consent.createPending();
  const clicked = [], sent = [];
  const replies = ['Submitting it. [DO:click {"id": 2}] [DONE]'];
  const agent = new HandsAgent({
    read: async () => ({ fg: { title: 'Canvas', process: 'chrome' }, cap: null, elements: [{ id: 2, name: 'Submit Assignment', type: 'Button', rect: { x: 1, y: 1, w: 9, h: 9 } }], originPhys: { x: 0, y: 0 } }),
    llm: () => ({ ready: true, provider: 'test', async complete(p) { const n = replies.shift(); if (n === undefined) return new Promise(() => {}); if (p.onDelta) p.onDelta(n); return n; } }),
    actions: { findElement: (q, els) => els[0], async run(name) { clicked.push(name); return { ok: true, report: 'done', settle: 0 }; } },
    consent: { preview: consent.preview, pending }, send: (c, p) => sent.push([c, p]), speak: () => {}, watcher: { async waitForChange() { return { changed: true }; } },
    fingerprint: () => new Uint8Array(4), retract: () => {}, log: () => {}, sleep: async () => {}, onActive: () => {},
  });
  const journal = createJournal({ dir });
  const overlay = [];
  const surface = createSurface({ send: (ch, p) => overlay.push([ch, p]) });
  const sup = createSupervisor({ journal, executors: [createHandsExecutor({ agent: () => agent })], setTimer: () => ({}), clearTimer: () => {}, onEvent: (ev) => surface.onEvent(ev, journal.get(ev.id)) });
  sup.submit({ request: 'submit lab 3', source: 'typed', executor: 'hands' });
  await settle();
  assert.notEqual(pending.current(), null);
  await sup.clear({ waitMs: 1000 });
  assert.equal(pending.current(), null);
  assert.equal(agent.active(), false);
  assert.deepEqual(clicked, []);
  assert.equal(fs.existsSync(journal.file), false);
  surface.sync(journal.list(), { enabled: true });
  const [ch, last] = overlay[overlay.length - 1];
  assert.equal(ch, 'tasks:event');
  assert.equal(last.type, 'sync');
  assert.deepEqual(last.tasks, []);
  assert.equal(last.enabled, true);
});

// ---- the wires -------------------------------------------------------------

test('17. Home to main to the stores, confirmed first, and in that order', () => {
  const html = read('companion/home/index.html'), home = read('companion/home/home.js'), main = read('companion/index.js');
  assert.ok(html.indexOf('id="tasks"') < html.indexOf('id="tasks-delete"'), 'by the switch');
  assert.ok(html.indexOf('id="tasks-delete"') < html.indexOf('id="focus-feeds"'), 'in the same card');
  assert.match(home, /\$\('#tasks-delete'\)\.onclick=e=>run\(async\(\)=>\{.*if\(!confirm\('Delete all tasks and projects\?.*'\)\)return;await api\.tasksDelete\(\)/);
  assert.match(read('companion/home/preload.js'), /tasksDelete: \(\) => invoke\('tasks:delete'\)/);
  assert.match(read('src/main-companion.js'), /handle\('home:tasks:delete', \(\) => companion\.deleteTaskData\(\)\)/);
  assert.match(main, /^\s+deleteTaskData,$/m);
  const body = main.slice(main.indexOf('async function deleteTaskData()'));
  const order = ['T.supervisor.clear()', 'T.projects.clear()', "stopHands('deleted')", 'agent.last = null', "'hands.log'", 'getTasks().sync()', "send('tasks:event', { type: 'sync', enabled: false, tasks: [] })"].map((s) => body.indexOf(s));
  assert.ok(order.every((n) => n >= 0), order.join());
  assert.deepEqual(order, order.slice().sort((a, b) => a - b));
  assert.match(main, /if \(tasksOn\(\)\) getTasks\(\); else compactTasksOff\(\);/);
});

test('18. the words say what the code does, and nothing claims a wipe that does not exist', () => {
  const html = read('companion/home/index.html'), home = read('companion/home/home.js'), main = read('companion/index.js');
  const start = html.indexOf('id="tasks-delete"');
  const copy = html.slice(start, html.indexOf('tasks-delete-note', start));
  assert.ok(copy.includes(RETENTION.maxAgeDays + ' days'));
  assert.ok(copy.includes('latest ' + RETENTION.maxFinished));
  assert.ok(copy.includes('Hands log'));
  const line = home.split('\n').find((l) => l.includes("$('#tasks-delete').onclick"));
  for (const s of [copy, line]) assert.ok(!s.includes('—'), 'no em dash');
  assert.ok(!/data wipe/i.test(main), 'the comment by handsLog no longer promises one');
  assert.match(main.slice(main.indexOf('// What Hands did, step by step'), main.indexOf('function handsLog')), /Delete all tasks and projects/);
  const doc = read('docs/tasks-core.md');
  assert.ok(!doc.includes('No delete for task data'));
});
