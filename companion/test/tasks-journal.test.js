'use strict';
// The task journal: defaults, the state machine, persistence, corrupt lines,
// recovery, and the no-Electron rule (spec: ops/KIMI-EXECUTOR-2026-10-31.md section 5).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { builtinModules } = require('node:module');
const { createJournal, STATES, TRANSITIONS, TERMINAL } = require('../src/tasks/journal');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'nus-journal-')); }
function clock(start = '2026-10-31T12:00:00.000Z') {
  let t = new Date(start).getTime();
  const fn = () => new Date(t).toISOString();
  fn.tick = (ms = 1000) => { t += ms; };
  fn.set = (iso) => { t = new Date(iso).getTime(); };
  return fn;
}
// A task driven to the given state along a legal path.
const PATHS = {
  queued: [], preparing: ['preparing'], running: ['preparing', 'running'],
  needs_input: ['preparing', 'running', 'needs_input'], verifying: ['preparing', 'running', 'verifying'],
  review: ['preparing', 'running', 'verifying', 'review'], applied: ['preparing', 'running', 'verifying', 'review', 'applied'],
  discarded: ['preparing', 'running', 'verifying', 'review', 'discarded'], failed: ['preparing', 'failed'], cancelled: ['cancelled'],
};
function taskIn(j, state, extra) {
  const id = j.create(Object.assign({ request: 'reach ' + state }, extra || {}));
  if (state === 'interrupted') { j.update(id, { state: 'preparing' }); j.update(id, { state: 'running' }); j.recover(); return id; }
  for (const s of PATHS[state]) j.update(id, { state: s });
  return id;
}

test('1. create fills every default and returns a dated id', () => {
  const now = clock();
  const j = createJournal({ dir: tmp(), now });
  const id = j.create({ request: 'fix the failing test' });
  assert.match(id, /^t_\d{4}-\d{2}-\d{2}_[0-9a-f]{4}$/);
  const t = j.get(id);
  assert.equal(t.createdAt, '2026-10-31T12:00:00.000Z');
  assert.equal(t.source, 'typed'); assert.equal(t.goal, ''); assert.equal(t.executor, 'code'); assert.equal(t.project, null);
  assert.equal(t.state, 'queued'); assert.equal(t.attempt, 1); assert.equal(t.maxAttempts, 2); assert.equal(t.session, null);
  assert.deepEqual(t.budget, { turns: 40, usd: 2, ms: 600000 }); assert.deepEqual(t.spent, { turns: 0, usd: 0, ms: 0 });
  assert.deepEqual(t.artifacts, {}); assert.deepEqual(t.consent, []); assert.equal(t.lastError, null); assert.equal(t.endedAt, null);
  assert.equal(j.get('nope'), null);
  assert.deepEqual(j.stats(), { records: 1, tasks: 1, skipped: 0 });
});

test('2. create refuses an empty request and any state but queued', () => {
  const j = createJournal({ dir: tmp() });
  assert.throws(() => j.create({ request: '' }), TypeError);
  assert.throws(() => j.create({}), TypeError);
  assert.throws(() => j.create({ request: 'x', state: 'running' }), TypeError);
  assert.equal(j.create({ request: 'x', state: 'queued' }).length > 0, true);
});

test('3. every legal transition in the table succeeds', () => {
  const j = createJournal({ dir: tmp() });
  for (const from of Object.keys(TRANSITIONS)) {
    for (const to of TRANSITIONS[from]) {
      const id = taskIn(j, from);
      const patch = from === 'failed' ? { state: to, attempt: 2 } : { state: to };
      assert.equal(j.update(id, patch).state, to, from + ' -> ' + to);
    }
  }
  // A patch with the same state is a no-op transition that still writes fields.
  const id = taskIn(j, 'running');
  assert.equal(j.update(id, { state: 'running', spent: { turns: 3 } }).spent.turns, 3);
  assert.equal(j.get(id).spent.usd, 0, 'spent merges one level deep');
});

test('4. every illegal pair of the 11x11 grid throws "illegal transition"', () => {
  const j = createJournal({ dir: tmp() });
  assert.equal(STATES.length, 11);
  let checked = 0;
  for (const from of STATES) {
    for (const to of STATES) {
      if (to === from || TRANSITIONS[from].includes(to)) continue;
      const id = taskIn(j, from);
      assert.throws(() => j.update(id, { state: to, attempt: 2 }), { message: /^illegal transition/ }, from + ' -> ' + to);
      assert.equal(j.get(id).state, from, 'state unchanged after ' + from + ' -> ' + to);
      checked++;
    }
  }
  assert.equal(checked, 89, 'the grid was walked: 121 pairs minus 11 same-state minus 21 legal');
});

