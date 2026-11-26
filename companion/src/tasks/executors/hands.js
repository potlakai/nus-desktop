'use strict';
// Hands as a task executor: an adapter round the existing HandsAgent, which
// is not changed. The agent keeps its loop, its cards, its bubbles, Esc and
// "keep going"; the adapter watches three of its injected dependencies
// (the actions, the consent store and send) and turns what it sees into
// task events for the supervisor:
//
//   each action the agent carries out    -> step { n, line }, a verb line, never the model's prose;
//                                           total stays null, since the budget is a cap and Hands does not know its steps
//   a card by the Knot                   -> needs_input { kind: 'consent' } and, when it is answered, answered
//   out of steps, or the person wandered -> needs_input { kind: 'keep_going' }; "keep going" or Keep going answers it
//   the run's outcome                    -> done, cancelled or failed
//   a task the focus guard refuses       -> cancelled, before the agent starts
//   a window, file or URL it acted in    -> source, for a project; never the words it typed
//
// A window counts as a source only when an action ran in it and its app is one
// the task holds (the agent's own rule for what a task works in), so a window
// that merely came to the front is never recorded. Nothing is seen between tasks.
//
// Only one Hands task runs at a time (the supervisor has one slot, the agent
// one loop). A Hands error is never retried: the screen is not a worktree
// that can be reset, and a second run could redo clicks already made.
const { RESUME_WINDOW_MS, isSwitcher } = require('../../hands/agent');
const { scrubTyped, holdsTyped, cleanUrl } = require('../projects');

