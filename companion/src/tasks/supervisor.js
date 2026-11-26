'use strict';
// The task supervisor: the one thing that starts, cancels, retries and resumes
// an executor. It owns a FIFO queue with one slot (Hands and a coding session
// share it, so the screen and the voice are never contended), writes every
// state change to the journal, and keeps an events file beside it.
//
// Executors share one small interface and never touch the journal:
//   { name, canRun(task), run(task, ctx) -> Promise, answer?(task, value) }
//   ctx.signal      an AbortSignal: a cancel is cooperative, the executor stops
//   ctx.emit(type, data)   started | step | needs_input | answered | review | done | failed
//   ctx.ask(question)      -> Promise<value>: parks the task in needs_input
//
// Event shapes (plan section B.5, as the surface reads them):
//   started     { executor, attempt }
//   step        { n, total, line }              one verb line, never the model's prose
//   needs_input { id, kind, text, options }     options: [{ id, label, primary }]
//   answered    { id, value, how }
//   review      { summary, artifacts }          waits for apply(id) or discard(id)
//   done        { summary, outcome }            the executor verified its own work
//   failed      { class, detail, retryable }    retryable is decided here, by class
//   cancelled   { reason }                      the person stopped it at the executor itself
//   source      { kind, value, process }        a window, file or URL the task acted in; kept on the task, never an event
// The supervisor adds queued, preparing, cancelled, interrupted, resumed,
// applied, discarded and retry. Every event is { at, id, type, data, state }.
//
// One row per run goes to the usage ledger (feature 'task') when a ledger is
// given: timings.first_progress is ms from the run starting to its first step,
// timings.cancel is ms from the signal to the executor settling, timings.queued
// is the wait for the slot. The note is the task's id, never its words.
//
// Pure Node: the clock and the timer are injectable so the backoff is tested
// without waiting. No Electron.
const fs = require('fs');
const path = require('path');
const { rewrite, remove } = require('./journal');

// Error classes worth a second try: the model or the process went quiet, not
// the task itself. Anything else (auth, spend, refusal, declined) is final.
const TRANSIENT = ['timeout', 'model_timeout', 'cli_spawn_failed', 'api_retry', 'worktree_busy', 'network'];
const BACKOFF_MS = [5000, 20000];
const EVENTS_FILE = 'events.jsonl';
const MAX_SOURCES = 40;
// How long a delete waits on a cancel before it goes ahead without the executor.
const CLEAR_WAIT_MS = 5000;