test('5. failed retries once, within maxAttempts, and never when not retryable', () => {
  const j = createJournal({ dir: tmp() });
  const id = taskIn(j, 'failed');
  assert.throws(() => j.update(id, { state: 'queued' }), { message: /^illegal transition/ }, 'attempt must be carried');
  assert.throws(() => j.update(id, { state: 'queued', attempt: 3 }), { message: /^illegal transition/ });
  assert.equal(j.update(id, { state: 'queued', attempt: 2 }).attempt, 2);
  j.update(id, { state: 'preparing' }); j.update(id, { state: 'failed' });
  assert.throws(() => j.update(id, { state: 'queued', attempt: 3 }), { message: /^illegal transition/ }, 'past maxAttempts');
  const hard = j.create({ request: 'hard' });
  j.update(hard, { state: 'preparing' });
  j.update(hard, { state: 'failed', lastError: { class: 'auth', detail: 'not logged in', retryable: false } });
  assert.throws(() => j.update(hard, { state: 'queued', attempt: 2 }), { message: /^illegal transition/ });
});

test('6. terminal states set endedAt to the injected clock', () => {
  const now = clock();
  const j = createJournal({ dir: tmp(), now });
  for (const [state, extra] of [['applied', null], ['discarded', null], ['cancelled', null]]) {
    now.set('2026-10-31T15:00:00.000Z');
    const id = taskIn(j, state, extra);
    assert.equal(j.get(id).endedAt, '2026-10-31T15:00:00.000Z', state);
  }
  assert.deepEqual(TERMINAL, ['applied', 'discarded', 'cancelled']);
  now.set('2026-10-31T16:00:00.000Z');
  const soft = taskIn(j, 'failed');
  assert.equal(j.get(soft).endedAt, null, 'a retryable failure is not the end');
  const hard = j.create({ request: 'hard' }); j.update(hard, { state: 'preparing' });
  j.update(hard, { state: 'failed', lastError: { class: 'auth', detail: 'x', retryable: false } });
  assert.equal(j.get(hard).endedAt, '2026-10-31T16:00:00.000Z');
  assert.equal(j.get(taskIn(j, 'running')).endedAt, null);
});

test('7. id, createdAt and request cannot be patched', () => {
  const j = createJournal({ dir: tmp() });
  const id = j.create({ request: 'x' });
  for (const k of ['id', 'createdAt', 'request']) assert.throws(() => j.update(id, { [k]: 'y' }), TypeError, k);
  assert.throws(() => j.update('t_missing', { goal: 'g' }), { message: /^unknown task/ });
});

test('8. list filters by state and keeps createdAt order', () => {
  const now = clock();
  const j = createJournal({ dir: tmp() });
  const ids = [];
  for (let i = 0; i < 3; i++) { now.tick(); ids.push(j.create({ request: 'r' + i, createdAt: now() })); }
  j.update(ids[1], { state: 'preparing' });
  assert.deepEqual(j.list().map((t) => t.id), ids);
  assert.deepEqual(j.list({ state: 'queued' }).map((t) => t.id), [ids[0], ids[2]]);
  assert.deepEqual(j.list({ state: 'preparing' }).map((t) => t.id), [ids[1]]);
  assert.deepEqual(j.list({ state: 'review' }), []);
});

test('9. a second journal on the same dir replays the same tasks and states', () => {
  const dir = tmp();
  const a = createJournal({ dir });
  const id1 = a.create({ request: 'one' }); a.update(id1, { state: 'preparing' }); a.update(id1, { state: 'running', spent: { turns: 2 } });
  const id2 = a.create({ request: 'two' });
  const b = createJournal({ dir });
  assert.deepEqual(b.list(), a.list());
  assert.equal(b.get(id1).state, 'running'); assert.equal(b.get(id1).spent.turns, 2); assert.equal(b.get(id2).state, 'queued');
  assert.deepEqual(b.stats(), { records: 4, tasks: 2, skipped: 0 });
});

