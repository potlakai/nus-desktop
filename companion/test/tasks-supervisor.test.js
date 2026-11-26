'use strict';
// The task supervisor with a fake executor: the one-slot FIFO queue, the
// event shapes, needs_input and its answer, review and done, retries with
// backoff on a fake clock, cooperative cancel with its measured time, and
// resume after a restart from the journal.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { builtinModules } = require('node:module');
const { createJournal } = require('../src/tasks/journal');
const { createSupervisor, TRANSIENT, BACKOFF_MS } = require('../src/tasks/supervisor');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'nus-super-')); }
const tick = () => new Promise((r) => setImmediate(r));
async function settle(n = 4) { for (let i = 0; i < n; i++) await tick(); }

// A fake clock with timers that only fire when advanced.
function fakeTime(start = 1000) {
  let t = start;
  const timers = [];
  return {
    now: () => t,
    setTimer: (fn, ms) => { const h = { at: t + ms, fn }; timers.push(h); return h; },
    clearTimer: (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); },
    advance(ms) { t += ms; const due = timers.filter((h) => h.at <= t).sort((a, b) => a.at - b.at); for (const h of due) { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); h.fn(); } },
    get pending() { return timers.length; },
  };
}

// A fake executor driven by a script per task: each entry is an event to
// emit, 'ask' to park on a question, or 'wait' to sit until cancelled.
function fakeExecutor(name = 'fake', opts = {}) {
  const runs = [];
  const ex = {
    name,
    canRun: (t) => t.executor === name,
    answers: [],
    answer(task, value, how) { ex.answers.push({ id: task.id, value, how }); return true; },
    async run(task, ctx) {
      const run = { task, ctx, aborted: false, resumed: ctx.resumed };
      runs.push(run);
      const script = typeof opts.script === 'function' ? opts.script(task) : (opts.script || [['started'], ['step', { n: 1, line: 'Opening Notepad' }], ['done', { summary: 'Opened Notepad.' }]]);
      for (const entry of script) {
        if (ctx.signal && ctx.signal.aborted) { run.aborted = true; return; }
        const [type, data] = entry;
        if (type === 'ask') { run.answer = await ctx.ask(data); continue; }
        if (type === 'wait') { await new Promise((resolve) => { if (ctx.signal.aborted) return resolve(); ctx.signal.addEventListener('abort', () => resolve(), { once: true }); }); run.aborted = true; if (opts.settleMs) await new Promise((r) => setTimeout(r, opts.settleMs)); return; }
        if (type === 'throw') throw Object.assign(new Error(data.message || 'boom'), { class: data.class });
        if (type === 'pause') { await settle(2); continue; }
        ctx.emit(type, data);
        await tick();
      }
    },
  };
  ex.runs = runs;
  return ex;
}

function rig(opts = {}) {
  const dir = opts.dir || tmp();
  const time = opts.time || fakeTime();
  const journal = createJournal({ dir, now: () => new Date(time.now()).toISOString() });
  const ex = opts.executor || fakeExecutor('fake', opts);
  const events = [];
  const sup = createSupervisor({ journal, executors: [ex], now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer, onEvent: (e) => events.push(e), log: (m) => events.push({ type: 'log', data: m }) });
  return { dir, time, journal, ex, sup, events, types: () => events.filter((e) => e.id).map((e) => e.type) };
}

test('1. the queue is FIFO with one slot: the second task waits for the first', async () => {
  const r = rig({ script: [['started'], ['pause'], ['step', { n: 1, line: 'One' }], ['done', { summary: 'ok' }]] });
  const a = r.sup.submit({ request: 'first', executor: 'fake' });
  const b = r.sup.submit({ request: 'second', executor: 'fake' });
  assert.equal(r.sup.running().id, a);
  assert.equal(r.journal.get(b).state, 'queued');
  await settle(12);
  assert.equal(r.journal.get(a).state, 'applied');
  assert.equal(r.journal.get(b).state, 'applied');
  assert.deepEqual(r.ex.runs.map((x) => x.task.id), [a, b], 'in order, one at a time');
  assert.equal(r.sup.running(), null);
  const order = r.events.filter((e) => e.id === a).map((e) => e.type);
  assert.deepEqual(order, ['queued', 'preparing', 'started', 'step', 'done']);
  const second = r.events.find((e) => e.id === b && e.type === 'started');
  const firstDone = r.events.find((e) => e.id === a && e.type === 'done');
  assert.ok(r.events.indexOf(second) > r.events.indexOf(firstDone), 'the second starts after the first is done');
});

