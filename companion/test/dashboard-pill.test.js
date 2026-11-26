'use strict';
// The dashboard and the pill read one state (docs/dashboard-pill.md): the home
// view, the pill during a task, the options menu, the settings mirror.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '../..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const Q = require('../renderer/quick-options.js');
const Pill = require('../renderer/pill.js');
const Menu = require('../renderer/knot-menu.js');
const Panel = require('../renderer/task-panel.js');
const Now = require('../home/now.js');

// A small DOM: enough for the menu and the home view, with text only.
function fakeDoc() {
  const byId = new Map();
  function node(tag) {
    const n = {
      tag, children: [], parent: null, dataset: {}, style: { setProperty(k, v) { this[k] = v; }, removeProperty(k) { delete this[k]; } }, attrs: {}, listeners: {}, hidden: false, disabled: false, className: '', _text: '',
      classList: {
        add(c) { const s = new Set(n.className.split(' ').filter(Boolean)); s.add(c); n.className = [...s].join(' '); },
        remove(c) { n.className = n.className.split(' ').filter((x) => x && x !== c).join(' '); },
        toggle(c, on) { if (on) n.classList.add(c); else n.classList.remove(c); },
        contains(c) { return n.className.split(' ').includes(c); },
      },
      setAttribute(k, v) { n.attrs[k] = String(v); },
      appendChild(c) { if (c.parent) c.parent.children.splice(c.parent.children.indexOf(c), 1); c.parent = n; n.children.push(c); return c; },
      removeChild(c) { n.children.splice(n.children.indexOf(c), 1); c.parent = null; return c; },
      addEventListener(t, f) { (n.listeners[t] = n.listeners[t] || []).push(f); },
      click() { for (const f of n.listeners.click || []) f({ stopPropagation() {}, preventDefault() {} }); },
      scrollIntoView() {},
      get firstChild() { return n.children[0] || null; },
      get firstElementChild() { return n.children[0] || null; },
      get textContent() { return n._text + n.children.map((c) => c.textContent).join(''); },
      set textContent(v) { n._text = String(v); for (const c of n.children) c.parent = null; n.children = []; },
      all() { return n.children.flatMap((c) => [c, ...c.all()]); },
      matches(sel) {
        const m = /^\[data-option="(.+)"\]$/.exec(sel);
        if (m) return n.dataset.option === m[1];
        if (sel.startsWith('.')) return n.classList.contains(sel.slice(1));
        return n.tag === sel;
      },
      querySelectorAll(sel) { const parts = sel.split(' '); const last = parts[parts.length - 1]; return n.all().filter((c) => c.matches(last)); },
      querySelector(sel) { return n.querySelectorAll(sel)[0] || null; },
    };
    return n;
  }
  return { createElement: node, byId, activeElement: null, querySelector(sel) { return byId.get(sel) || null; } };
}

// ---- one list ---------------------------------------------------------------

test('the menu and the dashboard offer one list; the voice is the dashboard\'s alone', () => {
  const menu = Q.switchesFor('menu').map((o) => o.id), dash = Q.switchesFor('dashboard').map((o) => o.id);
  assert.deepEqual(menu, ['hands', 'tasks', 'hide', 'sounds', 'openMic']);
  assert.deepEqual(dash, [...menu, 'voice']);
  assert.deepEqual(Q.HOME.choices.map((c) => c.label), ['Free', 'Island']);
  assert.deepEqual(Q.homePatch(true), { knotIsland: true });
  assert.deepEqual(Q.homePatch(false), { knotIsland: false });
  const opt = (id) => Q.SWITCHES.find((o) => o.id === id);
  assert.deepEqual(Q.patchFor(opt('voice'), true), { voice: 'fable' });
  assert.deepEqual(Q.patchFor(opt('voice'), false), { voice: 'system' });
  assert.deepEqual(Q.patchFor(opt('hide'), true), { hideFromCapture: true });
});

test('each switch reads its setting the way the app does', () => {
  const opt = (id) => Q.SWITCHES.find((o) => o.id === id);
  assert.equal(Q.isOn(opt('sounds'), {}), true, 'sound cues are on unless turned off');
  assert.equal(Q.isOn(opt('sounds'), { sounds: false }), false);
  assert.equal(Q.isOn(opt('hands'), {}), false, 'Hands is off until turned on');
  assert.equal(Q.isOn(opt('tasks'), {}), false, 'the task list stays off by default');
  assert.equal(Q.isOn(opt('hide'), { hideFromCapture: false }), false);
  assert.match(read('companion/index.js'), /store\.getSettings\(\)\.hideFromCapture !== false/, 'the same reading as captureHidden');
  assert.match(read('companion/src/store.js'), /\n\s*tasks: false,/, 'the switch is off in the store');
});

