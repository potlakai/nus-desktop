'use strict';
// The task panel in the pill: the state word for every journal state, the order
// and the "+N more", a needs-you card answered through the same consent path as
// the Knot's card, the list rebuilt from the journal after a restart, and no
// second pill, no model call, no IPC of its own.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const consent = require('../src/hands/consent');
const { HandsAgent } = require('../src/hands/agent');
const { createJournal, STATES } = require('../src/tasks/journal');
const { createSupervisor } = require('../src/tasks/supervisor');
const { createHandsExecutor } = require('../src/tasks/executors/hands');
const { createSurface, snapshot } = require('../src/tasks/surface');
const P = require('../renderer/task-panel');

const root = path.resolve(__dirname, '..', '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'nus-panel-')); }
const tick = () => new Promise((r) => setImmediate(r));
async function settle(n = 12) { for (let i = 0; i < n; i++) await tick(); }
const NOW = Date.parse('2026-11-02T18:00:00Z');
let seq = 0;
const task = (state, extra) => Object.assign({ id: 't' + (++seq), createdAt: new Date(NOW - 60000 + seq).toISOString(), endedAt: null, state, request: 'ask ' + state, goal: '', summary: '', progress: null, question: null, error: null, project: null, held: false, outcome: null }, extra);

test('1. every journal state has its word, and cancelled and discarded leave the list', () => {
  const expected = { queued: 'Up next', preparing: 'Working', running: 'Working', verifying: 'Checking', needs_input: 'Needs you', review: 'Ready to view', applied: 'Done', failed: 'Did not work', interrupted: 'Stopped', cancelled: null, discarded: null };
  assert.deepEqual(Object.keys(expected).sort(), STATES.slice().sort(), 'the table walks every state the journal has');
  for (const s of STATES) assert.equal(P.wordFor(s), expected[s], s);
  const v = P.panelView(STATES.map((s) => task(s)), { now: NOW, expanded: true });
  assert.equal(v.cards.length, 9);
  assert.ok(!v.cards.some((t) => t.state === 'cancelled' || t.state === 'discarded'));
  for (const t of v.cards) assert.ok(P.cardLine(t).length > 0, t.state + ' has a line');
});

test('2. needs-you comes first, then working; three cards and "+N more"; the count line reads as the render does', () => {
  const list = [task('applied', { endedAt: new Date(NOW - 1000).toISOString() }), task('running'), task('queued'), task('running'), task('needs_input', { question: { id: 'c', kind: 'consent', text: 'Click "Send"?', options: [] } }), task('failed', { endedAt: new Date(NOW).toISOString() })];
  const v = P.panelView(list, { now: NOW });
  assert.deepEqual(v.cards.map((t) => t.state), ['needs_input', 'running', 'running']);
  assert.equal(v.more, 3);
  assert.equal(v.count, '2 working, 1 needs you, 1 up next');
  assert.equal(P.panelView(list, { now: NOW, expanded: true }).more, 0);
  assert.equal(P.countLine([task('running'), task('running'), task('needs_input')]), '2 working, 1 needs you');
  assert.equal(P.countLine([task('applied')]), 'Nothing running');
  assert.equal(P.countLine([]), 'No tasks yet');
  // Four needing the person all show.
  const needs = [1, 2, 3, 4].map(() => task('needs_input'));
  assert.equal(P.panelView(needs.concat([task('running')]), { now: NOW }).cards.length, 4);
  // A finished card stays a day; a stopped one stays until it is dealt with.
  const old = new Date(NOW - P.FINISHED_FOR_MS - 1).toISOString();
  assert.equal(P.listed([task('applied', { endedAt: old }), task('failed', { endedAt: old })], { now: NOW }).length, 0);
  assert.equal(P.listed([task('interrupted', { createdAt: old })], { now: NOW }).length, 1);
  assert.equal(P.greeting(19, 'Maya'), 'Evening, Maya.');
  assert.equal(P.greeting(9, ''), 'Morning.');
  assert.equal(P.greeting(14, 'Sam'), 'Afternoon, Sam.');
  assert.equal(P.keyLabel('Control+Alt'), 'Ctrl + Alt');
});

test('3. a bar only when the steps are known; the line, the title and what is left come from the task', () => {
  assert.equal(P.progressOf(task('running', { progress: { n: 3, total: 4, line: 'x' } })), 0.75);
  assert.equal(P.progressOf(task('running', { progress: { n: 3, total: null, line: 'x' } })), null, 'Hands does not know its steps');
  assert.equal(P.progressOf(task('applied', { progress: { n: 4, total: 4 } })), null);
  assert.equal(P.cardLine(task('running', { progress: { n: 1, total: null, line: 'Opening Notepad' } })), 'Opening Notepad');
  assert.equal(P.cardLine(task('interrupted', { progress: { n: 1, line: 'Opening Notepad' } })), 'Got as far as: Opening Notepad');
  assert.equal(P.cardLine(task('failed', { error: { class: 'auth', detail: 'Not signed in.' } })), 'Not signed in.');
  assert.equal(P.cardLine(task('queued', { held: true })), 'Waiting for you to start it.');
  assert.equal(P.cardTitle(task('running', { goal: 'write the list', project: { name: 'Lab 3' } })), 'Lab 3');
  assert.equal(P.cardTitle(task('running', { goal: 'write the list' })), 'write the list');
  assert.deepEqual(P.whatsLeft(task('running', { progress: { n: 1, total: 3 } })), ['2 more steps']);
  assert.deepEqual(P.whatsLeft(task('running', { goal: 'write the list' })), ['Finish: write the list']);
  assert.deepEqual(P.whatsLeft(task('needs_input', { goal: 'g', question: { text: 'Send?' } })), ['Send?', 'Then: g']);
  assert.deepEqual(P.whatsLeft(task('applied')), []);
  assert.deepEqual(P.whatsLeft(task('applied', { outcome: 'budget' })), ['Keep going from the last step']);
  for (const s of STATES) assert.ok(Array.isArray(P.whatsLeft(task(s))), s);
  assert.deepEqual(P.actionsFor(task('interrupted', { id: 'i' })).map((a) => [a.action, a.label, a.taskId]), [['task-resume', 'Pick it up', 'i'], ['task-discard', 'Discard', 'i']]);
  assert.deepEqual(P.actionsFor(task('review')).map((a) => a.action), ['task-apply', 'task-discard']);
  assert.deepEqual(P.actionsFor(task('queued', { held: true })).map((a) => a.action), ['task-start', 'task-cancel']);
  assert.deepEqual(P.actionsFor(task('queued')).map((a) => [a.action, a.label]), [['task-cancel', 'Not now']]);
  assert.deepEqual(P.actionsFor(task('running')).map((a) => [a.action, a.label]), [['task-stop', 'Stop']], 'a working card can be stopped from the list');
  assert.deepEqual(P.actionsFor(task('applied')), []);
});

// A real agent under the real supervisor; the wire is what index.js does with each action.
function rig(replies, opts = {}) {
  const dir = opts.dir || tmp();
  const pending = consent.createPending();
  const clicked = [], sent = [];
  const agent = new HandsAgent({
    read: async () => ({ fg: { title: 'Canvas', process: 'chrome' }, cap: null, elements: [{ id: 2, name: 'Submit Assignment', type: 'Button', rect: { x: 1, y: 1, w: 9, h: 9 } }], originPhys: { x: 0, y: 0 } }),
    llm: () => ({ ready: true, provider: 'test', async complete(p) { const n = replies.shift(); if (n === undefined) return new Promise(() => {}); if (p.onDelta) p.onDelta(n); return n; } }),
    actions: { findElement: (q, els) => els[0], async run(name) { clicked.push(name); return { ok: true, report: 'done', settle: 0 }; } },
    consent: { preview: consent.preview, pending }, send: (c, p) => sent.push([c, p]), speak: () => {}, watcher: { async waitForChange() { return { changed: true }; } },
    fingerprint: () => new Uint8Array(4), retract: () => {}, log: () => {}, sleep: async () => {}, onActive: () => {},
  });
  const journal = createJournal({ dir });
  const events = [];
  const surface = createSurface({ send: (ch, p) => events.push([ch, p]) });
  const sup = createSupervisor({ journal, executors: [createHandsExecutor({ agent: () => agent })], setTimer: () => ({}), clearTimer: () => {}, onEvent: (ev) => surface.onEvent(ev, journal.get(ev.id)) });
  return { dir, agent, journal, sup, surface, events, sent, clicked, pending };
}
// companion:guide:ask's first lines in index.js, for the two Hands actions.
const wire = (r, a) => { if (a.action === 'hands-yes') return r.agent.answer(true); if (a.action === 'hands-no') return r.agent.answer(false); throw new Error('not the consent path: ' + a.action); };

test('4. a needs-you card resolves through the same consent path as the Knot\'s card', async () => {
  const main = read('companion/index.js');
  assert.match(main, /if \(p && p\.action === 'hands-yes'\) \{ if \(agent\) agent\.answer\(true\); return; \}\n\s*if \(p && p\.action === 'hands-no'\) \{ if \(agent\) agent\.answer\(false\); return; \}/, 'the handler both cards reach');
  for (const [pick, state, clicks] of [[0, 'applied', 1], [1, 'cancelled', 0]]) {
    const r = rig(['Submitting it. [DO:click {"id": 2}] [DONE]']);
    const id = r.sup.submit({ request: 'submit lab 3', source: 'typed', executor: 'hands' });
    await settle();
    const ev = r.events.find(([ch, p]) => ch === 'tasks:event' && p.type === 'needs_input')[1];
    const card = P.panelView([ev.task], { now: NOW }).cards[0];
    assert.equal(P.wordFor(card.state), 'Needs you');
    const knot = r.sent.filter(([c]) => c === 'guide:bubble').pop()[1];
    const buttons = P.actionsFor(card);
    assert.deepEqual(buttons.map((b) => b.action), knot.actions.map((a) => a.id), 'the same ids as the Knot\'s own card');
    assert.deepEqual(buttons.map((b) => b.label), ['Yes', 'Not now'], 'with Not now');
    assert.equal(r.pending.current() != null, true, 'one pending card in the agent\'s store');
    assert.equal(wire(r, buttons[pick]), true);
    assert.equal(r.pending.current(), null);
    await settle();
    assert.equal(r.journal.get(id).state, state);
    assert.equal(r.clicked.length, clicks);
    if (pick === 0) assert.equal(r.journal.get(id).consent[0].how, 'button');
  }
});

test('5. the list survives a restart from the journal', async () => {
  const dir = tmp();
  const a = rig(['[GOAL: write the list] One. [DO:click {"id": 2}]', 'One. [DO:wait {"seconds": 1}]'], { dir });
  const running = a.sup.submit({ request: 'write my list', source: 'typed', executor: 'hands' });
  const queued = a.sup.submit({ request: 'then email it', source: 'typed', executor: 'hands' });
  await settle();
  const b = rig(['Done. [DO:wait {"seconds": 1}] [DONE]'], { dir });
  b.sup.boot();
  b.surface.sync(b.journal.list(), { enabled: true, name: 'Maya' });
  const sync = b.events.filter(([ch, p]) => ch === 'tasks:event' && p.type === 'sync').pop()[1];
  assert.equal(sync.enabled, true); assert.equal(sync.name, 'Maya');
  const v = P.panelView(sync.tasks, { now: Date.now() });
  const byId = Object.fromEntries(v.cards.map((t) => [t.id, t]));
  assert.equal(P.wordFor(byId[running].state), 'Stopped');
  assert.equal(P.wordFor(byId[queued].state), 'Up next');
  assert.equal(byId[queued].held, true);
  assert.deepEqual(P.actionsFor(byId[running]).map((x) => x.action), ['task-resume', 'task-discard']);
  assert.deepEqual(P.actionsFor(byId[queued]).map((x) => x.action), ['task-start', 'task-cancel']);
  assert.equal(v.count, '1 up next');
  // The panel's Pick it up is the supervisor's resume, and the card moves on with it.
  assert.equal(b.sup.resume(running), true);
  await settle();
  assert.equal(b.journal.get(running).state, 'applied');
  assert.equal(snapshot(b.journal.get(running)).state, 'applied');
});

// The smallest DOM the panel needs, to walk it without Electron.
function fakeDoc() {
  const node = (tag) => {
    const n = {
      tag, children: [], dataset: {}, style: {}, listeners: {}, hidden: false, value: '', className: '', _text: '', type: '', placeholder: '',
      classList: { set: new Set(), add(c) { this.set.add(c); }, toggle(c, on) { if (on) this.set.add(c); else this.set.delete(c); }, contains(c) { return this.set.has(c); } },
      appendChild(c) { n.children.push(c); return c; }, setAttribute() {}, focus() {},
      addEventListener(t, f) { n.listeners[t] = f; }, querySelector() { return null; },
      get textContent() { return n._text + n.children.map((c) => c.textContent).join(' '); },
      set textContent(v) { n._text = String(v); n.children = []; },
      walk(fn) { fn(n); n.children.forEach((c) => c.walk(fn)); },
      find(pred) { let hit = null; n.walk((x) => { if (!hit && pred(x)) hit = x; }); return hit; },
    };
    return n;
  };
  return { createElement: node, activeElement: null };
}

test('6. the panel unfolds, lists, opens one task, follows up, and Esc goes back then closes', () => {
  const doc = fakeDoc(), host = doc.createElement('div'), sent = [];
  let layouts = 0;
  const panel = P.create({ doc, host, send: (p) => sent.push(p), onLayout: () => { layouts++; }, now: () => NOW });
  assert.equal(panel.available(), false, 'nothing listed: the Knot\'s click stays what it was');
  panel.onEvent({ type: 'sync', enabled: true, name: 'Maya', tasks: [task('running', { id: 'r', goal: 'Lab report outline', progress: { n: 1, total: null, line: 'Reading your notes' } }), task('needs_input', { id: 'n', goal: 'Reply to Prof. Rivera', question: { id: 'c1', kind: 'consent', text: 'Click "Send"?', options: [{ id: 'hands-yes', label: 'Yes', primary: true }, { id: 'hands-no', label: 'Not now' }] } })] });
  assert.equal(panel.available(), true);
  panel.toggle();
  assert.deepEqual(sent.shift(), { action: 'task-panel', open: true });
  assert.equal(host.classList.contains('unfolded'), true);
  assert.equal(panel.el.hidden, false);
  assert.ok(layouts > 0);
  const text = panel.el.textContent;
  assert.match(text, /Maya/); assert.match(text, /1 working, 1 needs you/); assert.match(text, /Needs you/); assert.match(text, /Reading your notes/); assert.match(text, /to follow up/);
  const first = panel.el.find((x) => x.className === 'tp-card');
  assert.equal(first.dataset.id, 'n', 'needs you first');
  assert.ok(first.classList.contains('needs'), 'wearing the Knot\'s line');
  // Yes on the card goes out as the Knot's own action.
  const yes = first.find((x) => x.tag === 'button' && x.textContent === 'Yes');
  yes.listeners.click({ stopPropagation() {} });
  assert.deepEqual(sent.shift(), { action: 'hands-yes', taskId: 'n' });
  // A later event moves the card; the open panel follows.
  panel.onEvent({ type: 'step', task: task('running', { id: 'n', goal: 'Reply to Prof. Rivera', progress: { n: 2, total: null, line: 'Clicking "Send"' } }) });
  assert.match(panel.el.textContent, /Clicking "Send"/);
  assert.match(panel.el.textContent, /2 working/);
  // One task: its summary, what's left, the box, Esc back.
  panel.el.find((x) => x.dataset.id === 'r' && x.className === 'tp-card').listeners.click();
  assert.equal(panel.detail, 'r');
  const detail = panel.el.textContent;
  assert.match(detail, /What's left/); assert.match(detail, /Finish: Lab report outline/); assert.match(detail, /Esc to go back/);
  const box = panel.el.find((x) => x.className === 'tp-follow');
  assert.equal(box.placeholder, 'Follow up...');
  box.value = 'use the shorter one';
  box.listeners.keydown({ key: 'Enter' });
  assert.deepEqual(sent.shift(), { action: 'task-followup', taskId: 'r', text: 'use the shorter one' });
  assert.equal(panel.detail, null, 'back to the list');
  panel.el.find((x) => x.dataset.id === 'r' && x.className === 'tp-card').listeners.click();
  assert.equal(panel.back(), true);
  assert.equal(panel.detail, null);
  assert.equal(panel.open, true, 'the first Esc goes back');
  panel.onEvent({ type: 'esc' });
  assert.equal(panel.open, false, 'the next closes');
  assert.deepEqual(sent.shift(), { action: 'task-panel', open: false });
  assert.equal(panel.back(), false, 'closed: Esc is not the panel\'s');
  // A task gone from the list closes its own detail view.
  panel.toggle(); sent.length = 0;
  panel.el.find((x) => x.dataset.id === 'r' && x.className === 'tp-card').listeners.click();
  panel.onEvent({ type: 'cancelled', task: task('cancelled', { id: 'r' }) });
  assert.equal(panel.detail, null);
  assert.doesNotMatch(panel.el.textContent, /Lab report outline/);
  // The switch going off folds it away.
  panel.onEvent({ type: 'sync', enabled: false, tasks: [] });
  assert.equal(panel.open, false); assert.equal(panel.available(), false);
});

test('7. built on the pill: one element, the same words and timing, no model call, no IPC of its own, nothing as markup', () => {
  const r = read('companion/renderer/renderer.js'), main = read('companion/index.js'), panel = read('companion/renderer/task-panel.js'), css = read('companion/renderer/styles.css');
  assert.equal((r.match(/islandEl = document\.createElement/g) || []).length, 1, 'no second pill');
  assert.match(r, /window\.NusTaskPanel\.create\(\{\s*doc: document,\s*host: islandEl,/, 'it lives inside the pill');
  assert.match(r, /islandGrowTo\(taskPanel && taskPanel\.open \? ISLAND\.panel : heldWidth\(islandNaturalWidth\(\)\)\)/, 'through the pill\'s own move, so its timing');
  assert.match(read('companion/renderer/knot-spec.js'), /panel: 460,/);
  assert.match(r, /listening: 'Listening, release to send', transcribing: 'Thinking'/, 'its words unchanged');
  assert.match(r, /if \(islandOn && taskPanel && taskPanel\.available\(\)\) \{ taskPanel\.toggle\(\); return; \}/, 'the Knot in the pill unfolds it');
  assert.doesNotMatch(panel, /innerHTML|insertAdjacentHTML|outerHTML/, 'a task\'s words never go in as markup');
  assert.doesNotMatch(panel, /nus\.|ipcRenderer|fetch\(|llm|complete\(/, 'no model and no channel of its own');
  assert.match(r, /send: \(p\) => nus\.guideAsk\(p && p\.action === 'task-panel' \? \{ action: 'task-panel', open: !!p\.open \|\| !!\(knotMenu && knotMenu\.open\) \} : p\)/, 'its buttons go out on the Knot\'s channel');
  assert.match(read('companion/renderer/index.html'), /<script src="task-panel\.js\?v=knot-day1"><\/script>/);
  assert.match(css, /#island \.tp \{[^}]*pointer-events: auto;/, 'the open list takes the mouse');
  assert.match(css, /#island \{\s*position: fixed; top: 8px;[^}]*pointer-events: none;/, 'the closed pill still never does');
  assert.match(r, /el\.closest\('#knot-shell, #island \.tp,/, 'and the hit test knows it');
  assert.match(css, /#island \.tp-card\.needs \{[^}]*border: 2px solid #fff;[^}]*box-shadow: 0 0 0 2\.8px rgb\(13,15,25\);/, 'the Knot\'s line, the same as its bubbles');
  assert.doesNotMatch(css.slice(css.indexOf('The task list: the pill')), /rotate\(/, 'cards sit straight');
  // Esc: the panel first, from any window, then Hands.
  assert.match(main, /if \(tasksPanelOpen\) \{ send\('tasks:event', \{ type: 'esc' \}\); return; \} if \(agent/);
  assert.match(main, /if \(action === 'task-panel'\) \{/);
  // The panel never asks for anything main has not already sent.
  assert.equal((main.match(/getTasks\(\)\.sync\(\)/g) || []).length, 3, 'a fresh page, the switch, and the delete');
});

test('the list opens only on a click: no task event unfolds it, whatever happens', () => {
  const doc = fakeDoc(), host = doc.createElement('div'), sent = [];
  const panel = P.create({ doc, host, send: (p) => sent.push(p), onLayout: () => {}, now: () => NOW });
  panel.onEvent({ type: 'sync', enabled: true, name: 'Maya', tasks: [task('applied', { id: 'old' })] });
  const events = [
    { type: 'queued', task: task('queued', { id: 'a' }) },
    { type: 'started', task: task('running', { id: 'a' }) },
    { type: 'step', task: task('running', { id: 'a', progress: { n: 1, total: null, line: 'Typing' } }) },
    { type: 'needs_input', task: task('needs_input', { id: 'a', question: { kind: 'consent', text: 'Send it?', options: [{ id: 'hands-yes', label: 'Yes', primary: true }] } }) },
    { type: 'answered', task: task('running', { id: 'a' }) },
    { type: 'done', task: task('applied', { id: 'a', summary: 'Finished.' }), data: { summary: 'Finished.' } },
    { type: 'failed', task: task('failed', { id: 'b' }) },
    { type: 'sync', enabled: true, name: 'Maya', tasks: [task('needs_input', { id: 'c', question: { kind: 'consent', text: 'Send it?', options: [] } })] },
  ];
  for (const e of events) { panel.onEvent(e); assert.equal(panel.open, false, e.type); assert.equal(panel.el.hidden, true, e.type); }
  assert.equal(host.classList.contains('unfolded'), false);
  assert.deepEqual(sent, [], 'and never told main it did');
  // Only three things open it: a click on the Knot in the pill, a click on the word, a double click on the word.
  const r = read('companion/renderer/renderer.js');
  const opens = r.split('\n').filter((l) => /taskPanel\.(?:toggle\(\)|setOpen\(true\))/.test(l)).map((l) => l.trim());
  assert.equal(opens.length, 3, opens.join(' | '));
  assert.match(opens[0], /^if \(islandOn && taskPanel && taskPanel\.available\(\)\) \{ taskPanel\.toggle\(\); return; \}/);
  assert.match(opens[1], /^if \(taskPanel && taskPanel\.available\(\)\) taskPanel\.toggle\(\);/);
  assert.match(opens[2], /addEventListener\('dblclick'/);
  const tasksEvent = r.slice(r.indexOf("nus.on('tasks:event'"), r.indexOf('An open list folds once the pointer'));
  assert.ok(!/setOpen\(true\)|toggle\(\)/.test(tasksEvent), 'the event path opens nothing');
});

test('an open list folds six seconds after the pointer left it, not while the person is partway through', () => {
  const timers = [];
  const setTimer = (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; };
  const clearTimer = (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); };
  let open = true, held = false;
  const p = P.presence({ leaveMs: P.FOLD_AFTER_MS, isOpen: () => open, close: () => { open = false; }, holds: () => held, setTimer, clearTimer });
  assert.equal(P.FOLD_AFTER_MS, 6000);
  p.pointer(true);
  assert.equal(timers.length, 0, 'with it: nothing counts down');
  p.pointer(false); p.pointer(false); p.pointer(false);
  assert.equal(timers.length, 1, 'one countdown, however many ticks');
  assert.equal(timers[0].ms, 6000);
  p.pointer(true);
  assert.equal(timers.length, 0, 'back in time');
  p.pointer(false);
  held = true;
  timers.shift().fn();
  assert.equal(open, true, 'a follow-up half typed or a card waiting keeps it');
  held = false;
  p.pointer(false);
  timers.shift().fn();
  assert.equal(open, false);
  // No dwell given: staying over a closed list never opens it.
  p.pointer(true);
  assert.equal(timers.length, 0);
  assert.equal(open, false);
});

test('the fold is wired: every cursor tick, and the pointer leaving the window', () => {
  const r = read('companion/renderer/renderer.js'), main = read('companion/index.js');
  assert.match(r, /if \(pillReady\) pointerTick\(x \/ z, y \/ z, handsMoving\);/);
  assert.match(r, /nus\.on\('cursor:away', \(\) => \{ pointerAt = null; if \(pillReady\) pointerTick\(-1, -1\); \}\)/);
  assert.match(r, /holds: \(\) => taskPanel\.typing\(\) \|\| taskPanel\.waiting\(\)/);
  assert.match(main, /send\('cursor:away', \{\}\)/);
});

test('the hover: 400 ms on the free Knot opens it, a second away closes it, Esc keeps it shut until the pointer comes back', () => {
  const timers = [];
  const setTimer = (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; };
  const clearTimer = (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); };
  let open = false, may = true, typing = false;
  const h = P.presence({ dwellMs: P.HOVER_OPEN_MS, leaveMs: P.HOVER_LEAVE_MS, isOpen: () => open, canOpen: () => may, open: () => { open = true; }, close: () => { open = false; }, holds: () => typing, setTimer, clearTimer });
  assert.equal(P.HOVER_OPEN_MS, 400); assert.equal(P.HOVER_LEAVE_MS, 1000);
  h.pointer(true); h.pointer(true);
  assert.equal(timers.length, 1, 'one wait, however many ticks');
  assert.equal(timers[0].ms, 400);
  h.pointer(false);
  assert.equal(timers.length, 0, 'passing over it does nothing');
  assert.equal(open, false);
  h.pointer(true);
  may = false; timers.shift().fn();
  assert.equal(open, false, 'something else is by the Knot');
  may = true; h.pointer(true); timers.shift().fn();
  assert.equal(open, true);
  h.pointer(false);
  assert.equal(timers[0].ms, 1000);
  h.pointer(true);
  assert.equal(timers.length, 0, 'crossing the gap to the panel in time keeps it');
  h.pointer(false);
  typing = true; timers.shift().fn();
  assert.equal(open, true, 'a follow-up half typed keeps it');
  typing = false; h.pointer(false); timers.shift().fn();
  assert.equal(open, false);
  // Esc: shut while the pointer stays, open again only after it has left and returned.
  h.pointer(true); timers.shift().fn();
  assert.equal(open, true);
  open = false; h.shut();
  h.pointer(true);
  assert.equal(timers.length, 0, 'still on the Knot, it stays shut');
  h.pointer(false); h.pointer(true);
  assert.equal(timers.length, 1);
});

test('the hover panel sits beside the Knot in whichever corner, on the screen', () => {
  const view = { w: 1600, h: 900 }, box = { w: 460, h: 300 };
  const knot = (left, top) => ({ left, top, right: left + 80, bottom: top + 80 });
  assert.deepEqual(P.besideKnot(knot(1480, 780), box, view), { left: 1010, top: 560, side: 'right' });
  assert.deepEqual(P.besideKnot(knot(40, 780), box, view), { left: 130, top: 560, side: 'left' });
  assert.deepEqual(P.besideKnot(knot(1480, 40), box, view), { left: 1010, top: 40, side: 'right' });
  assert.deepEqual(P.besideKnot(knot(40, 40), box, view), { left: 130, top: 40, side: 'left' });
  const tall = P.besideKnot(knot(1480, 780), { w: 460, h: 1000 }, view);
  assert.equal(tall.top, 8, 'never off the top');
  assert.equal(P.besideKnot(knot(100, 100), { w: 1590, h: 300 }, view).left, 8);
});

test('the hover panel is the same panel: one implementation, its events, its mask, and no hover in the pill', () => {
  const r = read('companion/renderer/renderer.js'), main = read('companion/index.js'), css = read('companion/renderer/styles.css'), pill = read('companion/renderer/pill.css');
  assert.equal((r.match(/window\.NusTaskPanel\.create\(/g) || []).length, 2, 'the pill and the free Knot');
  assert.ok(!/tp-card|tp-greeting/.test(r), 'the page builds no cards of its own');
  assert.match(r, /if \(knotPanel\) knotPanel\.onEvent\(p\);/);
  assert.match(r, /dwellMs: window\.NusTaskPanel\.HOVER_OPEN_MS/);
  assert.match(r, /return !islandOn && knotPanel\.available\(\)/, 'free only, and with something to show');
  assert.match(r, /!handsMoving && !!\(el && el\.closest && el\.closest\('#orb, #knot-panel'\)\)/, 'not on the Hands cursor');
  assert.match(r, /el\.closest\('#island\.live, #island \.tp, #knot-panel, #knot-menu'\)/, 'it takes the mouse');
  assert.match(r, /if \(p && p\.type === 'esc' && knotPanel && knotPanelBack\(\)\) return;/, 'Esc from any window');
  assert.match(r, /orbPointerType === 'touch' && knotPanel/, 'one tap on touch');
  assert.match(r, /nus\.assignmentPainted\(\{ panel: rect \}\)/);
  assert.match(main, /if \(p\.panel === null\) knotPanelRect = null;/);
  const masks = main.slice(main.indexOf('function overlayMasks('), main.indexOf('async function guideCapture('));
  assert.match(masks, /if \(knotPanelRect\) masks\.push\(/, 'masked out of what the model reads');
  assert.match(main, /handsMoving: !pillMayTakeMouse\(\)/);
  for (const rule of ['.tp-card', '.tp-greeting', '.tp-count', '.tp-foot', '.tp-chip', '.tp-btn']) assert.ok(css.includes('#knot-panel ' + rule) && css.includes('#island ' + rule), rule);
  assert.match(pill, /#knot-panel\.unfolded \{ display: block; animation: knot-panel-in/);
  assert.match(pill, /prefers-reduced-motion: reduce\) \{ #knot-panel\.unfolded \{ animation: none; \}/);
});

test('the free Knot panel opens with nothing listed and with the Task list off; the pill panel does not', () => {
  const doc = fakeDoc(), host = doc.createElement('div'), sent = [];
  const panel = P.create({ doc, host, send: (p) => sent.push(p), onLayout: () => {}, now: () => NOW, emptyOk: true });
  assert.equal(panel.available(), true, 'before anything has synced');
  assert.equal(panel.hasListed(), false);
  panel.onEvent({ type: 'sync', enabled: false, tasks: [], name: 'Maya' });
  assert.equal(panel.available(), true, 'Task list off');
  panel.setOpen(true);
  assert.deepEqual(sent.shift(), { action: 'task-panel', open: true }, 'Esc is armed as ever');
  assert.match(panel.el.textContent, /Maya/);
  assert.match(panel.el.textContent, /No tasks yet/);
  assert.match(panel.el.textContent, /Hold Ctrl \+ Alt to follow up/);
  panel.onEvent({ type: 'sync', enabled: false, tasks: [] });
  assert.equal(panel.open, true, 'a sync with the switch off does not fold it');
  assert.match(panel.el.textContent, /Maya/, 'and the name stays');
  assert.equal(panel.back(), true);
  assert.equal(panel.open, false, 'Esc closes it');
  panel.onEvent({ type: 'sync', enabled: true, tasks: [task('running', { id: 'r' })] });
  assert.equal(panel.hasListed(), true);
  // The pill panel is untouched: nothing listed, nothing to unfold, and the switch off folds it.
  const pill = P.create({ doc, host: doc.createElement('div'), send: () => {}, onLayout: () => {}, now: () => NOW });
  assert.equal(pill.available(), false);
  pill.onEvent({ type: 'sync', enabled: true, tasks: [task('running', { id: 'q' })] });
  pill.setOpen(true);
  pill.onEvent({ type: 'sync', enabled: false, tasks: [] });
  assert.equal(pill.open, false);
  const r = read('companion/renderer/renderer.js');
  assert.match(r, /host: knotPanelEl,\s*emptyOk: true,/, 'only the Knot panel');
  assert.doesNotMatch(r.slice(r.indexOf('const taskPanel = window.NusTaskPanel'), r.indexOf('const knotPanelEl')), /emptyOk/);
  // On a touchscreen one tap with nothing listed stays the ask line.
  assert.match(r, /orbPointerType === 'touch' && knotPanel && \(knotPanel\.open \|\| \(knotPanel\.hasListed\(\) && knotPanelMayOpen\(\)\)\)/);
  // The page gets the name with the switch off, at load and when it goes off.
  const main = read('companion/index.js');
  assert.match(main, /else send\('tasks:event', \{ type: 'sync', enabled: false, tasks: \[\], name: firstName\(\) \}\);/);
  assert.match(main, /const off = \{ type: 'sync', enabled: false, tasks: \[\], name: firstName\(\) \};/);
  assert.equal(P.HOVER_OPEN_MS, 400); assert.equal(P.HOVER_LEAVE_MS, 1000);
});