test('2. the event shapes: started, step, done, and the journal walks running, verifying, review, applied', async () => {
  const r = rig({ script: [['started'], ['step', { n: 1, total: 3, line: 'Reading the page' }], ['step', { n: 2, total: 3, line: 'Clicking Submit' }], ['done', { summary: 'Submitted the form.', outcome: 'ok' }]] });
  const id = r.sup.submit({ request: 'submit the form', executor: 'fake', source: 'voice' });
  await settle(10);
  const byType = (t) => r.events.find((e) => e.id === id && e.type === t);
  assert.deepEqual(byType('queued').data, { request: 'submit the form' });
  assert.deepEqual(byType('preparing').data, { executor: 'fake' });
  assert.equal(byType('preparing').state, 'preparing');
  assert.deepEqual(byType('started').data, { executor: 'fake', attempt: 1 });
  assert.equal(byType('started').state, 'running');
  assert.deepEqual(byType('step').data, { n: 1, total: 3, line: 'Reading the page' });
  assert.deepEqual(byType('done').data, { summary: 'Submitted the form.', outcome: 'ok' });
  assert.equal(byType('done').state, 'applied');
  const t = r.journal.get(id);
  assert.deepEqual(t.progress, { n: 2, total: 3, line: 'Clicking Submit' });
  assert.equal(t.spent.turns, 2);
  assert.equal(t.artifacts.summary, 'Submitted the form.');
  assert.equal(typeof t.metrics.first_progress, 'number');
  assert.equal(typeof t.metrics.started, 'number');
  // The events file beside the journal replays the same list.
  const onDisk = r.sup.events(id).map((e) => e.type);
  assert.deepEqual(onDisk, ['queued', 'preparing', 'started', 'step', 'step', 'done']);
  assert.equal(path.basename(r.sup.eventsFile), 'events.jsonl');
  assert.equal(path.dirname(r.sup.eventsFile), path.dirname(r.journal.file));
  for (const e of r.sup.events(id)) { assert.equal(typeof e.at, 'string'); assert.equal(e.id, id); assert.ok(e.state); }
});

test('3. needs_input through ctx.ask parks the task; answer() resumes it and the consent is kept', async () => {
  const r = rig({ script: [['started'], ['ask', { kind: 'consent', text: 'Click "Submit Assignment"?', options: [{ id: 'yes', label: 'Yes', primary: true }, { id: 'no', label: 'Not now' }] }], ['done', { summary: 'Done.' }]] });
  const id = r.sup.submit({ request: 'submit lab 3', executor: 'fake' });
  await settle(6);
  const t = r.journal.get(id);
  assert.equal(t.state, 'needs_input');
  assert.equal(t.question.kind, 'consent');
  assert.equal(t.question.text, 'Click "Submit Assignment"?');
  assert.deepEqual(t.question.options.map((o) => o.id), ['yes', 'no']);
  const ev = r.events.find((e) => e.id === id && e.type === 'needs_input');
  assert.deepEqual(Object.keys(ev.data).sort(), ['hint', 'id', 'kind', 'options', 'text']);
  assert.equal(r.sup.answer(id, true, 'voice'), true);
  await settle(6);
  const after = r.journal.get(id);
  assert.equal(after.state, 'applied');
  assert.equal(after.question, null);
  assert.equal(after.consent.length, 1);
  assert.equal(after.consent[0].answer, true); assert.equal(after.consent[0].how, 'voice'); assert.equal(after.consent[0].kind, 'consent');
  assert.equal(r.ex.runs[0].answer, true, 'the executor got the value');
  assert.deepEqual(r.types().filter((x) => x !== 'queued'), ['preparing', 'started', 'needs_input', 'answered', 'done']);
  assert.equal(r.sup.answer(id, true), false, 'nothing pending now');
});

