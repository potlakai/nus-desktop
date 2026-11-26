'use strict';
// The task journal: the storage layer for the Companion's tasks subsystem.
//
// Every task is a record kept as append-only JSON lines in <dir>/tasks.jsonl,
// replayed into memory once when the journal opens, then served from memory
// while every write appends one line. The journal enforces the task state
// machine (STATES, TRANSITIONS) and marks tasks the app left mid-flight as
// interrupted on boot (recover()). It never runs anything; the Supervisor does.
//
// Terminal states are applied, discarded and cancelled (TERMINAL). A failed
// task is terminal too when its lastError says retryable: false; otherwise it
// may go back to queued once more, with attempt = attempt + 1 up to maxAttempts.
//
// Retention: the file is append-only while the app runs. At boot, compact()
// drops finished tasks past RETENTION and rewrites what is left as one line
// each. clear() is Home's delete. Neither goes through the state machine.
//
// Pure Node: fs, path and crypto only. The clock is injectable for tests.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STATES = ['queued', 'preparing', 'running', 'needs_input', 'verifying', 'review', 'applied', 'discarded', 'failed', 'cancelled', 'interrupted'];

const TRANSITIONS = {
  queued: ['preparing', 'cancelled'],
  preparing: ['running', 'failed', 'cancelled'],
  running: ['needs_input', 'verifying', 'failed', 'cancelled'],
  needs_input: ['running', 'cancelled'],
  verifying: ['review', 'failed', 'cancelled'],
  review: ['applied', 'discarded', 'cancelled'],
  failed: ['queued'],
  interrupted: ['running', 'discarded', 'cancelled'],
  applied: [],
  discarded: [],
  cancelled: [],
};

const TERMINAL = ['applied', 'discarded', 'cancelled'];
// States a restart leaves behind: each becomes interrupted on recover().
const RECOVERABLE = ['preparing', 'running', 'needs_input', 'verifying'];
const PROTECTED = ['id', 'createdAt', 'request'];
const DEEP = ['spent', 'artifacts'];
const FILE = 'tasks.jsonl';
// A finished task stays for 30 days (the same as saved audio's default), and
// only the newest 200 stay. Whichever removes it first.
const RETENTION = { maxAgeDays: 30, maxFinished: 200 };
const DAY_MS = 24 * 60 * 60 * 1000;

function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

function defaultId(nowIso) {
  const day = String(nowIso).slice(0, 10);
  return 't_' + day + '_' + crypto.randomBytes(2).toString('hex');
}

// The merged task after a patch: shallow, except spent and artifacts, which
// merge one level deep so a progress write never wipes its siblings.
function merge(task, patch) {
  const out = Object.assign({}, task);
  for (const k of Object.keys(patch)) {
    if (DEEP.includes(k) && isObject(patch[k]) && isObject(task[k])) out[k] = Object.assign({}, task[k], patch[k]);
    else out[k] = patch[k];
  }
  return out;
}

function retryableFalse(task) { return Boolean(task.lastError && task.lastError.retryable === false); }

// Is this move legal? Returns null when it is, else the reason text.
function illegal(task, patch) {
  const from = task.state, to = patch.state;
  if (to === undefined || to === from) return null;
  if (!STATES.includes(to)) return 'illegal transition from ' + from + ' to ' + to + ' (unknown state)';
  if (from === 'failed') {
    if (retryableFalse(task)) return 'illegal transition from failed to ' + to + ' (not retryable)';
    if (to !== 'queued') return 'illegal transition from failed to ' + to;
    const next = task.attempt + 1;
    if (patch.attempt !== next || next > task.maxAttempts) return 'illegal transition from failed to queued (attempt must be ' + next + ' of ' + task.maxAttempts + ')';
    return null;
  }
  if (!(TRANSITIONS[from] || []).includes(to)) return 'illegal transition from ' + from + ' to ' + to;
  return null;
}

// Nothing more can happen to it. A failed task counts: a retry's timer does not
// survive a restart and nothing queues it again, which is why compact() is for
// boot only. Queued, interrupted and review tasks wait on the person, and stay.
function finished(task) { return TERMINAL.includes(task.state) || task.state === 'failed'; }
function finishedAt(task) { const t = Date.parse(task.endedAt || task.createdAt); return Number.isFinite(t) ? t : 0; }

// Gone from disk, with any .tmp a crash left, since that holds the same words.
function remove(file) {
  for (const f of [file, file + '.tmp']) fs.rmSync(f, { force: true, maxRetries: 3, retryDelay: 50 });
}
// Replace a file whole: a crash leaves the old one or the new one, never half.
function rewrite(file, text) {
  const tmp = file + '.tmp';
  try { fs.writeFileSync(tmp, text, 'utf8'); fs.renameSync(tmp, file); }
  catch (e) { try { fs.rmSync(tmp, { force: true }); } catch (_) { /* the first error is the one to report */ } throw e; }
}

