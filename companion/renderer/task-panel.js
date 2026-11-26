// The task panel: the island pill unfolds into the task list (renders-0115, O6),
// and the free Knot shows the same list beside it on a hover (create() again, with
// its own host).
// A greeting and a count line, one straight card per task with its state word,
// one line of summary, a small bar when the steps are known, "+N more", and a
// follow-up view for one task. Needs-you cards come first and wear the Knot's line.
//
// It reads only what tasks:event carries from the supervisor: no model call, no
// IPC of its own. Its buttons go out on the channel the Knot's card already uses,
// and a Hands card's Yes and Not now are the very same actions as the Knot's.
//
// Everything a task says goes in through textContent, never as markup: a task's
// words can quote a web page or a window title.
//
// It opens only on the person's own click. No task event ever opens it, and it
// folds itself once the pointer has left: live 2026-11-03 it stayed open from one
// click on, growing over the person's work through every task after.
//
// The list logic is plain functions so the tests run it in Node.
(function (root) {
  'use strict';

  const STATE_WORDS = { queued: 'Up next', preparing: 'Working', running: 'Working', verifying: 'Checking', needs_input: 'Needs you', review: 'Ready to view', applied: 'Done', failed: 'Did not work', interrupted: 'Stopped' };
  // These leave the list.
  const GONE = ['cancelled', 'discarded'];
  const RANK = { needs_input: 0, preparing: 1, running: 1, verifying: 1, review: 2, interrupted: 3, queued: 4, failed: 5, applied: 6 };
  const VISIBLE = 3;
  const FINISHED_FOR_MS = 24 * 3600 * 1000;   // a finished card stays a day
  const FOLD_AFTER_MS = 6000;                  // the pointer gone this long, and the open list folds, as the menu does
  const HOVER_OPEN_MS = 400;                   // on the free Knot this long, and the list slides out
  const HOVER_LEAVE_MS = 1000;                 // off the Knot and the list this long, and it goes

  function wordFor(state) { return STATE_WORDS[state] || null; }

  function listed(tasks, opts) {
    const now = opts && opts.now != null ? opts.now : Date.now();
    return (tasks || []).filter((t) => {
      if (!t || GONE.includes(t.state) || !STATE_WORDS[t.state]) return false;
      if (t.state === 'applied' || t.state === 'failed') { const at = Date.parse(t.endedAt || t.createdAt); return !Number.isFinite(at) || now - at < FINISHED_FOR_MS; }
      return true;
    }).sort((a, b) => {
      const ra = RANK[a.state], rb = RANK[b.state];
      if (ra !== rb) return ra - rb;
      const older = String(a.createdAt) < String(b.createdAt) ? -1 : String(a.createdAt) > String(b.createdAt) ? 1 : 0;
      return ra >= 5 ? -older : older;   // finished: newest first; the rest in the order asked
    });
  }

  // -> { cards, more, count }. Every needs-you card shows, however many there are.
  function panelView(tasks, opts) {
    const all = listed(tasks, opts);
    const needs = all.filter((t) => t.state === 'needs_input').length;
    const room = opts && opts.expanded ? all.length : Math.max(VISIBLE, needs);
    return { cards: all.slice(0, room), more: Math.max(0, all.length - room), count: countLine(all) };
  }

  function countLine(all) {
    const n = (states) => all.filter((t) => states.includes(t.state)).length;
    const parts = [];
    const working = n(['preparing', 'running', 'verifying']), needs = n(['needs_input']), next = n(['queued']);
    if (working) parts.push(working + ' working');
    if (needs) parts.push(needs + ' needs you');
    if (next) parts.push(next + ' up next');
    if (parts.length) return parts.join(', ');
    return all.length ? 'Nothing running' : 'No tasks yet';
  }

  function greeting(hour, name) {
    const word = hour < 12 ? 'Morning' : hour < 18 ? 'Afternoon' : 'Evening';
    const first = String(name || '').trim();
    return first ? word + ', ' + first + '.' : word + '.';
  }

  function cardTitle(t) { return (t.project && t.project.name) || t.goal || t.request || 'A task'; }

  function cardLine(t) {
    const line = t.progress && t.progress.line;
    switch (t.state) {
      case 'needs_input': return (t.question && t.question.text) || 'Waiting for you.';
      case 'preparing': case 'running': return line || 'Starting.';
      case 'verifying': return 'Checking the result.';
      case 'review': return t.summary || 'Ready for you to look at.';
      case 'applied': return t.summary || 'Finished.';
      case 'failed': { const d = String((t.error && t.error.detail) || 'Something went wrong.'); return d.charAt(0).toUpperCase() + d.slice(1); }
      case 'interrupted': return line ? 'Got as far as: ' + line : 'It stopped when Nūs closed.';
      case 'queued': return t.held ? 'Waiting for you to start it.' : 'After the one before it.';
      default: return '';
    }
  }

  // Only when the steps are really known. Hands does not know its own.
  function progressOf(t) {
    const p = t.progress;
    if (!p || !(p.total > 0) || !['preparing', 'running', 'verifying'].includes(t.state)) return null;
    return Math.max(0, Math.min(1, (Number(p.n) || 0) / p.total));
  }

  function whatsLeft(t) {
    const goal = t.goal || t.request || '';
    switch (t.state) {
      case 'needs_input': return [(t.question && t.question.text) || 'Your answer'].concat(goal ? ['Then: ' + goal] : []);
      case 'preparing': case 'running': {
        const p = t.progress, left = p && p.total > 0 ? p.total - p.n : 0;
        return [left > 0 ? left + (left === 1 ? ' more step' : ' more steps') : goal ? 'Finish: ' + goal : 'Finish the task'];
      }
      case 'verifying': return ['Checking the result'];
      case 'review': return ['Look it over, then Apply or Discard'];
      case 'interrupted': return [t.progress && t.progress.line ? 'Pick up after: ' + t.progress.line : 'Start it again'];
      case 'queued': return [t.held ? 'Press Start when you are ready' : 'It starts when the one before it is done'];
      case 'failed': return ['Try it again, or say what to change'];
      case 'applied': return t.outcome === 'budget' || t.outcome === 'away' ? ['Keep going from the last step'] : [];
      default: return [];
    }
  }

  // The buttons a card wears. A Hands card keeps its own action ids: the same
  // companion:guide:ask actions, and so the same consent path, as the Knot's card.
  function actionsFor(t) {
    if (t.state === 'needs_input' && t.question) {
      return (t.question.options || []).map((o) => ({ action: /^hands-/.test(o.id) ? o.id : 'task-' + o.id, label: o.label, primary: Boolean(o.primary), taskId: t.id }));
    }
    const b = (action, label, primary) => ({ action, label, primary: Boolean(primary), taskId: t.id });
    if (t.state === 'interrupted') return [b('task-resume', 'Pick it up', true), b('task-discard', 'Discard')];
    if (t.state === 'review') return [b('task-apply', 'Apply', true), b('task-discard', 'Discard')];
    if (t.state === 'queued' && t.held) return [b('task-start', 'Start', true), b('task-cancel', 'Not now')];
    if (t.state === 'queued') return [b('task-cancel', 'Not now')];
    if (t.state === 'preparing' || t.state === 'running') return [b('task-stop', 'Stop')];
    return [];
  }

  // A chord as the render words it: "Control+Alt" reads "Ctrl + Alt".
  function keyLabel(accel) {
    // On a Mac: Control, Command and Option (renderer/mac-words.js sets the flag).
    const mac = typeof window !== 'undefined' && !!(window.NusMacWords && window.NusMacWords.mac);
    if (mac) return String(accel || 'Control+Alt+Space').split('+').map((k) => (k === 'CommandOrControl' ? 'Command' : k === 'Alt' ? 'Option' : k)).join(' + ');
    return String(accel || 'Control+Alt').split('+').map((k) => (k === 'Control' || k === 'CommandOrControl' ? 'Ctrl' : k)).join(' + ');
  }

  // The pointer and an open list: told on every cursor tick whether the pointer is
  // with it. Gone for leaveMs, it closes, unless holds() says the person is still
  // in the middle of something. Only with a dwellMs does staying open it.
  function presence({ dwellMs, leaveMs, isOpen, canOpen, open, close, holds, setTimer, clearTimer }) {
    const later = setTimer || ((fn, ms) => setTimeout(fn, ms));
    const cancel = clearTimer || ((t) => clearTimeout(t));
    let dwell = null, leave = null, spent = false;
    const stop = (t) => { if (t) cancel(t); return null; };
    return {
      pointer(over) {
        if (over) {
          leave = stop(leave);
          if (dwellMs != null && !isOpen() && !dwell && !spent) dwell = later(() => { dwell = null; if (!isOpen() && canOpen()) open(); }, dwellMs);
          return;
        }
        dwell = stop(dwell);
        spent = false;
        if (isOpen() && !leave) leave = later(() => { leave = null; if (isOpen() && !(holds && holds())) close(); }, leaveMs);
      },
      // Shut by hand (Esc, a click): it stays shut until the pointer has gone and come back.
      shut() { dwell = stop(dwell); leave = stop(leave); spent = true; },
    };
  }

  // The list beside the free Knot: toward the middle of the screen, along the edge
  // of the corner it sits in. knot: its box; box: { w, h }; view: { w, h }.
  function besideKnot(knot, box, view, gap) {
    const g = gap == null ? 10 : gap;
    const onLeft = (knot.left + knot.right) / 2 < view.w / 2, onTop = (knot.top + knot.bottom) / 2 < view.h / 2;
    const left = onLeft ? knot.right + g : knot.left - g - box.w;
    const top = onTop ? knot.top : knot.bottom - box.h;
    return {
      left: Math.round(Math.max(8, Math.min(view.w - box.w - 8, left))),
      top: Math.round(Math.max(8, Math.min(view.h - box.h - 8, top))),
      side: onLeft ? 'left' : 'right',
    };
  }

  // ---- the DOM -------------------------------------------------------------
  // emptyOk: this panel may open with nothing listed and with the Task list off (the
  // free Knot's hover), showing the greeting, "No tasks yet" and the follow-up key.
  function create({ doc, host, send, onLayout, now, emptyOk = false }) {
    const clock = typeof now === 'function' ? now : () => Date.now();
    const tasks = new Map();
    const state = { enabled: false, open: false, detail: null, expanded: false, name: '', key: 'Control+Alt', draft: '' };
    const el = doc.createElement('div');
    el.className = 'tp';
    el.hidden = true;
    host.appendChild(el);

    function make(tag, cls, text) { const n = doc.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = String(text); return n; }
    function all() { return [...tasks.values()]; }
    function hasListed() { return state.enabled && listed(all(), { now: clock() }).length > 0; }
    function view() { return panelView(all(), { now: clock(), expanded: state.expanded }); }

    function buttons(t) {
      const row = make('div', 'tp-actions');
      for (const a of actionsFor(t)) {
        const btn = make('button', a.primary ? 'tp-btn primary' : 'tp-btn', a.label);
        btn.type = 'button';
        btn.addEventListener('click', (e) => { e.stopPropagation(); send({ action: a.action, taskId: a.taskId }); });
        row.appendChild(btn);
      }
      return row;
    }
    function chip(t) { return make('span', 'tp-chip', wordFor(t.state)); }
    function bar(t) {
      const k = progressOf(t);
      if (k == null) return null;
      const b = make('div', 'tp-bar'), f = make('i');
      f.style.width = Math.round(k * 100) + '%';
      b.appendChild(f);
      return b;
    }

    function cardNode(t) {
      const c = make('div', 'tp-card');
      c.dataset.state = t.state;
      c.dataset.id = t.id;
      if (t.state === 'needs_input') c.classList.add('needs');
      const head = make('div', 'tp-head-row');
      head.appendChild(make('b', 'tp-title', cardTitle(t)));
      head.appendChild(chip(t));
      c.appendChild(head);
      c.appendChild(make('div', 'tp-line', cardLine(t)));
      const b = bar(t);
      if (b) c.appendChild(b);
      if (actionsFor(t).length) c.appendChild(buttons(t));
      c.addEventListener('click', () => { state.detail = t.id; state.draft = ''; render(); });
      return c;
    }

    function listNode() {
      const v = view();
      const frag = make('div', 'tp-list');
      const head = make('div', 'tp-top');
      head.appendChild(make('div', 'tp-greeting', greeting(new Date(clock()).getHours(), state.name)));
      head.appendChild(make('div', 'tp-count', v.count));
      frag.appendChild(head);
      const cards = make('div', 'tp-cards');
      for (const t of v.cards) cards.appendChild(cardNode(t));
      frag.appendChild(cards);
      const foot = make('div', 'tp-foot');
      if (v.more) {
        const more = make('button', 'tp-more', '+' + v.more + ' more');
        more.type = 'button';
        more.addEventListener('click', () => { state.expanded = true; render(); });
        foot.appendChild(more);
      } else foot.appendChild(make('span'));
      foot.appendChild(make('span', 'tp-key', 'Hold ' + keyLabel(state.key) + ' to follow up'));
      frag.appendChild(foot);
      return frag;
    }

    function detailNode(t) {
      const d = make('div', 'tp-detail');
      d.dataset.id = t.id;
      const head = make('div', 'tp-head-row');
      head.appendChild(make('b', 'tp-detail-title', cardTitle(t)));
      head.appendChild(chip(t));
      d.appendChild(head);
      d.appendChild(make('div', 'tp-line', cardLine(t)));
      const b = bar(t);
      if (b) d.appendChild(b);
      if (actionsFor(t).length) d.appendChild(buttons(t));
      d.appendChild(make('div', 'tp-sub', "What's left"));
      const left = whatsLeft(t);
      if (left.length) { const ul = make('ul', 'tp-left'); for (const w of left) ul.appendChild(make('li', '', w)); d.appendChild(ul); }
      else d.appendChild(make('div', 'tp-line', 'Nothing left.'));
      const box = make('input', 'tp-follow');
      box.type = 'text'; box.placeholder = 'Follow up...'; box.setAttribute('aria-label', 'Follow up on this task'); box.value = state.draft;
      box.addEventListener('input', () => { state.draft = box.value; });
      box.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        const text = box.value.trim();
        if (!text) return;
        send({ action: 'task-followup', taskId: t.id, text: text.slice(0, 500) });
        state.draft = ''; state.detail = null; render();
      });
      d.appendChild(box);
      const foot = make('div', 'tp-foot');
      const back = make('button', 'tp-more', 'Back');
      back.type = 'button';
      back.addEventListener('click', () => { state.detail = null; render(); });
      foot.appendChild(back);
      foot.appendChild(make('span', 'tp-key', 'Esc to go back'));
      d.appendChild(foot);
      return d;
    }

    // A step arriving between a press and its release would rebuild the button
    // under the finger and lose the click, so the rebuild waits for the release.
    let pressing = false, owed = false;
    el.addEventListener('pointerdown', () => { pressing = true; });
    const released = () => { pressing = false; if (owed) { owed = false; render(); } };
    el.addEventListener('pointerup', () => { setTimeout(released, 0); });
    el.addEventListener('pointerleave', released);

    function render() {
      if (!state.open) return;
      if (pressing) { owed = true; return; }
      const focused = doc.activeElement && doc.activeElement.classList && doc.activeElement.classList.contains('tp-follow');
      const t = state.detail ? tasks.get(state.detail) : null;
      if (state.detail && (!t || GONE.includes(t.state))) state.detail = null;
      el.textContent = '';
      el.appendChild(t && state.detail ? detailNode(t) : listNode());
      if (focused && state.detail) { const box = el.querySelector('.tp-follow'); if (box) box.focus(); }
      onLayout(state.open);
    }

    function setOpen(on) {
      on = !!on;
      if (on === state.open) return;
      state.open = on;
      if (!on) { state.detail = null; state.expanded = false; state.draft = ''; el.textContent = ''; }
      el.hidden = !on;
      host.classList.toggle('unfolded', on);
      send({ action: 'task-panel', open: on });
      if (on) render(); else onLayout(false);
    }

    // Esc: one level back, then closed. True when it was taken.
    function back() {
      if (!state.open) return false;
      if (state.detail) { state.detail = null; render(); return true; }
      setOpen(false);
      return true;
    }

    // One tasks:event: the whole list, or one task's snapshot.
    function onEvent(p) {
      if (!p) return;
      if (p.type === 'esc') { back(); return; }
      if (p.type === 'sync') {
        tasks.clear();
        for (const t of p.tasks || []) if (t && t.id) tasks.set(t.id, t);
        state.enabled = p.enabled !== false;
        if (p.name != null) state.name = String(p.name);
        if (!state.enabled && !emptyOk) setOpen(false);
      } else if (p.task && p.task.id) {
        state.enabled = true;
        tasks.set(p.task.id, p.task);
      }
      render();
    }

    return {
      onEvent, back, setOpen, render,
      toggle() { setOpen(!state.open); },
      // With nothing listed the Knot's click stays what it always was.
      available() { return state.open || emptyOk || hasListed(); },
      hasListed,
      setKey(k) { if (k) { state.key = String(k); render(); } },
      // The person is partway through something here: a follow-up, or a card only this list is showing.
      typing() { return !!state.draft || !!(doc.activeElement && doc.activeElement.classList && doc.activeElement.classList.contains('tp-follow')); },
      waiting() { return all().some((t) => t.state === 'needs_input'); },
      get open() { return state.open; },
      get detail() { return state.detail; },
      get tasks() { return all(); },
      el,
    };
  }

  const api = { STATE_WORDS, GONE, VISIBLE, FINISHED_FOR_MS, FOLD_AFTER_MS, HOVER_OPEN_MS, HOVER_LEAVE_MS, presence, besideKnot, wordFor, listed, panelView, countLine, greeting, cardTitle, cardLine, progressOf, whatsLeft, actionsFor, keyLabel, create };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NusTaskPanel = api;
})(typeof window !== 'undefined' ? window : globalThis);