function clip(s, n) { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

// The one-line verb for an action, for the status line and the journal.
function stepLine(action, ctx, agent) {
  const name = String(action && action.name || '');
  const a = (action && action.args) || {};
  let target = '';
  try {
    if (agent && agent.d && agent.d.actions && typeof agent.d.actions.findElement === 'function' && ctx && ctx.elements) {
      const el = agent.d.actions.findElement({ id: a.id, text: name === 'type' ? a.text_target : a.text, near: a.near }, ctx.elements);
      if (el && el.name) target = el.name;
    }
  } catch (_) { target = ''; }
  const q = (s) => (s ? ' "' + clip(s, 40) + '"' : '');
  switch (name) {
    case 'click': return 'Clicking' + q(target || a.text);
    case 'type': return 'Typing' + (target ? ' into' + q(target) : '');
    case 'press': return 'Pressing ' + clip(a.keys || 'a key', 30);
    case 'scroll': return 'Scrolling' + (a.direction ? ' ' + clip(a.direction, 10) : '');
    case 'drag': return 'Dragging' + q(a.text || '');
    case 'open_app': return 'Opening ' + clip(a.name || 'an app', 40);
    case 'open_url': return 'Opening a page';
    case 'web_search': return 'Searching the web';
    case 'find_files': return 'Looking for a file';
    case 'open_file': return 'Opening a file';
    case 'wait': return 'Waiting';
    case 'tidy': return 'Tidying ' + clip(a.folder || 'the folder', 40);
    default: return name ? name.charAt(0).toUpperCase() + name.slice(1).replace(/_/g, ' ') : 'Working';
  }
}

// What the agent is told it already did: only verb lines the journal kept.
function carried(task, resumed) {
  if (task.context && Array.isArray(task.context.history)) return task.context.history;
  if (!resumed || !task.progress || !task.progress.line) return undefined;
  return [{ prose: 'Before Nūs closed, the last step was: ' + clip(task.progress.line, 100) + '. Check the screen and do not redo finished steps.', results: [] }];
}

const KEEP_GOING_OPTIONS = [{ id: 'keep-going', label: 'Keep going', primary: true }, { id: 'stop', label: 'Stop' }];
const CONSENT_OPTIONS = [{ id: 'hands-yes', label: 'Yes', primary: true }, { id: 'hands-no', label: 'Not now' }];

// agent: () => HandsAgent (built lazily by the host). now and setTimer for tests.
// refuse(task): the host's line when the focus guard keeps the person off what this task opens.
function createHandsExecutor({ agent: getAgent, now, setTimer, clearTimer, log, refuse } = {}) {
  if (typeof getAgent !== 'function') throw new TypeError('createHandsExecutor needs agent()');
  const clock = typeof now === 'function' ? now : () => Date.now();
  const timer = typeof setTimer === 'function' ? setTimer : (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; };
  const untimer = typeof clearTimer === 'function' ? clearTimer : (t) => clearTimeout(t);
  const say = typeof log === 'function' ? log : () => {};
  let live = null;          // the task being run: { task, ctx, agent, hold, cardId, lastText, steps }
  let wrapped = null;       // the agent instance whose deps are wrapped

  // The three dependencies are wrapped once per agent instance and pass
  // straight through; the wrappers only speak while a task is live.
  function wrap(agent) {
    if (wrapped === agent) return;
    wrapped = agent;
    const d = agent.d;
    const read = d.read;
    d.read = async () => { const screen = await read(); if (live && live.agent === agent) live.lastRead = screen; return screen; };
    const actions = d.actions, runAction = actions.run.bind(actions);
    actions.run = (name, args, ctx) => {
      if (live && live.agent === agent) {
        live.steps++;
        const T = agent.task;
        noteAction(name, args, ctx, T);
        live.ctx.emit('step', { n: (live.base || 0) + (T ? T.steps + 1 : live.steps), total: null, line: stepLine({ name, args }, ctx, agent), goal: T ? scrubTyped(T.goal, live.typed) : '', ask: T ? scrubTyped(T.request, live.typed) : '' });
      }
      return runAction(name, args, ctx);
    };
    if (d.consent && d.consent.pending) {
      const pending = d.consent.pending, askCard = pending.ask.bind(pending);
      pending.ask = (card, action, ctx) => {
        const p = askCard(card, action, ctx);
        if (live && live.agent === agent) {
          const id = 'c' + (++live.cards);
          live.cardId = id;
          live.ctx.emit('needs_input', { id, kind: 'consent', text: card.title, hint: card.detail || '', options: CONSENT_OPTIONS });
          p.then((ans) => { if (live && live.cardId === id) { live.cardId = null; live.ctx.emit('answered', { id, value: ans && ans.answered ? Boolean(ans.yes) : null, how: ans ? (ans.answered ? ans.how : ans.reason || 'cancelled') : 'cancelled' }); } }, () => {});
        }
        return p;
      };
    }
    const send = d.send;
    d.send = (channel, payload) => {
      if (live && live.agent === agent && channel === 'guide:bubble' && payload && payload.task === 'hands' && payload.text) live.lastText = String(payload.text);
      return send(channel, payload);
    };
    // "Keep going" from the host (index.js) resumes the agent itself; the
    // live task notices and carries on as the same task.
    const resume = agent.resume.bind(agent);
    agent.resume = (source, opts) => {
      const holding = live && live.agent === agent && live.hold;
      const out = resume(source, opts);
      if (holding && out) answerHold(true, live.resumeHow || 'voice', out);
      return out;
    };
  }

  // What this action tells a project: the window it ran in, the page or file it
  // opened. The words it types are held in memory for this run only, so nothing
  // kept can quote them; they are never written anywhere by this adapter.
  function noteAction(name, args, ctx, T) {
    const L = live, a = args || {};
    if (name === 'type' && a.text) L.typed.push(String(a.text));
    const fg = (ctx && ctx.fg) || (L.lastRead && L.lastRead.fg);
    if (fg && fg.title && T && T.apps && T.apps.has(String(fg.process || '').toLowerCase()) && !isSwitcher(fg) && !/^program manager$/i.test(String(fg.title).trim()) && !holdsTyped(fg.title, L.typed)) {
      L.ctx.emit('source', { kind: 'window', value: clip(fg.title, 200), process: clip(fg.process, 60) });
    }
    if (name === 'open_url' && a.url) {
      const u = cleanUrl(/^[a-z]+:/i.test(String(a.url)) ? a.url : 'https://' + a.url);
      if (u && !holdsTyped(u, L.typed)) L.ctx.emit('source', { kind: 'url', value: u });
    }
    if (name === 'open_file' && ctx && Array.isArray(ctx.files)) {
      const hit = ctx.files[Number(a.index) - 1];
      if (hit && hit.path && !holdsTyped(hit.path, L.typed)) L.ctx.emit('source', { kind: 'file', value: String(hit.path) });
    }
  }

  // Out of steps: the task parks on a Keep going card. The hold ends on an
  // answer, on "keep going" said to the host, on a cancel, or when the
  // agent's own resume window has passed.
  function hold(text) {
    const L = live;
    return new Promise((resolve) => {
      const id = 'k' + (++L.cards);
      L.hold = { id, resolve, timer: timer(() => { if (L.hold && L.hold.id === id) { L.hold = null; L.ctx.emit('answered', { id, value: null, how: 'expired' }); resolve({ go: false }); } }, RESUME_WINDOW_MS) };
      L.ctx.emit('needs_input', { id, kind: 'keep_going', text: clip(text, 200), hint: '', options: KEEP_GOING_OPTIONS });
    });
  }
  function answerHold(go, how, runPromise) {
    const L = live;
    if (!L || !L.hold) return false;
    const h = L.hold; L.hold = null;
    untimer(h.timer);
    L.ctx.emit('answered', { id: h.id, value: Boolean(go), how: how || 'button' });
    h.resolve({ go: Boolean(go), run: runPromise || null });
    return true;
  }

  async function run(task, ctx) {
    const agent = getAgent();
    if (!agent) throw Object.assign(new Error('Hands is not available'), { class: 'unavailable' });
    if (live) throw Object.assign(new Error('Hands is on another task'), { class: 'busy' });
    wrap(agent);
    live = { task, ctx, agent, hold: null, cardId: null, lastText: '', steps: 0, cards: 0, typed: [], lastRead: null, base: 0 };
    const onAbort = () => { const reason = ctx.signal && typeof ctx.signal.reason === 'string' ? ctx.signal.reason : 'task'; if (live && live.hold) answerHold(false, reason); try { agent.stop(reason); } catch (e) { say('stop: ' + e.message); } };
    if (ctx.signal) { if (ctx.signal.aborted) { live = null; return; } ctx.signal.addEventListener('abort', onAbort, { once: true }); }
    try {
      ctx.emit('started', {});
      // Queued, or reopened from a project, before the guard came on: it does not run now.
      if (typeof refuse === 'function' && refuse(task)) { ctx.emit('cancelled', { reason: 'guarded' }); return; }
      const source = task.source === 'voice' ? 'voice' : 'typed';
      // Picked up after a restart: the model is told how far the last run got,
      // so it looks at the screen and does not redo finished steps.
      const history = carried(task, ctx.resumed);
      if (ctx.resumed && task.progress) live.base = task.progress.n || 0;
      const started = await agent.run(task.request, source, { askedAt: ctx.resumed ? clock() : Date.parse(task.createdAt) || clock(), goal: task.goal || undefined, history });
      if (!started) { ctx.emit('failed', { class: 'busy', detail: 'Hands could not start: it is still on the last task.', retryable: false }); return; }
      // The run ended; the agent's last run says how. A budget or an away
      // stop parks the task on Keep going and the loop resumes as the same task.
      for (;;) {
        if (ctx.signal && ctx.signal.aborted) return;
        const last = agent.last || {};
        const outcome = String(last.outcome || 'ok');
        const text = live.lastText;
        if (outcome === 'budget' || outcome === 'away') {
          const h = await hold(text || 'That is as far as I got in one go.');
          if (ctx.signal && ctx.signal.aborted) return;
          if (!h.go) { ctx.emit('outcome', { outcome }); ctx.emit('done', { summary: scrubTyped(text, live.typed), outcome }); return; }
          // Resumed by the host already, or by the answer here.
          if (h.run) await h.run; else { const ok = await agent.resume(source, {}); if (!ok) { ctx.emit('outcome', { outcome }); ctx.emit('done', { summary: scrubTyped(text, live.typed), outcome }); return; } }
          continue;
        }
        if (outcome === 'stopped') { ctx.emit('cancelled', { reason: 'stopped' }); return; }
        if (outcome === 'declined') { ctx.emit('cancelled', { reason: 'declined' }); return; }
        if (outcome === 'guarded') { ctx.emit('cancelled', { reason: 'guarded' }); return; }
        if (outcome === 'error') { ctx.emit('failed', { class: /took too long|timed out/i.test(text) ? 'timeout' : 'model', detail: text || 'Hands could not keep going.', retryable: false }); return; }
        ctx.emit('done', { summary: scrubTyped(text, live.typed), outcome, steps: last.steps || 0 });
        return;
      }
    } finally {
      if (ctx.signal) ctx.signal.removeEventListener('abort', onAbort);
      if (live && live.hold) { untimer(live.hold.timer); live.hold = null; }
      live = null;
    }
  }

  // A button or a spoken answer that came through the supervisor: the card by
  // the Knot goes to the agent's own store (the same path as its buttons);
  // the Keep going card resumes or ends the task.
  function answer(task, value, how) {
    if (!live || live.task.id !== task.id) return false;
    if (live.hold) {
      if (value) { live.resumeHow = how; const p = live.agent.resume(live.task.source === 'voice' ? 'voice' : 'typed', {}); if (live && live.hold) answerHold(true, how, p && typeof p.then === 'function' ? p : null); return true; }
      return answerHold(false, how);
    }
    return live.agent.answer(Boolean(value));
  }

  return { name: 'hands', paints: true, holdAfterRestart: true, canRun: (t) => t && t.executor === 'hands', run, answer, stepLine, get live() { return live ? live.task : null; } };
}

module.exports = { createHandsExecutor, stepLine, KEEP_GOING_OPTIONS, CONSENT_OPTIONS };
