'use strict';
// Ledger rows for the bench: one row per task run with the time to the first
// progress event and the cancel latency, readable through the bench's own
// session helper, and invisible to Home's counts and the Activity list.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createJournal } = require('../src/tasks/journal');
const { createSupervisor } = require('../src/tasks/supervisor');
const { createLedger, activityView, taskTimings } = require('../src/usage-ledger');

const root = path.resolve(__dirname, '..', '..');
function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'nus-tasks-ledger-')); }
const tick = () => new Promise((r) => setImmediate(r));
async function settle(n = 8) { for (let i = 0; i < n; i++) await tick(); }

// An executor the test moves by hand: clock.t advances between its events.
function rig() {
  const profile = tmp();
  const clock = { t: Date.parse('2026-11-02T12:00:00Z') };
  const journal = createJournal({ dir: path.join(profile, 'companion', 'tasks'), now: () => new Date(clock.t).toISOString() });
  const ledger = createLedger({ file: path.join(profile, 'companion', 'usage.jsonl'), now: () => clock.t });
  const runs = [];
  const ex = { name: 'fake', canRun: () => true, run: (task, ctx) => new Promise((resolve) => { runs.push({ task, ctx, resolve }); ctx.signal.addEventListener('abort', () => { runs[runs.length - 1].aborted = true; }, { once: true }); }) };
  const sup = createSupervisor({ journal, executors: [ex], ledger, now: () => clock.t, setTimer: () => ({}), clearTimer: () => {} });
  return { profile, clock, journal, ledger, runs, sup };
}

test('1. a finished run writes one task row with the time to its first progress event and the wait for the slot', async () => {
  const r = rig();
  const a = r.sup.submit({ request: 'my secret essay', executor: 'fake' });
  const b = r.sup.submit({ request: 'the next one', executor: 'fake' });
  r.clock.t += 500;
  r.runs[0].ctx.emit('started', {});
  r.clock.t += 1200;
  r.runs[0].ctx.emit('step', { n: 1, line: 'Opening Notepad' });
  r.clock.t += 3000;
  r.runs[0].ctx.emit('step', { n: 2, line: 'Typing' });
  r.runs[0].ctx.emit('done', { summary: 'ok' });
  assert.equal(r.ledger.read().length, 1);
  r.runs[0].resolve();
  await settle();
  const row = r.ledger.read()[0];
  assert.equal(row.feature, 'task'); assert.equal(row.provider, 'fake'); assert.equal(row.outcome, 'ok');
  assert.equal(row.timings.first_progress, 1700, 'from the run starting to the first step, the later step does not move it');
  assert.equal(row.timings.queued, 0);
  assert.equal(row.ms, 4700);
  assert.equal(row.note, a, 'the id, never the words');
  assert.doesNotMatch(JSON.stringify(r.ledger.read()), /secret essay/);
  assert.equal(r.journal.get(a).metrics.first_progress, 1700);
  // The second task waited for the slot; that wait is its own number.
  assert.equal(r.runs[1].task.id, b);
  r.runs[1].ctx.emit('started', {});
  r.runs[1].ctx.emit('done', { summary: 'ok' });
  r.runs[1].resolve();
  await settle();
  const second = r.ledger.read()[1];
  assert.equal(second.timings.queued, 4700);
  assert.equal(second.timings.first_progress, undefined, 'no step, no number');
});

test('2. a cancel writes the measured latency; an executor that stopped by itself writes a row without one', async () => {
  const r = rig();
  const a = r.sup.submit({ request: 'x', executor: 'fake' });
  r.runs[0].ctx.emit('started', {});
  r.clock.t += 900;
  r.runs[0].ctx.emit('step', { n: 1, line: 'Working' });
  const p = r.sup.cancel(a, 'esc');
  assert.equal(r.runs[0].aborted, true);
  r.clock.t += 140;
  r.runs[0].resolve();
  assert.equal(await p, 140);
  await settle();
  const row = r.ledger.read()[0];
  assert.equal(row.outcome, 'stopped');
  assert.equal(row.timings.cancel, 140);
  assert.equal(row.timings.first_progress, 900);
  assert.equal(r.ledger.read().length, 1, 'one row per run');
  const b = r.sup.submit({ request: 'y', executor: 'fake' });
  r.runs[1].ctx.emit('started', {});
  r.runs[1].ctx.emit('cancelled', { reason: 'stopped' });
  r.runs[1].resolve();
  await settle();
  const own = r.ledger.read()[1];
  assert.equal(own.note, b); assert.equal(own.outcome, 'stopped'); assert.equal(own.timings.cancel, undefined);
});