test('4. an executor with its own answer store gets answer(); its answered event moves the task back to running', async () => {
  const ex = fakeExecutor('fake', { script: [['started'], ['needs_input', { id: 'c1', kind: 'consent', text: 'Send this?' }], ['pause'], ['pause'], ['answered', { id: 'c1', value: false, how: 'button' }], ['done', { summary: 'Not sent.', outcome: 'declined' }]] });
  const r = rig({ executor: ex });
  const id = r.sup.submit({ request: 'send it', executor: 'fake' });
  await settle(3);
  assert.equal(r.journal.get(id).state, 'needs_input');
  assert.equal(r.sup.answer(id, false), true);
  assert.deepEqual(ex.answers, [{ id, value: false, how: 'button' }]);
  await settle(10);
  assert.equal(r.journal.get(id).state, 'applied');
  assert.equal(r.journal.get(id).consent[0].answer, false);
});

test('5. review waits for apply or discard', async () => {
  const r = rig({ script: [['started'], ['review', { summary: 'Changed 2 files.', artifacts: { patch: 'x.patch', diffStat: { files: 2 } } }]] });
  const a = r.sup.submit({ request: 'fix it', executor: 'fake' });
  await settle(6);
  const t = r.journal.get(a);
  assert.equal(t.state, 'review');
  assert.deepEqual(t.artifacts, { patch: 'x.patch', diffStat: { files: 2 }, summary: 'Changed 2 files.' });
  assert.equal(r.sup.running(), null, 'the slot is free while the person looks');
  assert.equal(r.sup.apply(a), true);
  assert.equal(r.journal.get(a).state, 'applied');
  assert.equal(r.sup.apply(a), false);
  const b = r.sup.submit({ request: 'and this', executor: 'fake' });
  await settle(6);
  assert.equal(r.sup.discard(b), true);
  assert.equal(r.journal.get(b).state, 'discarded');
  assert.deepEqual(r.events.filter((e) => e.id === b).map((e) => e.type), ['queued', 'preparing', 'started', 'review', 'discarded']);
});

test('6. a transient failure retries after 5 s, then 20 s, within maxAttempts; a final one does not', async () => {
  let calls = 0;
  const r = rig({ script: () => { calls++; return [['started'], ['failed', { class: 'timeout', detail: 'the model went quiet' }]]; } });
  const id = r.sup.submit({ request: 'slow thing', executor: 'fake', maxAttempts: 3 });
  await settle(6);
  let t = r.journal.get(id);
  assert.equal(t.state, 'failed'); assert.equal(t.attempt, 1);
  assert.deepEqual(t.lastError, { class: 'timeout', detail: 'the model went quiet', retryable: true });
  assert.deepEqual(r.events.find((e) => e.id === id && e.type === 'retry').data, { attempt: 2, inMs: 5000 });
  r.time.advance(4999); await settle(4);
  assert.equal(r.journal.get(id).state, 'failed', 'not yet');
  r.time.advance(1); await settle(8);
  t = r.journal.get(id);
  assert.equal(t.attempt, 2); assert.equal(t.state, 'failed');
  assert.deepEqual(r.events.filter((e) => e.id === id && e.type === 'retry').map((e) => e.data.inMs), [5000, 20000]);
  r.time.advance(20000); await settle(8);
  t = r.journal.get(id);
  assert.equal(t.attempt, 3); assert.equal(t.state, 'failed');
  assert.equal(r.events.filter((e) => e.id === id && e.type === 'retry').length, 2, 'no fourth attempt past maxAttempts');
  assert.equal(calls, 3);
  assert.equal(r.events.filter((e) => e.id === id && e.type === 'started').map((e) => e.data.attempt).join(','), '1,2,3');
  assert.deepEqual(BACKOFF_MS, [5000, 20000]);
  assert.ok(TRANSIENT.includes('timeout') && TRANSIENT.includes('cli_spawn_failed') && !TRANSIENT.includes('auth'));

  // A final class: one attempt, endedAt set, and the person's no is never retried.
  const f = rig({ script: [['started'], ['failed', { class: 'auth', detail: 'not signed in' }]] });
  const fid = f.sup.submit({ request: 'x', executor: 'fake' });
  await settle(6);
  const ft = f.journal.get(fid);
  assert.equal(ft.state, 'failed'); assert.equal(ft.lastError.retryable, false); assert.ok(ft.endedAt);
  assert.equal(f.events.some((e) => e.id === fid && e.type === 'retry'), false);
  assert.equal(f.time.pending, 0);
  const d = rig({ script: [['started'], ['failed', { class: 'timeout', detail: 'x', retryable: false }]] });
  const did = d.sup.submit({ request: 'x', executor: 'fake' });
  await settle(6);
  assert.equal(d.journal.get(did).lastError.retryable, false, 'an executor may say final even for a transient class');
  assert.equal(d.time.pending, 0);
});