test('10. a truncated final line is skipped, and the next write starts on a fresh line', () => {
  const dir = tmp();
  const a = createJournal({ dir });
  const id = a.create({ request: 'survives' }); a.update(id, { state: 'preparing' });
  fs.appendFileSync(a.file, '{"op":"upd');
  const b = createJournal({ dir });
  assert.equal(b.get(id).state, 'preparing');
  assert.equal(b.stats().skipped, 1);
  b.update(id, { state: 'running' });
  const lines = fs.readFileSync(b.file, 'utf8').split('\n').filter((l) => l.length);
  let bad = 0;
  for (const l of lines) { try { JSON.parse(l); } catch (_) { bad++; } }
  assert.equal(bad, 1, 'only the torn line fails to parse');
  assert.equal(lines.length, 4);
  assert.equal(createJournal({ dir }).get(id).state, 'running');
});

test('11. a corrupt line in the middle of the file is skipped the same way', () => {
  const dir = tmp();
  const a = createJournal({ dir });
  const id = a.create({ request: 'first' });
  fs.appendFileSync(a.file, 'not json at all\n{"no":"op"}\n{"op":"update","id":"t_missing","patch":{}}\n');
  const b = createJournal({ dir });
  const id2 = b.create({ request: 'second' });
  const c = createJournal({ dir });
  assert.equal(c.get(id).state, 'queued'); assert.equal(c.get(id2).state, 'queued');
  assert.equal(c.stats().skipped, 3); assert.equal(c.stats().records, 2);
});

test('12. recover marks mid-flight tasks interrupted once and leaves the rest alone', () => {
  const now = clock();
  const dir = tmp();
  const j = createJournal({ dir, now });
  const ids = {};
  for (const s of ['queued', 'preparing', 'running', 'needs_input', 'verifying', 'review', 'applied', 'discarded', 'cancelled', 'failed']) ids[s] = taskIn(j, s);
  const kept = j.create({ request: 'keeps its error' });
  j.update(kept, { state: 'preparing' }); j.update(kept, { state: 'running', lastError: { class: 'model', detail: 'slow', retryable: true } });
  const out = j.recover();
  assert.deepEqual(out.map((t) => t.id).sort(), [ids.preparing, ids.running, ids.needs_input, ids.verifying, kept].sort());
  for (const s of ['preparing', 'running', 'needs_input', 'verifying']) {
    const t = j.get(ids[s]);
    assert.equal(t.state, 'interrupted', s);
    assert.deepEqual(t.lastError, { class: 'interrupted', detail: 'app restarted while ' + s, retryable: true });
  }
  assert.deepEqual(j.get(kept).lastError, { class: 'model', detail: 'slow', retryable: true });
  for (const s of ['queued', 'review', 'applied', 'discarded', 'cancelled', 'failed']) assert.equal(j.get(ids[s]).state, s, s + ' untouched');
  const before = fs.statSync(j.file).size;
  assert.deepEqual(j.recover(), []);
  const after = fs.statSync(j.file).size;
  assert.equal(after, before, 'second recover appends nothing: ' + before + ' bytes before, ' + after + ' after');
  // Interrupted tasks resume or close by the table.
  assert.equal(j.update(ids.running, { state: 'running' }).state, 'running');
  assert.equal(j.update(ids.preparing, { state: 'discarded' }).endedAt !== null, true);
  assert.equal(createJournal({ dir }).get(ids.verifying).state, 'interrupted', 'the recovery is on disk');
});

test('12b. a drawn id that is already taken is drawn again; a caller\'s own duplicate still throws', (t) => {
  const crypto = require('node:crypto');
  const seq = ['aaaa', 'aaaa', 'aaaa', 'bbbb'];
  t.mock.method(crypto, 'randomBytes', () => Buffer.from(seq.shift(), 'hex'));
  const j = createJournal({ dir: tmp(), now: clock() });
  const a = j.create({ request: 'one' });
  const b = j.create({ request: 'two' });
  assert.match(a, /_aaaa$/); assert.match(b, /_bbbb$/);
  assert.equal(j.list().length, 2);
  assert.throws(() => j.create({ request: 'three', id: a }), { message: /^duplicate task id/ });
});

test('13. the module imports nothing from electron and nothing outside node built-ins', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'tasks', 'journal.js'), 'utf8');
  const names = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  assert.ok(names.length >= 3);
  for (const n of names) {
    assert.notEqual(n, 'electron');
    const bare = n.replace(/^node:/, '');
    assert.ok(builtinModules.includes(bare) || n.startsWith('./'), n + ' is a built-in or a local file');
  }
});
