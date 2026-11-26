'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createScheduler, dueRows, nextFor, scheduleText, ACTION } = require('../src/scheduled-ai');

const at = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min, 0, 0);
const row = (over = {}) => ({
  id: 1, name: 'Monday brief', enabled: 1, trigger_type: 'cron',
  trigger_json: JSON.stringify({ timezone: 'Europe/London' }),
  action_type: ACTION,
  action_json: JSON.stringify({ ask: 'Summarise my unread mail and tell me what needs a reply.', cron: '0 9 * * 1' }),
  next_run_at: at(2026, 3, 2, 9, 0).toISOString(),
  ...over,
});

test('only ask_ai rows with a real ask are scheduled: task automations keep their old path', () => {
  const rows = [
    row(),
    row({ id: 2, action_type: 'create_task' }),
    row({ id: 3, action_json: JSON.stringify({ ask: '   ' }) }),
    row({ id: 4, enabled: 0 }),
    row({ id: 5, action_json: 'not json' }),
  ];
  const due = dueRows(rows, at(2026, 3, 2, 9, 0));
  assert.deepEqual(due.map((d) => d.row.id), [1]);
});

test('a machine that was asleep fires the missed run once, not once per missed minute', () => {
  const now = at(2026, 3, 2, 9, 0);
  const rows = [row({ next_run_at: at(2026, 2, 20, 9, 0).toISOString() })];
  const due = dueRows(rows, now);
  assert.equal(due.length, 1, 'one row, one run');
  assert.ok(due[0].late > 86400000, 'and it knows it is late');
});

test('the cron expression decides the next run, and a bad one degrades to no next run', () => {
  assert.equal(
    nextFor(row(), at(2026, 3, 2, 10, 0)),
    at(2026, 3, 9, 9, 0).toISOString(),
    'Monday 10:00 -> next Monday 09:00',
  );
  assert.equal(nextFor(row({ action_json: JSON.stringify({ ask: 'x', cron: 'nonsense' }) })), null);
  assert.equal(nextFor(row({ action_json: JSON.stringify({ ask: 'x' }) })), null, 'no cron, no cron next run');
  // The expression may live on the trigger instead; both are read.
  assert.equal(
    nextFor(row({ action_json: JSON.stringify({ ask: 'x' }), trigger_json: JSON.stringify({ cron: '30 7 * * *' }) }), at(2026, 3, 2, 6, 0)),
    at(2026, 3, 2, 7, 30).toISOString(),
  );
});

test('the row reads as a sentence, and falls back to the plain trigger when it is not cron', () => {
  assert.equal(scheduleText(row()), 'At 09:00, on mon.');
  assert.match(scheduleText(row({ trigger_type: 'daily', action_json: '{}' })), /Every day/);
  assert.match(scheduleText(row({ trigger_type: 'weekly', action_json: '{}' })), /Every week/);
  assert.match(scheduleText(row({ action_json: JSON.stringify({ ask: 'x', cron: '0 9 * * *' }) })), /every day/);
});

test('a run is told it is unattended, and the row is marked with a next time after it finished', async () => {
  const seen = [];
  const marks = [];
  const clock = { t: at(2026, 3, 2, 9, 0) };
  const s = createScheduler({
    now: () => clock.t,
    run: async (ask, opts) => { seen.push({ ask, opts }); clock.t = at(2026, 3, 2, 9, 4); return { ok: true, summary: 'Three things need you.' }; },
    markRun: (id, lastRun, next) => marks.push({ id, lastRun, next }),
  });
  const res = await s.tick([row()]);
  assert.equal(res.ran, 1);
  assert.equal(seen[0].opts.unattended, true, 'the run knows nobody is watching');
  assert.match(seen[0].ask, /Summarise my unread mail/);
  assert.equal(marks[0].id, 1);
  assert.equal(marks[0].lastRun, at(2026, 3, 2, 9, 0).toISOString());
  // Next is computed from the finish (09:04), so a four-minute run does not
  // schedule the next one in the past.
  assert.equal(marks[0].next, at(2026, 3, 9, 9, 0).toISOString());
  assert.equal(s.recent()[0].ok, true);
  assert.equal(s.recent()[0].unattended, true);
});

test('a failing run is recorded and does not stop the tick or the row after it', async () => {
  const logs = [];
  const marks = [];
  const s = createScheduler({
    now: () => at(2026, 3, 2, 9, 0),
    run: async (ask) => { if (/throw/i.test(ask)) throw new Error('model down'); return { ok: true, summary: 'done' }; },
    markRun: (id, a, b) => marks.push(id),
    log: (m) => logs.push(m),
  });
  const rows = [
    row({ id: 7, action_json: JSON.stringify({ ask: 'please throw', cron: '0 9 * * 1' }) }),
    row({ id: 8, name: 'Second', action_json: JSON.stringify({ ask: 'do the other thing', cron: '0 9 * * 1' }) }),
  ];
  const res = await s.tick(rows);
  assert.equal(res.ran, 2, 'both were attempted');
  assert.equal(s.recent().find((r) => r.id === 7).ok, false);
  assert.match(s.recent().find((r) => r.id === 7).summary, /model down/);
  assert.deepEqual(marks, [7, 8], 'both rows were re-scheduled, so neither retries every minute for ever');
  assert.ok(logs.some((l) => /failed/.test(l)));
});

test('one run at a time: a second tick while a scheduled ask is working does nothing', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const s = createScheduler({ now: () => at(2026, 3, 2, 9, 0), run: async () => { await gate; return { ok: true, summary: 'ok' }; }, markRun: () => {} });
  const first = s.tick([row()]);
  // Let the first tick reach its await.
  await new Promise((r) => setImmediate(r));
  const second = await s.tick([row()]);
  assert.match(String(second.skipped), /still running/);
  assert.equal(second.due, 0);
  release();
  await first;
  const third = await s.tick([]);
  assert.deepEqual(third, { ran: 0, due: 0 }, 'nothing due, nothing run');
});

test('a run that returns nothing useful is still marked and still safe', async () => {
  const marks = [];
  const s = createScheduler({ now: () => at(2026, 3, 2, 9, 0), run: async () => undefined, markRun: (id) => marks.push(id) });
  const res = await s.tick([row()]);
  assert.equal(res.ran, 1);
  assert.equal(s.recent()[0].ok, false, 'no result is not success');
  assert.equal(marks.length, 1);
});

test('nothing due means no run call at all', async () => {
  let calls = 0;
  const s = createScheduler({ now: () => at(2026, 3, 2, 9, 0), run: async () => { calls++; return { ok: true }; } });
  const res = await s.tick([]);
  assert.deepEqual(res, { ran: 0, due: 0 });
  assert.equal(calls, 0);
});

test('the scheduler refuses to be built without a runner', () => {
  assert.throws(() => createScheduler({}), /needs a run function/);
});