test('7. a throw from run() is a failure with the error\'s class; an executor that ends silent is a final failure', async () => {
  const r = rig({ script: [['started'], ['throw', { class: 'timeout', message: 'model timed out' }]] });
  const id = r.sup.submit({ request: 'x', executor: 'fake' });
  await settle(6);
  assert.deepEqual(r.journal.get(id).lastError, { class: 'timeout', detail: 'model timed out', retryable: true });
  const s = rig({ script: [['started'], ['step', { n: 1, line: 'One' }]] });
  const sid = s.sup.submit({ request: 'x', executor: 'fake' });
  await settle(8);
  assert.equal(s.journal.get(sid).state, 'failed');
  assert.equal(s.journal.get(sid).lastError.class, 'executor');
  assert.equal(s.journal.get(sid).lastError.retryable, false);
  // A task nobody can run fails at once with no retry.
  const n = rig();
  const nid = n.sup.submit({ request: 'x', executor: 'code' });
  await settle(2);
  assert.equal(n.journal.get(nid).state, 'failed'); assert.equal(n.journal.get(nid).lastError.class, 'no_executor');
});

test('8. cancel aborts through the signal, measures the time to the executor settling, and frees the slot', async () => {
  const time = fakeTime();
  const r = rig({ time, script: (t) => (t.request === 'long thing' ? [['started'], ['step', { n: 1, line: 'Working' }], ['wait']] : [['started'], ['done', { summary: 'quick' }]]) });
  const a = r.sup.submit({ request: 'long thing', executor: 'fake' });
  const b = r.sup.submit({ request: 'next', executor: 'fake' });
  await settle(6);
  assert.equal(r.journal.get(a).state, 'running');
  const p = r.sup.cancel(a, 'esc');
  assert.equal(r.journal.get(a).state, 'cancelled', 'cancelled at once, for the surface');
  assert.equal(r.ex.runs[0].ctx.signal.aborted, true);
  time.advance(120);
  const ms = await p;
  assert.equal(ms, 120, 'measured from the signal to the executor settling');
  assert.equal(r.journal.get(a).metrics.cancel, 120);
  assert.ok(r.journal.get(a).endedAt);
  const ev = r.events.find((e) => e.id === a && e.type === 'cancelled');
  assert.deepEqual(ev.data, { reason: 'esc', ms: 120 });
  await settle(10);
  assert.equal(r.journal.get(b).state, 'applied', 'the next task ran once the slot was free');
  assert.equal(r.ex.runs[0].aborted, true);
  // The executor's last words after a cancel change nothing.
  const late = rig({ script: [['started'], ['wait'], ['done', { summary: 'too late' }]] });
  const lid = late.sup.submit({ request: 'x', executor: 'fake' });
  await settle(4);
  await late.sup.cancel(lid);
  await settle(4);
  assert.equal(late.journal.get(lid).state, 'cancelled');
  assert.equal(late.events.some((e) => e.id === lid && e.type === 'done'), false);
});