function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function clip(s, n) { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function msSince(iso, nowMs) { const t = Date.parse(iso); return Number.isFinite(t) ? Math.max(0, nowMs - t) : null; }

function createSupervisor({ journal, executors, now, setTimer, clearTimer, log, onEvent, ledger } = {}) {
  if (!journal || typeof journal.create !== 'function') throw new TypeError('createSupervisor needs a journal');
  const execs = Array.isArray(executors) ? executors.slice() : [];
  const clock = typeof now === 'function' ? now : () => Date.now();
  const timer = typeof setTimer === 'function' ? setTimer : (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; };
  const untimer = typeof clearTimer === 'function' ? clearTimer : (t) => clearTimeout(t);
  const say = typeof log === 'function' ? log : () => {};
  const listeners = [];
  if (typeof onEvent === 'function') listeners.push(onEvent);
  const eventsFile = path.join(path.dirname(journal.file), EVENTS_FILE);
  let current = null;        // { id, executor, abort, gen, pending, cancelAt, resolveCancel }
  let gen = 0;
  const retryTimers = new Map();
  let pumping = false;
  let clearing = false;

  function iso() { return new Date(clock()).toISOString(); }

  function addExecutor(ex) { if (ex && typeof ex.run === 'function') execs.push(ex); }
  function executorFor(task) { return execs.find((e) => (typeof e.canRun === 'function' ? e.canRun(task) : e.name === task.executor)) || null; }

  function record(id, type, data) {
    let state = null;
    const t = journal.get(id);
    if (t) state = t.state;
    const ev = { at: iso(), id, type, data: data === undefined ? {} : data, state };
    try { fs.appendFileSync(eventsFile, JSON.stringify(ev) + '\n', 'utf8'); } catch (e) { say('events write failed: ' + e.message); }
    for (const fn of listeners) { try { fn(ev); } catch (_) { /* a listener never breaks a task */ } }
    return ev;
  }

  // A patch that is legal now; an illegal one is logged, never thrown at an executor.
  function patch(id, p) {
    try { return journal.update(id, p); } catch (e) { say('journal: ' + e.message); return journal.get(id); }
  }

  // The run's one row for the bench. A ledger never breaks a task.
  function ledgerRow(run, outcome) {
    if (!ledger || run.rowed) return;
    run.rowed = true;
    const m = (journal.get(run.id) || {}).metrics || {};
    const timings = {};
    if (run.firstStepMs != null) timings.first_progress = run.firstStepMs;
    if (run.queuedMs != null) timings.queued = run.queuedMs;
    if (m.cancel != null && run.cancelAt) timings.cancel = m.cancel;
    try { ledger.record({ feature: 'task', provider: ex(run), outcome, ms: clock() - run.startedAt, timings, note: run.id }); } catch (e) { say('ledger: ' + e.message); }
  }

  function metricsPatch(id, more) {
    const t = journal.get(id);
    return { metrics: Object.assign({}, (t && t.metrics) || {}, more) };
  }

  // ---- the queue ---------------------------------------------------------
  function submit(input) {
    const id = journal.create(input);
    record(id, 'queued', { request: clip(journal.get(id).request, 200) });
    pump();
    return id;
  }

  function pump() {
    if (pumping || current || clearing) return;
    const next = journal.list({ state: 'queued' }).find((t) => !t.held);
    if (!next) return;
    pumping = true;
    try { start(next); } finally { pumping = false; }
  }

  function start(task) {
    const ex = executorFor(task);
    patch(task.id, { state: 'preparing' });
    record(task.id, 'preparing', { executor: ex ? ex.name : null });
    if (!ex) {
      fail(task.id, { class: 'no_executor', detail: 'nothing can run a ' + task.executor + ' task', retryable: false }, null);
      return;
    }
    launch(journal.get(task.id), ex, false);
  }

  function launch(task, ex, resumed) {
    const g = ++gen;
    const abort = typeof AbortController === 'function' ? new AbortController() : { signal: undefined, abort() {} };
    const run = { id: task.id, executor: ex, abort, gen: g, pending: null, cancelAt: 0, resolveCancel: null, startedAt: clock(), firstStep: false, firstStepMs: null, queuedMs: resumed ? null : msSince(task.createdAt, clock()), rowed: false };
    current = run;
    const ctx = {
      signal: abort.signal,
      emit: (type, data) => { if (g === gen && current === run) onExecutorEvent(run, type, data); },
      ask: (question) => askFrom(run, question),
      resumed: Boolean(resumed),
    };
    let p;
    try { p = Promise.resolve(ex.run(task, ctx)); }
    catch (e) { p = Promise.reject(e); }
    p.then(() => settle(run, null), (e) => settle(run, e));
  }

  // The run promise settled: whatever the events said stands; a run that
  // ended with no verdict is a failure of the executor, not the task. The
  // next task starts only from here, once the executor has truly returned.
  function settle(run, err) {
    if (run.ended) { pump(); return; }
    if (current !== run) return;
    const t = journal.get(run.id);
    if (run.cancelAt) {
      const ms = clock() - run.cancelAt;
      patch(run.id, metricsPatch(run.id, { cancel: ms }));
      record(run.id, 'cancelled', { reason: run.cancelReason || 'user', ms });
      ledgerRow(run, 'stopped');
      if (run.resolveCancel) run.resolveCancel(ms);
      current = null;
      pump();
      return;
    }
    if (err) { fail(run.id, { class: err && err.class ? String(err.class) : 'executor', detail: clip(err && err.message ? err.message : err, 300) }, run); pump(); return; }
    if (t && ['preparing', 'running', 'needs_input', 'verifying'].includes(t.state)) {
      fail(run.id, { class: 'executor', detail: ex(run) + ' ended without a result', retryable: false }, run);
      pump();
      return;
    }
    if (t && t.state === 'review') ledgerRow(run, 'review');
    current = null;
    pump();
  }
  function ended(run) { if (current === run) current = null; run.ended = true; }
  function ex(run) { return run && run.executor ? run.executor.name : 'the executor'; }

  function onExecutorEvent(run, type, data) {
    const id = run.id;
    const d = isObject(data) ? data : {};
    const t = journal.get(id);
    if (!t || run.cancelAt) return;          // after a cancel, the executor's last words are not heard
    if (type === 'started') {
      if (t.state === 'preparing') patch(id, { state: 'running' });
      patch(id, metricsPatch(id, { started: msSince(t.createdAt, clock()) }));
      record(id, 'started', { executor: ex(run), attempt: t.attempt });
      return;
    }
    if (type === 'step') {
      const n = Number(d.n) || ((t.progress && t.progress.n) || 0) + 1;
      const p = { progress: { n, total: Number.isFinite(Number(d.total)) && d.total != null ? Number(d.total) : null, line: clip(d.line, 120) }, spent: { turns: n } };
      // The goal an executor worked out for itself, kept for a resume; not an event field.
      if (d.goal && d.goal !== t.goal && d.goal !== t.request) p.goal = clip(d.goal, 200);
      // The same request with the words it has typed taken out, for a project.
      if (d.ask && d.ask !== (t.ask || t.request)) p.ask = clip(d.ask, 200);
      if (!run.firstStep) { run.firstStep = true; run.firstStepMs = clock() - run.startedAt; Object.assign(p, metricsPatch(id, { first_progress: run.firstStepMs })); }
      patch(id, p);
      record(id, 'step', { n, total: p.progress.total, line: p.progress.line });
      return;
    }
    if (type === 'needs_input') {
      const q = question(d);
      if (t.state === 'running') patch(id, { state: 'needs_input', question: q });
      record(id, 'needs_input', q);
      return;
    }
    if (type === 'answered') {
      const a = { id: String(d.id || (t.question && t.question.id) || ''), value: d.value === undefined ? null : d.value, how: String(d.how || 'button') };
      if (t.state === 'needs_input') patch(id, { state: 'running', question: null, consent: (t.consent || []).concat([{ at: iso(), kind: t.question ? t.question.kind : 'ask', text: t.question ? t.question.text : '', answer: a.value, how: a.how }]) });
      record(id, 'answered', a);
      return;
    }
    if (type === 'review') {
      const art = Object.assign({}, isObject(d.artifacts) ? d.artifacts : {}, d.summary ? { summary: clip(d.summary, 400) } : {});
      if (t.state === 'needs_input') patch(id, { state: 'running', question: null });
      if (['running', 'verifying'].includes(journal.get(id).state)) { if (journal.get(id).state === 'running') patch(id, { state: 'verifying' }); patch(id, { state: 'review', artifacts: art }); }
      record(id, 'review', { summary: art.summary || '', artifacts: art });
      return;
    }
    if (type === 'done') {
      const summary = clip(d.summary, 400);
      // The executor checked its own work (Hands' done checks): straight through
      // verifying and review to applied, each a line in the journal.
      if (t.state === 'needs_input') patch(id, { state: 'running', question: null });
      const s = journal.get(id).state;
      if (s === 'running') { patch(id, { state: 'verifying' }); patch(id, { state: 'review' }); patch(id, { state: 'applied', artifacts: { summary }, spent: { ms: clock() - run.startedAt } }); }
      else if (s === 'review') patch(id, { state: 'applied', artifacts: { summary }, spent: { ms: clock() - run.startedAt } });
      record(id, 'done', { summary, outcome: String(d.outcome || 'ok') });
      ledgerRow(run, String(d.outcome || 'ok'));
      ended(run);
      return;
    }
    if (type === 'failed') { fail(id, d, run); return; }
    if (type === 'source') {
      // On the task only: paths and titles never go out as an event.
      const have = Array.isArray(t.sources) ? t.sources : [];
      if (d.kind && d.value && !have.some((s) => s.kind === d.kind && s.value === d.value)) patch(id, { sources: have.concat([{ kind: String(d.kind), value: String(d.value), process: d.process ? String(d.process) : undefined }]).slice(-MAX_SOURCES) });
      return;
    }
    if (type === 'outcome') { patch(id, { outcome: String(d.outcome || '') }); return; }
    if (type === 'cancelled') {
      // Stopped at the executor (Esc straight to Hands, a new ask): no signal
      // was sent, so there is no latency to measure.
      if (['preparing', 'running', 'needs_input', 'verifying'].includes(t.state)) patch(id, { state: 'cancelled' });
      record(id, 'cancelled', { reason: String(d.reason || 'executor'), ms: null });
      ledgerRow(run, d.reason === 'declined' ? 'declined' : 'stopped');
      ended(run);
      return;
    }
    say('unknown event ' + type + ' from ' + ex(run));
  }

  function question(d) {
    const options = Array.isArray(d.options) ? d.options.map((o, i) => (typeof o === 'string' ? { id: 'opt-' + i, label: o, primary: i === 0 } : { id: String(o.id || 'opt-' + i), label: String(o.label || o.id || ''), primary: Boolean(o.primary) })) : [{ id: 'yes', label: 'Yes', primary: true }, { id: 'no', label: 'Not now' }];
    return { id: String(d.id || 'q' + clock().toString(36)), kind: String(d.kind || 'ask'), text: clip(d.text, 200), hint: clip(d.hint, 200), options };
  }

  function askFrom(run, q) {
    return new Promise((resolve, reject) => {
      if (current !== run || run.gen !== gen) { reject(new Error('not running')); return; }
      const qq = question(isObject(q) ? q : { text: q });
      run.pending = { id: qq.id, resolve };
      onExecutorEvent(run, 'needs_input', qq);
      if (run.abort && run.abort.signal && typeof run.abort.signal.addEventListener === 'function') run.abort.signal.addEventListener('abort', () => { if (run.pending && run.pending.id === qq.id) { run.pending = null; resolve(null); } }, { once: true });
    });
  }

  // A button on a card, or a spoken answer: the executor's own store when it
  // has one (Hands' consent card), else the question this supervisor parked.
  function answer(id, value, how) {
    const run = current && current.id === id ? current : null;
    if (!run) return false;
    if (run.pending) {
      const p = run.pending; run.pending = null;
      onExecutorEvent(run, 'answered', { id: p.id, value, how: how || 'button' });
      p.resolve(value);
      return true;
    }
    if (run.executor && typeof run.executor.answer === 'function') { try { return Boolean(run.executor.answer(journal.get(id), value, how || 'button')); } catch (e) { say('answer: ' + e.message); return false; } }
    return false;
  }

  function fail(id, d, run) {
    const t = journal.get(id);
    if (!t) return;
    const cls = String((d && d.class) || 'error');
    const retryable = d && typeof d.retryable === 'boolean' ? d.retryable : TRANSIENT.includes(cls);
    const err = { class: cls, detail: clip(d && d.detail, 300), retryable };
    if (t.state === 'needs_input') patch(id, { state: 'running', question: null });
    const s = journal.get(id).state;
    const p = { lastError: err };
    if (run) p.spent = { ms: clock() - run.startedAt };
    if (['preparing', 'running', 'verifying'].includes(s)) p.state = 'failed';
    patch(id, p);
    record(id, 'failed', err);
    if (run) { ledgerRow(run, 'error'); ended(run); }
    const after = journal.get(id);
    if (retryable && after.state === 'failed' && after.attempt < after.maxAttempts) scheduleRetry(after);
    if (!run) pump();
  }

  // 5 s after the first failure, 20 s after the second. The timer never holds
  // the process open; a cancel while it waits drops it.
  function scheduleRetry(t) {
    const delay = BACKOFF_MS[Math.min(t.attempt - 1, BACKOFF_MS.length - 1)];
    record(t.id, 'retry', { attempt: t.attempt + 1, inMs: delay });
    retryTimers.set(t.id, timer(() => {
      retryTimers.delete(t.id);
      const cur = journal.get(t.id);
      if (!cur || cur.state !== 'failed') return;
      patch(t.id, { state: 'queued', attempt: cur.attempt + 1 });
      record(t.id, 'queued', { attempt: cur.attempt + 1, retry: true });
      pump();
    }, delay));
  }

  // ---- cancel, review, resume ---------------------------------------------
  // Cooperative: the signal fires, the executor stops, and the time from the
  // signal to its promise settling is the cancel latency kept on the task.
  // Resolves with that latency (null when nothing was running).
  function cancel(id, reason) {
    const t = journal.get(id);
    if (!t) return Promise.resolve(null);
    const rt = retryTimers.get(id);
    if (rt) { untimer(rt); retryTimers.delete(id); }
    if (current && current.id === id) {
      const run = current;
      if (run.cancelAt) return run.cancelPromise;
      run.cancelAt = clock();
      run.cancelReason = reason || 'user';
      if (['preparing', 'running', 'needs_input', 'verifying', 'review'].includes(t.state)) patch(id, { state: 'cancelled' });
      run.cancelPromise = new Promise((resolve) => { run.resolveCancel = resolve; });
      try { run.abort.abort(run.cancelReason); } catch (_) { /* already done */ }
      if (run.pending) { const p = run.pending; run.pending = null; p.resolve(null); }
      return run.cancelPromise;
    }
    // A failed task waiting on its retry has no legal way to cancelled: the
    // retry is dropped and the failure becomes final instead.
    if (t.state === 'failed') { if (rt) { patch(id, { lastError: Object.assign({}, t.lastError, { retryable: false }) }); record(id, 'cancelled', { reason: reason || 'user', ms: 0 }); } return Promise.resolve(0); }
    if (['queued', 'review', 'interrupted', 'needs_input', 'running', 'preparing', 'verifying'].includes(t.state)) {
      patch(id, { state: 'cancelled' });
      record(id, 'cancelled', { reason: reason || 'user', ms: 0 });
    }
    return Promise.resolve(0);
  }

  function apply(id) { const t = journal.get(id); if (!t || t.state !== 'review') return false; patch(id, { state: 'applied' }); record(id, 'applied', {}); return true; }
  function discard(id) { const t = journal.get(id); if (!t || !['review', 'interrupted'].includes(t.state)) return false; patch(id, { state: 'discarded' }); record(id, 'discarded', {}); return true; }

  // Boot: whatever the last run left mid-flight is interrupted now; queued
  // tasks start. A queued task whose executor drives the screen (holdAfterRestart)
  // is held instead: nothing clicks on a launch nobody is watching, and it waits
  // for release(id). Returns the interrupted ones so the host may offer "pick it up".
  function boot() {
    try { const { removed } = compact(); if (removed.length) say('compacted ' + removed.length + ' finished task(s)'); }
    catch (e) { say('compact failed: ' + e.message); }   // old tasks staying a while never stops a boot
    const interrupted = journal.recover();
    for (const t of interrupted) record(t.id, 'interrupted', { was: t.lastError ? t.lastError.detail : '' });
    for (const t of journal.list({ state: 'queued' })) {
      const ex = executorFor(t);
      if (ex && ex.holdAfterRestart && !t.held) { patch(t.id, { held: true }); record(t.id, 'held', {}); }
    }
    pump();
    return interrupted;
  }

  // The retention rule (journal.js): the journal drops what is due, and the
  // events file keeps only the lines of tasks still in it. Decided by what is
  // left, not what just went, so a crash between the two is tidied next boot.
  function compact(opts) {
    const out = journal.compact(opts);
    let data = '';
    try { data = fs.readFileSync(eventsFile, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; return out; }
    const lines = data.split('\n').filter((l) => l.trim());
    const kept = lines.filter((l) => { try { return Boolean(journal.get(JSON.parse(l).id)); } catch (_) { return false; } });
    if (kept.length < lines.length) rewrite(eventsFile, kept.map((l) => l + '\n').join(''));
    return out;
  }

  // Delete everything: the journal, the events and the queue. The task running
  // is cancelled first, so its last writes land before the files go, and nothing
  // queued starts in the gap. An executor that never answers is left behind after
  // CLEAR_WAIT_MS: what it says from then on is not heard, so it cannot write.
  async function clear(opts) {
    const waitMs = opts && Number.isFinite(opts.waitMs) ? opts.waitMs : CLEAR_WAIT_MS;
    clearing = true;
    try {
      for (const t of retryTimers.values()) untimer(t);
      retryTimers.clear();
      if (current) {
        const run = current;
        let wait = null;
        await Promise.race([cancel(run.id, 'deleted'), new Promise((resolve) => { wait = timer(resolve, waitMs); })]);
        untimer(wait);
        if (current === run) { gen++; current = null; say('delete went ahead without ' + ex(run)); }
      }
      journal.clear();
      remove(eventsFile);
    } finally { clearing = false; }
  }

  // The person said go on a held task: it takes its place in the queue again.
  function release(id) {
    const t = journal.get(id);
    if (!t || t.state !== 'queued' || !t.held) return false;
    patch(id, { held: false });
    record(id, 'released', {});
    pump();
    return true;
  }

  // Pick an interrupted task back up: the executor runs it again with
  // ctx.resumed set and the task's own progress and project context on it.
  function resume(id) {
    const t = journal.get(id);
    if (!t || t.state !== 'interrupted' || current) return false;
    const ex = executorFor(t);
    if (!ex) { fail(id, { class: 'no_executor', detail: 'nothing can run a ' + t.executor + ' task', retryable: false }, null); return false; }
    patch(id, { state: 'running', lastError: null });
    record(id, 'resumed', { executor: ex.name });
    launch(journal.get(id), ex, true);
    return true;
  }

  // A task was kept as a project: the name goes on the task, and the list hears.
  function setProject(id, project) {
    if (!journal.get(id)) return null;
    const t = patch(id, { project });
    record(id, 'project', { name: project && project.name ? project.name : '' });
    return t;
  }

  function on(fn) { if (typeof fn === 'function') listeners.push(fn); return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); }; }
  function events(id, limit) {
    let data = '';
    try { data = fs.readFileSync(eventsFile, 'utf8'); } catch (_) { return []; }
    const out = [];
    for (const line of data.split('\n')) { if (!line.trim()) continue; try { const ev = JSON.parse(line); if (!id || ev.id === id) out.push(ev); } catch (_) { /* a torn line */ } }
    return limit ? out.slice(-limit) : out;
  }
  function running() { return current ? journal.get(current.id) : null; }
  function get(id) { return journal.get(id); }
  function list(opts) { return journal.list(opts); }
  function dispose() { for (const t of retryTimers.values()) untimer(t); retryTimers.clear(); }

  return { submit, cancel, answer, apply, discard, boot, compact, clear, release, resume, setProject, on, events, running, get, list, addExecutor, dispose, eventsFile, TRANSIENT, BACKOFF_MS };
}

module.exports = { createSupervisor, TRANSIENT, BACKOFF_MS, CLEAR_WAIT_MS };
