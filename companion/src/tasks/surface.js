'use strict';
// The surface adapter: task events to what the person sees. One channel to
// the overlay renderer, tasks:event, carries every event with the task's
// snapshot (the pill's task list reads it); the Knot's own messages
// (guide:state, guide:bubble, guide:hint) are sent for executors that do not
// paint for themselves. Hands paints its own bubbles and cards, so for a
// Hands task only tasks:event goes out.
//
// What is hidden on purpose: turn counts, tool names beyond the one verb
// line, session ids, paths. Progress lines are replaced at most every 2 s.
const PROGRESS_EVERY_MS = 2000;

function clip(s, n) { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function bubbleId(id) { return 'task:' + id; }

// The spoken or shown words for a task's end.
function doneLine(task, data) {
  const s = data && data.summary ? String(data.summary) : (task.artifacts && task.artifacts.summary) || '';
  return s || 'Done.';
}
function failedLine(data) { return 'I could not finish: ' + clip((data && data.detail) || 'something went wrong', 160); }

// send(channel, payload): the overlay. paints(task): true when the executor
// paints its own Knot (Hands). now for the throttle.
function createSurface({ send, paints, now, list } = {}) {
  if (typeof send !== 'function') throw new TypeError('createSurface needs send()');
  const clock = typeof now === 'function' ? now : () => Date.now();
  const selfPainting = typeof paints === 'function' ? paints : (task) => task && task.executor === 'hands';
  let lastProgressAt = 0;

  function onEvent(ev, task) {
    if (!ev || !task) return;
    send('tasks:event', { type: ev.type, id: ev.id, at: ev.at, data: ev.data || {}, state: ev.state || task.state, task: snapshot(task) });
    if (selfPainting(task)) return;
    const voice = task.source === 'voice';
    const sid = bubbleId(task.id);
    switch (ev.type) {
      case 'started':
        send('guide:state', { state: 'thinking', task: 'task' });
        send('guide:hint', { text: 'On it: ' + clip(task.goal || task.request, 80), ms: 6000 });
        return;
      case 'step': {
        const t = clock();
        if (t - lastProgressAt < PROGRESS_EVERY_MS) return;
        lastProgressAt = t;
        send('guide:hint', { text: clip(ev.data.line, 80), ms: 4000 });
        return;
      }
      case 'needs_input': {
        const q = ev.data;
        send('guide:state', { state: 'pointing', task: 'task' });
        send('guide:bubble', { text: q.text, hint: q.hint || '', kicker: q.kind === 'keep_going' ? 'paused' : 'ask first', anchor: 'knot', task: 'task', actions: (q.options || []).map((o) => ({ id: 'task-' + o.id, label: o.label, primary: Boolean(o.primary) })), sessionId: sid, speak: voice ? q.text : undefined });
        return;
      }
      case 'answered':
        send('guide:state', { state: 'thinking', task: 'task' });
        return;
      case 'review': {
        const text = clip(ev.data.summary || 'Ready to view.', 200);
        send('guide:state', { state: 'idle', task: 'task' });
        send('guide:bubble', { text, kicker: 'ready to view', anchor: 'knot', task: 'task', actions: [{ id: 'task-apply', label: 'Apply', primary: true }, { id: 'task-discard', label: 'Discard' }], sessionId: sid, speak: voice ? text : undefined });
        return;
      }
      case 'done': {
        const text = doneLine(task, ev.data);
        send('guide:state', { state: 'idle', task: 'task' });
        send('guide:bubble', { text, kicker: 'done', anchor: 'knot', task: 'task', actions: [{ id: 'dismiss', label: 'OK' }], sessionId: sid, speak: voice ? text : undefined });
        return;
      }
      case 'failed': {
        const text = failedLine(ev.data);
        send('guide:state', { state: 'idle', task: 'task' });
        send('guide:bubble', { text, kicker: '', kind: 'error', anchor: 'knot', task: 'task', actions: [{ id: 'dismiss', label: 'OK' }], sessionId: sid, speak: voice ? text : undefined });
        return;
      }
      case 'cancelled':
      case 'applied':
      case 'discarded':
        send('guide:state', { state: 'idle', task: 'task' });
        return;
      default:
        return;
    }
  }

  // The whole list, for a renderer that just loaded or a panel that opened.
  function sync(tasks, extra) { send('tasks:event', Object.assign({ type: 'sync', tasks: (tasks || []).map(snapshot) }, extra || {})); }

  return { onEvent, sync, snapshot, bubbleId };
}

// What the renderer gets to see of a task: never the typed words beyond the
// request line it already heard, never paths or session ids.
function snapshot(t) {
  if (!t) return null;
  return {
    id: t.id, createdAt: t.createdAt, endedAt: t.endedAt || null, state: t.state, source: t.source, executor: t.executor,
    request: clip(t.request, 120), goal: clip(t.goal || '', 120),
    summary: clip((t.artifacts && t.artifacts.summary) || '', 200),
    progress: t.progress ? { n: t.progress.n, total: t.progress.total, line: t.progress.line } : null,
    question: t.question ? { id: t.question.id, kind: t.question.kind, text: t.question.text, hint: t.question.hint || '', options: t.question.options } : null,
    error: t.lastError ? { class: t.lastError.class, detail: clip(t.lastError.detail, 160) } : null,
    project: t.project && t.project.name ? { name: t.project.name } : null,
    attempt: t.attempt, maxAttempts: t.maxAttempts, held: Boolean(t.held), outcome: t.outcome || null,
  };
}

module.exports = { createSurface, snapshot, bubbleId, doneLine, failedLine, PROGRESS_EVERY_MS };