test('9. cancel on a queued task, on a card, on review, and on a failed task waiting to retry', async () => {
  const r = rig({ script: [['started'], ['ask', { text: 'Go on?' }], ['done', { summary: 'x' }]] });
  const a = r.sup.submit({ request: 'a', executor: 'fake' });
  const b = r.sup.submit({ request: 'b', executor: 'fake' });
  await settle(4);
  assert.equal(r.journal.get(a).state, 'needs_input');
  assert.equal(await r.sup.cancel(b), 0);
  assert.equal(r.journal.get(b).state, 'cancelled');
  await r.sup.cancel(a, 'esc');
  await settle(4);
  assert.equal(r.journal.get(a).state, 'cancelled');
  assert.equal(r.ex.runs[0].answer, null, 'the parked question resolved with nothing');
  const rv = rig({ script: [['started'], ['review', { summary: 's' }]] });
  const c = rv.sup.submit({ request: 'c', executor: 'fake' });
  await settle(6);
  await rv.sup.cancel(c);
  assert.equal(rv.journal.get(c).state, 'cancelled');
  const f = rig({ script: [['started'], ['failed', { class: 'timeout', detail: 'x' }]] });
  const d = f.sup.submit({ request: 'd', executor: 'fake' });
  await settle(6);
  assert.equal(f.time.pending, 1);
  await f.sup.cancel(d);
  assert.equal(f.time.pending, 0, 'the retry timer is dropped');
  assert.equal(f.journal.get(d).state, 'failed');
  assert.equal(f.journal.get(d).lastError.retryable, false, 'and the failure is final');
  f.time.advance(60000); await settle(4);
  assert.equal(f.journal.get(d).attempt, 1);
});

test('10. boot over a journal left mid-flight marks it interrupted, starts what was queued, and resume runs it again', async () => {
  const dir = tmp();
  const time = fakeTime();
  const first = rig({ dir, time, script: [['started'], ['step', { n: 2, line: 'Typing the list' }], ['wait']] });
  const a = first.sup.submit({ request: 'write my list in notepad', executor: 'fake' });
  const b = first.sup.submit({ request: 'then email it', executor: 'fake' });
  await settle(4);
  assert.equal(first.journal.get(a).state, 'running');
  // The app dies here: a second supervisor on the same folder.
  const ex2 = fakeExecutor('fake', { script: [['started'], ['step', { n: 3, line: 'Carrying on' }], ['done', { summary: 'Finished.' }]] });
  const second = rig({ dir, time, executor: ex2 });
  const interrupted = second.sup.boot();
  assert.deepEqual(interrupted.map((t) => t.id), [a]);
  assert.equal(second.journal.get(a).state, 'interrupted');
  assert.equal(second.events.find((e) => e.id === a && e.type === 'interrupted').state, 'interrupted');
  await settle(8);
  assert.equal(second.journal.get(b).state, 'applied', 'the queued task ran on boot');
  assert.equal(second.sup.resume(a), true);
  await settle(8);
  const t = second.journal.get(a);
  assert.equal(t.state, 'applied');
  assert.equal(t.lastError, null);
  assert.equal(ex2.runs[1].resumed, true, 'the executor knows it is picking up');
  assert.equal(ex2.runs[1].task.progress.n, 2, 'and sees how far it got');
  assert.deepEqual(second.events.filter((e) => e.id === a).map((e) => e.type), ['interrupted', 'resumed', 'started', 'step', 'done']);
  assert.equal(second.sup.resume(a), false, 'only an interrupted task resumes');
  // Discard instead of resume is the other door.
  const third = rig({ dir, time, executor: fakeExecutor('fake', { script: [['started'], ['wait']] }) });
  const c = third.sup.submit({ request: 'c', executor: 'fake' });
  await settle(4);
  const fourth = rig({ dir, time });
  fourth.sup.boot();
  assert.equal(fourth.sup.discard(c), true);
  assert.equal(fourth.journal.get(c).state, 'discarded');
  assert.equal(fourth.sup.boot().length, 0, 'a second boot finds nothing to interrupt');
});

test('11. listeners come and go; events(id, limit) reads the tail; nothing from electron', () => {
  const r = rig();
  const got = [];
  const off = r.sup.on((e) => got.push(e.type));
  r.sup.submit({ request: 'x', executor: 'fake' });
  assert.deepEqual(got, ['queued', 'preparing', 'started'].slice(0, got.length));
  off();
  const before = got.length;
  r.sup.submit({ request: 'y', executor: 'fake' });
  assert.equal(got.length, before);
  assert.ok(r.sup.events(null, 2).length <= 2);
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'tasks', 'supervisor.js'), 'utf8');
  for (const m of src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) { assert.notEqual(m[1], 'electron'); assert.ok(builtinModules.includes(m[1].replace(/^node:/, '')) || m[1].startsWith('./'), m[1]); }
  r.sup.dispose();
});