// ---- the mirror --------------------------------------------------------------

test('the settings mirror: any door reaches both windows, through the doors that exist', () => {
  const main = read('companion/index.js'), desk = read('src/main-companion.js'), home = read('companion/home/home.js');
  assert.match(main, /send\('settings:changed', \{ \.\.\.s, _standalone: true[^\n]*\n[^\n]*\n\s*if \(hooks\.onSettingsChanged\) hooks\.onSettingsChanged\(\);/, 'the overlay, then the dashboard, from one function');
  assert.match(main, /companionIpc\.handle\('companion:settings:set', \(_e, patch\) => applySettingsPatch\(overlayPatch\(patch\)\)\);/, 'the pill writes through the overlay\'s door');
  assert.match(desk, /companion\.setSettings\(clean\);/, 'the dashboard writes through its own, which ends in the same function');
  assert.match(desk, /onSettingsChanged: \(\) => \{ send\('home:settings', publicSettings\(\)\); scheduleSync\(\); \}/, 'keys never go along: publicSettings leaves them out');
  assert.match(read('companion/home/preload.js'), /'home:settings','home:tasks','home:knot'/);
  assert.match(home, /api\.on\('home:settings',mirrorSettings\)/);
  for (const key of ['hands', 'tasks', 'hideFromCapture', 'sounds', 'openMic', 'knotIsland']) {
    assert.match(main, new RegExp("OVERLAY_BOOLEANS = new Set\\([^\\n]*'" + key + "'"), key + ' may be set from the overlay');
    assert.match(desk, new RegExp("for \\(const key of \\[[^\\]]*'" + key + "'"), key + ' may be set from the dashboard');
  }
  assert.doesNotMatch(read('companion/renderer/quick-options.js'), /localStorage|writeFile|createStore/, 'no new store');
});

test('a flip in the menu shows at once, then what main answers is what stays', async () => {
  const doc = fakeDoc(), writes = [];
  let answer = null;
  const m = Menu.create({ doc, options: Q, read: async () => ({ hands: true, knotIsland: false }), write: async (p) => { writes.push(p); return answer; }, action: () => {}, place: () => {}, onChange: () => {}, setTimer: () => 1, clearTimer: () => {} });
  m.show('knot');
  await new Promise((r) => setImmediate(r));
  const row = (id) => m.el.children.find((c) => c.dataset.option === id);
  assert.equal(row('hands').classList.contains('on'), true);
  answer = { hands: false, knotIsland: false };
  row('hands').click();
  assert.deepEqual(writes, [{ hands: false }]);
  assert.equal(row('hands').classList.contains('on'), false, 'flipped before main answers');
  await new Promise((r) => setImmediate(r));
  // The dashboard flips one: settings:changed comes in and the open menu shows it.
  m.setSettings({ hands: false, sounds: false, knotIsland: false });
  assert.equal(row('sounds').classList.contains('on'), false);
});

// ---- the menu ----------------------------------------------------------------

test('the menu has home first, the switches, the dashboard and quit; home is one tap and stays open', async () => {
  const doc = fakeDoc(), writes = [], acts = [], changes = [];
  const m = Menu.create({ doc, options: Q, read: async () => ({ knotIsland: false }), write: async (p) => { writes.push(p); return null; }, action: (a) => acts.push(a), place: () => {}, onChange: (o) => changes.push(o), setTimer: () => 1, clearTimer: () => {} });
  m.show('knot');
  await new Promise((r) => setImmediate(r));
  const buttons = m.el.all().filter((n) => n.tag === 'button').map((b) => b.textContent);
  assert.deepEqual(buttons, ['Free', 'Island', 'Hands', 'Task list', 'Hide from sharing', 'Sound cues', 'Open mic', 'Open the dashboard', 'Quit Nūs']);
  const seg = m.el.children[0];
  seg.children.find((b) => b.textContent === 'Island').click();
  assert.deepEqual(writes, [{ knotIsland: true }], 'one tap');
  assert.equal(m.open, true, 'it stays, so going back is one more tap');
  m.el.children[0].children.find((b) => b.textContent === 'Free').click();
  assert.deepEqual(writes[1], { knotIsland: false });
  m.el.children.find((c) => c.dataset.action === 'menu-dashboard').click();
  assert.deepEqual(acts, ['menu-dashboard']);
  assert.equal(m.open, false, 'a row that leaves closes it');
  assert.deepEqual(changes, [true, false]);
});

test('the menu opens where the brief says, and Esc and the mouse leaving close it', () => {
  const r = read('companion/renderer/renderer.js'), main = read('companion/index.js');
  assert.match(r, /else \{ openQuickAsk\(\); if \(!islandOn && knotMenu && !isShown\(tourEl\)\) knotMenu\.show\('knot'\); \}/, 'a click on the free Knot: the ask line and the options together');
  assert.match(r, /islandEl\.addEventListener\('contextmenu', menuFromPill\);/, 'a right click on the pill');
  assert.match(r, /const LONG_PRESS_MS = 500;/, 'a long press on the pill');
  assert.match(r, /orbEl\.addEventListener\('contextmenu'/, 'a right click on the Knot, wherever it lives');
  assert.match(r, /if \(p && p\.type === 'esc' && knotMenu && knotMenu\.open\) \{ knotMenu\.close\(\); return; \}/, 'Esc closes it before anything else');
  assert.match(main, /p\.action === 'menu-dashboard'\) \{ if \(hooks\.showDesktop\) hooks\.showDesktop\(\); return; \}/);
  // 0.1.38: userQuit() tells the host the reason (quit) and then calls app.quit().
  assert.match(main, /p\.action === 'menu-quit'\) \{ userQuit\(\); return; \}/);
  assert.equal(Menu.LEAVE_MS, 6000);
});

// ---- the pill during a task --------------------------------------------------

const running = (over) => Object.assign({ id: 'b', state: 'running', executor: 'hands', goal: 'To-do list in Notepad', progress: { n: 4, total: null, line: 'Typing into "Untitled - Notepad"' } }, over);

test('during a Hands task: the word, the step, Esc to stop, and no invented bar', () => {
  const v = Pill.dress({ word: 'Hands is working', tone: 'hands', hands: { active: true }, tasks: [running()], now: 0 });
  assert.deepEqual(v, { word: 'Hands is working', tone: 'hands', step: 'Typing into "Untitled - Notepad"', bar: null, esc: true, count: '' });
});

test('a bar only when the steps are really known', () => {
  const v = Pill.dress({ word: '', tone: 'idle', hands: {}, tasks: [running({ executor: 'code', progress: { n: 3, total: 4, line: 'Pulling the methods' } })], now: 0 });
  assert.equal(v.word, 'Working');
  assert.equal(v.bar, 0.75);
  assert.equal(v.esc, false, 'Esc stops Hands; another executor has not said it can');
});

test('with the task list off, Hands still shows its word and Esc, with no step', () => {
  const v = Pill.dress({ word: 'Hands is working', tone: 'hands', hands: { active: true }, tasks: [], now: 0 });
  assert.equal(v.step, '');
  assert.equal(v.esc, true);
});

test('needs you: the white ring, the task\'s name on the pill, the question on the card', () => {
  const needs = running({ state: 'needs_input', question: { text: 'Close Notepad without saving?', options: [] } });
  const v = Pill.dress({ word: 'Hands is waiting for you', tone: 'hands', hands: { active: true, waiting: true }, tasks: [needs], now: 0 });
  assert.equal(v.tone, 'needs');
  assert.equal(v.word, 'Hands is waiting for you');
  assert.equal(v.step, 'To-do list in Notepad', 'the words never appear twice');
  assert.equal(v.esc, false);
  // Out of steps, the mouse already given back: still a card that waits.
  assert.equal(Pill.dress({ word: '', tone: 'idle', hands: {}, tasks: [needs], now: 0 }).tone, 'needs');
  assert.match(read('companion/renderer/pill.css'), /#island\[data-state='needs'\] \{ --isl-acc: 255,255,255;/);
});

test('your own key outranks a task', () => {
  const v = Pill.dress({ word: 'Listening, release to send', tone: 'listening', hands: { active: true }, tasks: [running()], now: 0 });
  assert.equal(v.word, 'Listening, release to send');
  assert.equal(v.step, '');
});

test('a task\'s end: a moment of Done or Did not work, with what is up next, then back', () => {
  const task = running({ state: 'applied', summary: 'Opened Notepad.' });
  const flash = Pill.flashFor({ type: 'done', data: { summary: 'Opened Notepad and wrote the list' }, task }, 1000);
  assert.equal(flash.word, 'Done');
  assert.equal(flash.until, 1000 + Pill.FLASH_MS);
  const v = Pill.dress({ word: '', tone: 'idle', hands: {}, tasks: [{ id: 'q', state: 'queued' }], flash, now: 2000 });
  assert.deepEqual([v.word, v.tone, v.step, v.count], ['Done', 'done', 'Opened Notepad and wrote the list', '1 up next']);
  const later = Pill.dress({ word: '', tone: 'idle', hands: {}, tasks: [], flash, now: 1000 + Pill.FLASH_MS });
  assert.equal(later.word, '');
  const failed = Pill.flashFor({ type: 'failed', data: {}, task: running({ error: { detail: 'not signed in.' } }) }, 0);
  assert.deepEqual([failed.word, failed.tone, failed.step], ['Did not work', 'error', 'Not signed in.']);
  assert.equal(Pill.flashFor({ type: 'cancelled', task: {} }, 0), null, 'a stop you asked for needs no word');
  assert.equal(Pill.flashFor({ type: 'step', task: {} }, 0), null);
});

test('the step line changes at most every 600 ms, the newest wins, and clearing is at once', () => {
  let t = 0, fire = null;
  const shown = [];
  const s = Pill.stepper({ apply: (x) => shown.push(x), now: () => t, setTimer: (f) => { fire = f; return 1; }, clearTimer: () => { fire = null; } });
  s.set('one');
  t = 100; s.set('two');
  t = 200; s.set('three');
  assert.deepEqual(shown, ['one'], 'held back');
  t = 600; fire();
  assert.deepEqual(shown, ['one', 'three'], 'the newest, and two was never shown');
  t = 650; s.set('');
  assert.deepEqual(shown, ['one', 'three', ''], 'clearing does not wait');
});

test('accents come from the spec when it names them; nothing is named in the pill or the dashboard', () => {
  assert.equal(Pill.rgbOf('#C58AFF'), '197,138,255');
  assert.equal(Pill.rgbOf('#fff'), '255,255,255');
  assert.equal(Pill.rgbOf('red'), null);
  assert.equal(Pill.accentFor({ character: { island: { accents: { listening: '#C58AFF' } } } }, 'listening'), '197,138,255');
  assert.equal(Pill.accentFor({ character: { island: {} } }, 'listening'), null, 'no map: the rules in styles.css stay');
  const pillCss = read('companion/renderer/pill.css'), home = read('companion/home/now.css');
  for (const hue of ['239,83,80', '140,150,255', '224,182,99', '#EF5350', '#8c96ff', '#C58AFF', '#FFC76A', '#59B9FF']) {
    assert.ok(!pillCss.includes(hue), 'pill.css names no state colour: ' + hue);
    assert.ok(!home.includes(hue), 'the dashboard names no state colour: ' + hue);
  }
  assert.match(read('companion/renderer/renderer.js'), /getComputedStyle\(islandEl\)\.getPropertyValue\('--isl-acc'\)/, 'the dashboard gets the accent the pill really wears');
});

// ---- centred under the pill (Pranav, 2026-11-03) ------------------------------

test('whatever the pill hands down sits on the screen\'s centre line', () => {
  const r = read('companion/renderer/renderer.js');
  const slot = r.slice(r.indexOf('function placeSlot(el)'), r.indexOf('function placeByKnot(el)'));
  assert.match(slot, /Math\.round\(\(W - bw\) \/ 2\)/, 'the cards');
  assert.doesNotMatch(slot.slice(0, slot.indexOf('const a = knotAnchor()')), /b\.right/, 'not hung from the Knot');
  const menu = r.slice(r.indexOf('function placeMenu(el, source)'), r.indexOf('const knotMenu = window.NusKnotMenu'));
  assert.match(menu, /clampX\(Math\.round\(\(W - mw\) \/ 2\)\)/, 'the menu');
});

// ---- the free Knot's pill -----------------------------------------------------

test('with the Knot free, the pill comes for a task and goes after it', () => {
  const base = { island: false, hands: {}, tasks: [], flash: null, panelOpen: false, now: 10 };
  assert.equal(Pill.wanted(base), false, 'an ordinary ask keeps the free Knot alone');
  assert.equal(Pill.wanted({ ...base, island: true }), true);
  assert.equal(Pill.wanted({ ...base, hands: { active: true } }), true);
  assert.equal(Pill.wanted({ ...base, tasks: [running()] }), true);
  assert.equal(Pill.wanted({ ...base, tasks: [running({ state: 'needs_input' })] }), true);
  assert.equal(Pill.wanted({ ...base, tasks: [{ id: 'q', state: 'queued' }] }), false, 'waiting its turn is no reason to come up');
  assert.equal(Pill.wanted({ ...base, flash: { until: 20 } }), true);
  assert.equal(Pill.wanted({ ...base, flash: { until: 5 } }), false);
  const css = read('companion/renderer/pill.css');
  assert.match(css, /body\.pill-free #island \{ display: flex; \}/);
  assert.match(css, /body\.pill-free #island \.isl-slot \{ display: none; \}/, 'no Knot riding it: the Knot is free');
  const r = read('companion/renderer/renderer.js');
  assert.match(r, /if \(islandOn\) orbEl\.style\.transform = /, 'the free Knot stays where it is');
  assert.match(r, /const rect = \(islandOn \|\| pillFree\) && r\.width \?/, 'masked out of what the model reads, in free mode too');
  assert.match(r, /if \(pillFree\) \{ reportIslandRect\(\); return; \}/);
});

// ---- the pill takes the mouse, Hands keeps its clicks --------------------------

test('between Hands\' moves the pill may take the mouse, never during one', () => {
  const main = read('companion/index.js'), r = read('companion/renderer/renderer.js'), css = read('companion/renderer/styles.css');
  assert.match(main, /if \(!v && agent && agent\.active\(\) && !agent\.asking\(\) && !\(why === 'pill' && pillMayTakeMouse\(\)\)\) return;/);
  assert.match(main, /function pillMayTakeMouse\(\) \{ return handsMouseOps === 0 && Date\.now\(\) - handsMouseAt > 800; \}/);
  assert.match(main, /overlayMouse\.set\(true\); handsMouseOps\+\+;/, 'a move makes the overlay click-through first');
  assert.match(r, /if \(pillReady && handsState\.active && overPillAt\(x \/ z, y \/ z\)\) nus\.setIgnoreMouse\(false, 'pill'\);/);
  assert.match(read('companion/preload.js'), /why === 'pill' \? 'pill' : undefined/, 'one word from the page, nothing else passes');
  assert.match(css, /#island \{\s*position: fixed; top: 8px;[^}]*pointer-events: none;/, 'idle, the pill is still not a target');
  assert.match(read('companion/renderer/pill.css'), /#island\.live \{ pointer-events: auto; \}/);
});

// ---- the task panel's own buttons ---------------------------------------------

test('a working card can be stopped and a waiting one let go, from both places', () => {
  assert.deepEqual(Panel.actionsFor({ id: 't', state: 'running' }).map((a) => [a.action, a.label, a.taskId]), [['task-stop', 'Stop', 't']]);
  assert.deepEqual(Panel.actionsFor({ id: 't', state: 'preparing' }).map((a) => a.action), ['task-stop']);
  assert.deepEqual(Panel.actionsFor({ id: 't', state: 'verifying' }), []);
  assert.deepEqual(Panel.actionsFor({ id: 't', state: 'queued' }).map((a) => [a.action, a.label]), [['task-cancel', 'Not now']]);
});

// ---- the home view ------------------------------------------------------------

test('recent asks are the newest few from Saved, with an age a person reads', () => {
  const now = Date.parse('2026-11-03T19:30:00');
  const min = (m) => new Date(now - m * 60000).toISOString();
  assert.equal(Now.ago(min(0), now), 'Now');
  assert.equal(Now.ago(min(4), now), '4 min');
  assert.equal(Now.ago(min(90), now), '1 h');
  assert.equal(Now.ago(min(7 * 60), now), 'Today');
  assert.match(Now.ago(min(3 * 24 * 60), now), /Oct 31|31/);
  assert.equal(Now.ago('not a date', now), '');
  const rows = Now.askRows([{ id: 1, title: 'old', started_at: min(100) }, { id: 2, first_line: 'new', started_at: min(1) }, { id: 3, started_at: min(2) }, ...[4, 5, 6, 7, 8].map((id) => ({ id, title: 't' + id, started_at: min(200 + id) }))], now);
  assert.deepEqual(rows[0], { id: 2, text: 'new', when: '1 min' });
  assert.equal(rows.length, Now.ASKS);
  assert.ok(!rows.some((r) => r.id === 3), 'a conversation with no words is no ask');
});

test('a project reads its next step, else its last', () => {
  assert.equal(Now.projectLine({ nextStep: 'pull the notes', lastStep: 'x' }), 'Next: pull the notes');
  assert.equal(Now.projectLine({ lastStep: 'Typing' }), 'Last: Typing');
  assert.match(Now.projectLine({}), /where it stopped/);
});

function homeRig(over = {}) {
  const doc = fakeDoc(), calls = [], opened = [];
  for (const id of ['#d-greet', '#d-count', '#d-key', '#d-show-knot', '#d-pill', '#d-word', '#d-step', '#d-esc', '#d-bar', '#d-now', '#d-projects', '#d-asks', '#d-quick', '#d-all-asks']) doc.byId.set(id, doc.createElement('div'));
  doc.byId.get('#d-bar').appendChild(doc.createElement('i'));
  const settings = Object.assign({ hands: true, tasks: true, sounds: true, knotIsland: false, voice: 'fable' }, over.settings);
  const api = {
    settingsGet: async () => settings,
    settingsSet: async (p) => { calls.push(['set', p]); return settings; },
    status: async () => ({ ptt: { accelerator: 'Control+Alt' }, visible: true, captureForcedOff: false }),
    voiceStatus: async () => over.voice || ({ voice: 'fable', installed: true }),
    knotWord: async () => over.word || ({ word: '', tone: 'idle' }),
    sessions: async () => [{ id: 7, title: 'Where is dark mode', started_at: new Date().toISOString() }],
    tasksList: async () => ({ enabled: over.enabled !== false, name: 'Maya', tasks: over.tasks || [], projects: over.projects || [] }),
    taskAction: async (p) => { calls.push(['action', p]); return true; },
    projectContinue: async (id) => { calls.push(['continue', id]); return true; },
    control: async (a) => { calls.push(['control', a]); },
  };
  const h = Now.create({ doc, api, panel: Panel, options: Q, clock: () => Date.parse('2026-11-03T19:30:00'), openSaved: () => opened.push('saved'), openSession: (id) => opened.push('session ' + id), openSettings: (s) => opened.push('settings ' + (s || '')), onError: (e) => { throw e; } });
  return { doc, h, calls, opened, $: (s) => doc.byId.get(s) };
}

test('the home view shows the panel\'s words and sends the card\'s very actions', async () => {
  const needs = { id: 'a', createdAt: '1', state: 'needs_input', executor: 'hands', goal: 'Reply to Prof. Rivera', question: { id: 'c', kind: 'consent', text: 'Click "Send"?', options: [{ id: 'hands-yes', label: 'Yes', primary: true }, { id: 'hands-no', label: 'Not now' }] } };
  const r = homeRig({ tasks: [running({ createdAt: '2' }), needs, { id: 'c', createdAt: '3', state: 'queued', executor: 'hands', request: 'Tidy my Downloads' }], projects: [{ id: 'p1', name: 'Groceries', lastStep: 'Typing' }] });
  await r.h.refresh();
  assert.equal(r.$('#d-greet').textContent, 'Evening, Maya.');
  assert.equal(r.$('#d-count').textContent, '1 working, 1 needs you, 1 up next');
  assert.equal(r.$('#d-key').textContent, 'HoldCtrl+Altto talk');
  const cards = r.$('#d-now').children;
  assert.deepEqual(cards.map((c) => c.dataset.id), ['a', 'b', 'c'], 'needs you first, in the panel\'s order');
  assert.equal(cards[0].classList.contains('needs'), true);
  assert.equal(cards[1].textContent, 'To-do list in NotepadWorkingTyping into "Untitled - Notepad"Stop');
  const button = (card, label) => card.all().find((n) => n.tag === 'button' && n.textContent === label);
  button(cards[0], 'Yes').click();
  button(cards[1], 'Stop').click();
  button(cards[2], 'Not now').click();
  assert.deepEqual(r.calls, [['action', { action: 'hands-yes', taskId: 'a' }], ['action', { action: 'task-stop', taskId: 'b' }], ['action', { action: 'task-cancel', taskId: 'c' }]]);
  r.$('#d-projects').children[0].all().find((n) => n.tag === 'button').click();
  assert.deepEqual(r.calls[3], ['continue', 'p1']);
  r.$('#d-asks').children[0].click();
  assert.deepEqual(r.opened, ['session 7']);
  assert.doesNotMatch(read('companion/home/now.js'), /innerHTML|insertAdjacentHTML|outerHTML/, 'a task\'s words never go in as markup');
});

test('the home view follows the task events and the pill\'s word as they come', async () => {
  const r = homeRig();
  await r.h.refresh();
  assert.equal(r.$('#d-now').children[0].classList.contains('d-empty'), true);
  r.h.onTask({ type: 'step', task: running({ createdAt: '1' }) });
  assert.equal(r.$('#d-now').children[0].dataset.id, 'b');
  r.h.onTask({ type: 'step', task: running({ createdAt: '1', progress: { n: 5, line: 'Pressing Enter' } }) });
  assert.match(r.$('#d-now').children[0].textContent, /Pressing Enter/);
  r.h.onKnot({ word: 'Hands is working', tone: 'hands', step: 'Pressing Enter', bar: null, esc: true, accent: '1,2,3' });
  assert.equal(r.$('#d-word').textContent, 'Hands is working');
  assert.equal(r.$('#d-pill').dataset.state, 'hands');
  assert.equal(r.$('#d-pill').style['--isl-acc'], '1,2,3');
  assert.equal(r.$('#d-esc').hidden, false);
  r.h.onKnot({ word: '', tone: 'idle', step: '', bar: null, esc: false, accent: '' });
  assert.equal(r.$('#d-word').textContent, 'Ready');
  assert.equal(r.$('#d-esc').hidden, true);
  assert.equal(r.$('#d-step').hidden, true);
  assert.equal(r.$('#d-pill').style['--isl-acc'], undefined);
});

test('a card keeps its node through a step and a refresh, so a click in progress is never lost', async () => {
  const needs = { id: 'a', createdAt: '1', state: 'needs_input', executor: 'hands', goal: 'Reply', question: { id: 'c', kind: 'consent', text: 'Send?', options: [{ id: 'hands-yes', label: 'Yes', primary: true }] } };
  const r = homeRig({ tasks: [needs, running({ createdAt: '2' })], projects: [{ id: 'p1', name: 'Groceries', lastStep: 'Typing' }] });
  await r.h.refresh();
  const box = r.$('#d-now'), [first, second] = box.children, stop = second.all().find((n) => n.tag === 'button'), go = r.$('#d-projects').children[0], ask = r.$('#d-asks').children[0];
  r.h.onTask({ type: 'step', task: running({ createdAt: '2', progress: { n: 5, line: 'Pressing Enter' } }) });
  assert.equal(box.children[1], second, 'the working card is the same node');
  assert.equal(second.all().find((n) => n.tag === 'button'), stop, 'and so is its Stop');
  assert.match(second.textContent, /Pressing Enter/, 'with the new line');
  await r.h.refresh(); // what the window's focus brings, on the first click
  assert.equal(box.children[0], first);
  assert.equal(box.children[1], second);
  assert.equal(r.$('#d-projects').children[0], go);
  assert.equal(r.$('#d-asks').children[0], ask);
  stop.click();
  assert.equal(stop.disabled, true);
  await new Promise((res) => setImmediate(res));
  assert.equal(stop.disabled, false, 'a kept button comes back after its press');
  // A real change is a new card, and a card that goes is gone.
  r.h.onTask({ type: 'answered', task: { ...needs, state: 'running', question: null, progress: { n: 1, line: 'Sending' } } });
  assert.notEqual(box.children[0], first);
  r.h.onTask({ type: 'cancelled', task: running({ createdAt: '2', state: 'cancelled' }) });
  assert.equal(box.children.length, 1);
});

test('the pill\'s list holds a rebuild while a press is down, then catches up', () => {
  const doc = fakeDoc(), host = doc.createElement('div');
  const p = Panel.create({ doc, host, send: () => {}, onLayout: () => {}, now: () => 0 });
  p.onEvent({ type: 'sync', enabled: true, name: '', tasks: [running({ createdAt: '1' })] });
  p.setOpen(true);
  const stopOf = () => p.el.all().find((n) => n.tag === 'button' && n.textContent === 'Stop');
  const before = stopOf();
  for (const f of p.el.listeners.pointerdown) f({});
  p.onEvent({ type: 'step', task: running({ createdAt: '1', progress: { n: 5, line: 'Pressing Enter' } }) });
  assert.equal(stopOf(), before, 'the button under the finger stays');
  for (const f of p.el.listeners.pointerleave) f({});
  assert.notEqual(stopOf(), before);
  assert.match(p.el.textContent, /Pressing Enter/, 'and the list catches up');
});

test('the quick row flips through the door, follows the mirror, and the voice never starts a download', async () => {
  const r = homeRig({ settings: { voice: 'system' }, voice: { voice: 'system', installed: false } });
  await r.h.refresh();
  const quick = r.$('#d-quick');
  const tog = (id) => quick.children.find((c) => c.dataset.option === id);
  assert.deepEqual(quick.children.map((c) => c.textContent), ['FreeIsland', 'Hands', 'Task list', 'Hide from sharing', 'Sound cues', 'Open mic', 'Fable voice', 'Settings']);
  tog('hands').click();
  assert.deepEqual(r.calls[0], ['set', { hands: false }]);
  quick.children[0].children[1].click();
  assert.deepEqual(r.calls[1], ['set', { knotIsland: true }]);
  // The other window flipped it: the row shows it with no click here.
  assert.equal(tog('sounds').classList.contains('on'), true);
  r.h.onSettings({ hands: true, tasks: true, sounds: false, knotIsland: true, voice: 'system' });
  assert.equal(tog('sounds').classList.contains('on'), false);
  assert.equal(quick.children[0].children[1].classList.contains('on'), true, 'Island lit');
  // Fable not installed: Settings, no 350 MB behind a switch.
  tog('voice').click();
  assert.deepEqual(r.opened, ['settings voice']);
  assert.equal(r.calls.filter((c) => c[0] === 'set').length, 2);
  quick.children[quick.children.length - 1].click();
  assert.equal(r.opened[1], 'settings ');
});

test('with the task list off the home view says so and offers the switch', async () => {
  const r = homeRig({ enabled: false, settings: { tasks: false } });
  await r.h.refresh();
  const off = r.$('#d-now').children[0];
  assert.match(off.textContent, /The task list is off/);
  off.all().find((n) => n.tag === 'button').click();
  assert.deepEqual(r.calls[0], ['set', { tasks: true }]);
  assert.equal(r.$('#d-count').textContent, 'Nothing running');
});

test('the page: the live view first, the rail kept, and nothing calls itself Home', () => {
  const html = read('companion/home/index.html'), home = read('companion/home/home.js');
  const rail = html.slice(html.indexOf('<nav'), html.indexOf('</nav>'));
  assert.deepEqual([...rail.matchAll(/data-view="(\w+)"/g)].map((m) => m[1]), ['start', 'mynus', 'saved', 'map', 'folders', 'settings', 'feedback']);
  assert.match(rail, />Dashboard<\/button>/);
  assert.doesNotMatch(html.replace(/<!--[\s\S]*?-->/g, ''), />[^<]*\bHome\b[^<]*</, 'the window is the dashboard');
  // Night (0.1.16): the rail carries the site's NŪS wordmark.
  assert.match(html, /<h1>NŪS<\/h1>/);
  assert.match(html, /<link rel="stylesheet" href="now\.css" \/>/);
  assert.match(home, /await setView\('start'\);\}\);/, 'every window opens on it');
  assert.match(home, /\$\('#tour-card'\)\.hidden=!\(st&&\(st\.show\|\|st\.running\)\)/, 'the tour is one line until it is done');
});

test('the dashboard\'s task door takes only a card\'s actions', () => {
  const main = read('companion/index.js');
  assert.match(main, /if \(!\/\^task-\[a-z-\]\+\$\/\.test\(action\) \|\| action === 'task-panel'\) return false;/);
  assert.match(main, /if \(action === 'hands-yes' \|\| action === 'hands-no'\) \{ if \(agent\) agent\.answer\(action === 'hands-yes'\); return true; \}/, 'the same consent path as the Knot\'s card');
  assert.match(main, /const on = tasksOn\(\);\s*if \(!on\) return \{ enabled: false,/, 'with the switch off nothing is booted for it');
  const dash = main.slice(main.indexOf('function dashboardTasks()'), main.indexOf('function dashboardTaskAction'));
  assert.doesNotMatch(dash, /sources|decisions/, 'a project\'s windows and answers stay in main');
});

test('no em dash in anything new', () => {
  for (const f of ['companion/home/now.js', 'companion/home/now.css', 'companion/renderer/pill.js', 'companion/renderer/pill.css', 'companion/renderer/knot-menu.js', 'companion/renderer/quick-options.js']) assert.doesNotMatch(read(f), /—/, f);
});

test('in the pill the Knot\'s own layer lets the words have the mouse', () => {
  const css = read('companion/renderer/pill.css');
  assert.match(css, /body\.island #toolbar, body\.island #knot-shell \{ pointer-events: none; \}/, 'that layer is wider than the Knot and lies over the pill');
  assert.match(css, /body\.island #orb \{ pointer-events: auto; \}/, 'the Knot itself still takes the mouse');
});