test('3. a failed run and a run that reaches review each write their row, once', async () => {
  const r = rig();
  r.sup.submit({ request: 'x', executor: 'fake' });
  r.runs[0].ctx.emit('started', {});
  r.runs[0].ctx.emit('failed', { class: 'auth', detail: 'not signed in' });
  r.runs[0].resolve();
  await settle();
  r.sup.submit({ request: 'y', executor: 'fake' });
  r.runs[1].ctx.emit('started', {});
  r.runs[1].ctx.emit('review', { summary: 'Changed 2 files.' });
  r.runs[1].resolve();
  await settle();
  assert.deepEqual(r.ledger.read().map((x) => x.outcome), ['error', 'review']);
});

test('4. the bench reads the rows from the scratch profile and gets medians; Home and Activity do not count them', async () => {
  const r = rig();
  for (const [step, cancel] of [[800, 100], [1200, 300], [4000, 200]]) {
    const id = r.sup.submit({ request: 'x', executor: 'fake' });
    const run = r.runs[r.runs.length - 1];
    run.ctx.emit('started', {});
    r.clock.t += step;
    run.ctx.emit('step', { n: 1, line: 'Working' });
    const p = r.sup.cancel(id, 'esc');
    r.clock.t += cancel;
    run.resolve();
    await p;
    await settle();
  }
  const session = fs.readFileSync(path.join(root, 'scripts', 'bench', 'lib', 'session.cjs'), 'utf8');
  assert.match(session, /function taskRows\(profile\) \{ return ledgerRows\(profile\)\.filter\(\(r\) => r\.feature === 'task'\); \}/);
  assert.match(session, /module\.exports = \{[^}]*taskRows/);
  assert.match(session, /path\.join\(profile, 'companion', 'usage\.jsonl'\)/, 'the same file the ledger writes in the app');
  const t = taskTimings(r.ledger.read());
  assert.equal(t.runs, 3);
  assert.deepEqual(t.firstProgress, { n: 3, medianMs: 1200, maxMs: 4000 });
  assert.deepEqual(t.cancel, { n: 3, medianMs: 200, maxMs: 300 });
  // A model request beside them: Home sees that one alone.
  r.ledger.record({ feature: 'hands', provider: 'test', outcome: 'ok', ms: 2000 });
  const s = r.ledger.summary(1);
  assert.equal(s.requests, 1); assert.deepEqual(s.byFeature, { hands: 1 }); assert.equal(s.medianMs, 2000);
  const v = activityView(r.ledger.read(), { now: r.clock.t });
  assert.equal(v.today.requests, 1); assert.equal(v.rows.length, 1); assert.equal(v.rows[0].feature, 'Hands');
  assert.deepEqual(taskTimings([]).cancel, { n: 0, medianMs: null, maxMs: null });
});

test('5. a ledger that throws never breaks a task; with no ledger nothing changes', async () => {
  const dir = tmp();
  const journal = createJournal({ dir });
  const runs = [];
  const ex = { name: 'fake', canRun: () => true, run: (task, ctx) => new Promise((resolve) => runs.push({ ctx, resolve })) };
  const sup = createSupervisor({ journal, executors: [ex], ledger: { record() { throw new Error('disk full'); } } });
  const id = sup.submit({ request: 'x', executor: 'fake' });
  runs[0].ctx.emit('started', {});
  runs[0].ctx.emit('done', { summary: 'ok' });
  runs[0].resolve();
  await settle();
  assert.equal(journal.get(id).state, 'applied');
  const main = fs.readFileSync(path.join(root, 'companion', 'index.js'), 'utf8');
  assert.match(main, /ledger: getLedger\(\), log: tasksLog/, 'the app gives the supervisor its ledger');
  assert.match(main, /if \(rec && rec\.feature === 'task'\) return record\(rec\);/, 'a task row does not take the next request\'s ack');
});