function createJournal({ dir, now } = {}) {
  if (!dir || typeof dir !== 'string') throw new TypeError('createJournal needs an absolute dir');
  const clock = typeof now === 'function' ? now : () => new Date().toISOString();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, FILE);
  const tasks = new Map();
  let records = 0, skipped = 0;
  let endsWithNewline = true;

  function apply(rec) {
    if (rec.op === 'create' && isObject(rec.task) && typeof rec.task.id === 'string') { tasks.set(rec.task.id, rec.task); return true; }
    if (rec.op === 'update' && typeof rec.id === 'string' && isObject(rec.patch)) {
      const cur = tasks.get(rec.id);
      if (!cur) return false;                       // an update before its create: skipped
      tasks.set(rec.id, merge(cur, rec.patch));
      return true;
    }
    return false;
  }

  function load() {
    let data = '';
    try { data = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    endsWithNewline = data.length === 0 || data.endsWith('\n');
    for (const line of data.split('\n')) {
      if (!line.trim()) continue;
      let rec = null;
      try { rec = JSON.parse(line); } catch (_) { rec = null; }
      if (!isObject(rec) || !rec.op) { skipped++; continue; }
      if (apply(rec)) records++; else skipped++;
    }
  }

  function append(rec) {
    const line = JSON.stringify(rec) + '\n';
    fs.appendFileSync(file, (endsWithNewline ? '' : '\n') + line, 'utf8');
    endsWithNewline = true;
    records++;
  }

  function create(input) {
    const t = isObject(input) ? input : {};
    if (typeof t.request !== 'string' || !t.request.trim()) throw new TypeError('create needs a non-empty request');
    if (t.state !== undefined && t.state !== 'queued') throw new TypeError('a new task is always queued, not ' + t.state);
    if (t.id !== undefined && (typeof t.id !== 'string' || !t.id)) throw new TypeError('id must be a non-empty string');
    const at = clock();
    // Two random bytes collide about 9 percent of the time by 110 ids in a day:
    // a drawn id that is taken is drawn again. Only a caller's own id can clash.
    let id = t.id;
    if (!id) do { id = defaultId(at); } while (tasks.has(id));
    const task = Object.assign({}, clone(t), {
      id,
      createdAt: t.createdAt || at,
      source: t.source || 'typed',
      request: t.request,
      goal: t.goal || '',
      executor: t.executor || 'code',
      project: t.project || null,
      state: 'queued',
      attempt: 1,
      maxAttempts: t.maxAttempts || 2,
      session: t.session || null,
      budget: Object.assign({ turns: 40, usd: 2, ms: 600000 }, isObject(t.budget) ? t.budget : {}),
      spent: Object.assign({ turns: 0, usd: 0, ms: 0 }, isObject(t.spent) ? t.spent : {}),
      artifacts: isObject(t.artifacts) ? t.artifacts : {},
      consent: Array.isArray(t.consent) ? t.consent : [],
      lastError: t.lastError || null,
      endedAt: null,
    });
    if (tasks.has(task.id)) throw new Error('duplicate task id ' + task.id);
    tasks.set(task.id, task);
    append({ at, op: 'create', task });
    return task.id;
  }

  // Validates, merges, appends. recover() uses the raw path below.
  function update(id, patch) {
    const cur = tasks.get(id);
    if (!cur) throw new Error('unknown task ' + id);
    if (!isObject(patch)) throw new TypeError('update needs a patch object');
    for (const k of PROTECTED) if (k in patch) throw new TypeError(k + ' cannot be changed');
    const why = illegal(cur, patch);
    if (why) throw new Error(why);
    return applyPatch(id, cur, clone(patch));
  }

  function applyPatch(id, cur, patch) {
    const next = merge(cur, patch);
    const changed = patch.state !== undefined && patch.state !== cur.state;
    if (changed && (TERMINAL.includes(next.state) || (next.state === 'failed' && retryableFalse(next)))) {
      patch.endedAt = clock();
      next.endedAt = patch.endedAt;
    }
    tasks.set(id, next);
    append({ at: clock(), op: 'update', id, patch });
    return clone(next);
  }

  function get(id) { const t = tasks.get(id); return t ? clone(t) : null; }

  function list(opts) {
    const state = opts && opts.state;
    const all = [...tasks.values()].filter((t) => !state || t.state === state);
    all.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return all.map(clone);
  }

  // Boot: whatever the app left mid-flight is now interrupted. Idempotent,
  // since nothing is left in a recoverable state once it has run.
  function recover() {
    const out = [];
    for (const t of list()) {
      if (!RECOVERABLE.includes(t.state)) continue;
      const patch = { state: 'interrupted', lastError: t.lastError || { class: 'interrupted', detail: 'app restarted while ' + t.state, retryable: true } };
      out.push(applyPatch(t.id, tasks.get(t.id), patch));
    }
    return out;
  }

  // Boot: finished tasks past the age or the count leave memory and the file.
  // The file is left alone when nothing is due, so most boots write nothing.
  function compact(opts) {
    const { maxAgeDays, maxFinished } = Object.assign({}, RETENTION, opts);
    fs.rmSync(file + '.tmp', { force: true });
    const oldest = Date.parse(clock()) - maxAgeDays * DAY_MS;
    const done = [...tasks.values()].filter(finished).sort((a, b) => finishedAt(b) - finishedAt(a));
    const gone = new Set(done.filter((t, i) => i >= maxFinished || finishedAt(t) < oldest).map((t) => t.id));
    if (!gone.size) return { removed: [] };
    const at = clock();
    const kept = list().filter((t) => !gone.has(t.id));
    rewrite(file, kept.map((task) => JSON.stringify({ at, op: 'create', task }) + '\n').join(''));
    for (const id of gone) tasks.delete(id);
    records = kept.length; skipped = 0; endsWithNewline = true;
    return { removed: [...gone] };
  }

  // Every task, from memory and the file. The caller stops whatever is running.
  function clear() {
    tasks.clear();
    records = 0; skipped = 0; endsWithNewline = true;
    remove(file);
  }

  function stats() { return { records, tasks: tasks.size, skipped }; }

  load();
  return { create, update, get, list, recover, compact, clear, stats, file };
}

module.exports = { createJournal, rewrite, remove, STATES, TRANSITIONS, TERMINAL, RECOVERABLE, RETENTION };
