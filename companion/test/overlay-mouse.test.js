'use strict';
// The overlay takes the mouse only while the page says so, and a page that stops
// answering cannot keep it (live 2026-11-03: 1 to 3 s per Knot flight).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createOverlayMouse, WAIT_MS } = require('../src/overlay-mouse');

const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

function rig() {
  let t = 1000;
  const applied = [], forced = [], logged = [];
  const m = createOverlayMouse({ apply: (v) => applied.push(v), forced: () => forced.push(t), log: (l) => logged.push(l), now: () => t });
  return { m, applied, forced, logged, at: (ms) => { t += ms; }, ticks(n, answer) { for (let i = 0; i < n; i++) { t += 120; m.tick(true); if (answer) m.answered(); } } };
}

test('the window is called only when the state differs', () => {
  const r = rig();
  assert.equal(r.m.set(true), true);
  assert.equal(r.m.set(true), false);
  assert.equal(r.m.set(false), true);
  assert.equal(r.m.set(false), false);
  assert.equal(r.m.set(true), true);
  assert.deepEqual(r.applied, [true, false, true]);
  assert.equal(r.m.state(), true);
  // A new window has no state yet, so the next word reaches it.
  r.m.reset();
  assert.equal(r.m.state(), null);
  assert.equal(r.m.set(true), true);
});

test('a page answering every tick is never overruled', () => {
  const r = rig();
  r.m.set(false);
  r.ticks(100, true);
  assert.deepEqual(r.applied, [false]);
  assert.equal(r.forced.length, 0);
});

test('taking the mouse, no answer for 400 ms: main lets go, tells the page, once', () => {
  assert.equal(WAIT_MS, 400);
  const r = rig();
  r.m.set(false);
  r.ticks(3);
  assert.deepEqual(r.applied, [false], 'not at 240 ms');
  r.ticks(1);
  assert.deepEqual(r.applied, [false], 'not at 360 ms');
  r.ticks(1);
  assert.deepEqual(r.applied, [false, true], 'at 480 ms, the first tick past the wait');
  assert.equal(r.forced.length, 1);
  assert.match(r.logged[0], /click-through forced/);
  r.ticks(50);
  assert.deepEqual(r.applied, [false, true], 'the page still silent: nothing more to do');
  assert.equal(r.forced.length, 1);
});

test('the page coming back takes the mouse again if it wants it', () => {
  const r = rig();
  r.m.set(false);
  r.ticks(5);
  assert.equal(r.m.state(), true);
  r.m.answered();
  r.m.set(false);
  assert.deepEqual(r.applied, [false, true, false]);
  // And the wait starts from there, not from before the stall.
  r.ticks(2);
  assert.deepEqual(r.applied, [false, true, false]);
});

test('already click-through, a silent page changes nothing', () => {
  const r = rig();
  r.m.set(true);
  r.ticks(100);
  assert.deepEqual(r.applied, [true]);
  assert.equal(r.forced.length, 0);
});

test('a stale wait from a click-through stretch does not fire the moment the mouse is taken', () => {
  const r = rig();
  r.m.set(true);
  r.ticks(20);
  r.m.set(false);
  r.ticks(1);
  assert.deepEqual(r.applied, [true, false]);
});

test('a window that has not been told yet is let go too: it starts out taking the mouse', () => {
  const r = rig();
  r.ticks(5);
  assert.deepEqual(r.applied, [true]);
  assert.equal(r.forced.length, 1);
});

test('the pointer off this window: no answer is due, so none is missed', () => {
  const r = rig();
  r.m.set(false);
  for (let i = 0; i < 50; i++) { r.at(120); r.m.tick(false); }
  r.ticks(2);
  assert.deepEqual(r.applied, [false]);
});

test('main itself held up: the queued answers get their chance first', () => {
  const r = rig();
  r.m.set(false);
  r.ticks(1, true);
  r.at(2000);
  r.m.tick(true);
  assert.deepEqual(r.applied, [false], 'the late tick starts the wait over');
  r.m.answered();
  r.ticks(1, true);
  assert.deepEqual(r.applied, [false]);
});

test('main is the one owner: every change goes through it', () => {
  const main = read('index.js');
  assert.equal((main.match(/\.setIgnoreMouseEvents\(/g) || []).length, 1, 'one call to the window, in the apply');
  assert.match(main, /apply: \(v\) => \{ if \(win && !win\.isDestroyed\(\)\) win\.setIgnoreMouseEvents\(v, \{ forward: true \}\); \}/);
  assert.match(main, /forced: \(\) => send\('mouse:forced', \{\}\)/);
  // A new window starts over, before anything can ask it.
  const create = main.slice(main.indexOf('function createOverlayWindow()'), main.indexOf("win.on('focus', reassertTopmost)"));
  assert.match(create, /overlayMouse\.reset\(\);/);
  // Anything from the page counts as an answer, including a word main does not take.
  const door = main.slice(main.indexOf("companionIpc.on('companion:mouse:ignore'"), main.indexOf('// A touchscreen\'s controls'));
  assert.ok(door.indexOf('overlayMouse.answered()') < door.indexOf('if (!v && agent'), 'before the Hands rule returns');
  assert.match(door, /overlayMouse\.set\(v\);/);
  // The probe asks only when the pointer is on the window, and says so.
  const probe = main.slice(main.indexOf('function startCursorProbe()'), main.indexOf('function stopCursorProbe()'));
  assert.match(probe, /if \(!inside\) \{ overlayMouse\.tick\(false\);/);
  assert.ok(probe.indexOf('overlayMouse.tick(true)') < probe.indexOf("send('cursor:probe'"));
});

test('the page answers every tick, resyncs when told, and lets go before a flight', () => {
  const js = read('renderer/renderer.js');
  const onProbe = js.slice(js.indexOf("nus.on('cursor:probe'"), js.indexOf("nus.on('cursor:away'"));
  assert.match(onProbe, /pointerAt = \{ x: x \/ z, y: y \/ z \};/);
  assert.match(onProbe, /nus\.setIgnoreMouse\(ignoring\);/, 'every tick, whatever it wants');
  assert.ok(onProbe.indexOf('nus.setIgnoreMouse(ignoring)') > onProbe.indexOf("nus.setIgnoreMouse(false, 'pill')"), 'after the pill has asked');
  assert.ok(onProbe.indexOf('nus.setIgnoreMouse(ignoring)') < onProbe.indexOf('pointerTick('), 'ahead of the hover and fold timing, which stay as they are');
  assert.match(js, /nus\.on\('cursor:away', \(\) => \{ pointerAt = null;/);
  assert.match(js, /nus\.on\('mouse:forced', \(\) => \{ ignoring = true; \}\);/);
  assert.match(read('preload.js'), /'mouse:forced'/);
  const move = js.slice(js.indexOf('function moveKnotTo(dest'), js.indexOf("nus.on('knot:move'"));
  const lets = move.indexOf('setIgnoreSafe(true)');
  assert.ok(lets > 0);
  assert.ok(lets > move.indexOf('hideBubble()'), 'after the surfaces close');
  assert.ok(lets < move.indexOf('knot3d.travelTo('), 'before the flight');
  assert.match(move, /if \(!overUIAt\(at\.x, at\.y\)\) setIgnoreSafe\(true\);/, 'unless the pointer is over a control');
  // What was settled stays.
  assert.equal(require('../renderer/task-panel.js').HOVER_OPEN_MS, 400);
  assert.equal(require('../renderer/knot-menu.js').LEAVE_MS, 6000);
});

test('what is hidden cannot take the mouse, and a mouse click does not hold the capsule open', () => {
  const css = read('renderer/styles.css');
  assert.doesNotMatch(css, /:focus-within/, 'a click leaves focus on the Knot: it must not keep the capsule open');
  assert.match(css, /body\.island #knot-shell:hover #knot-bloom,\s*#knot-shell:has\(:focus-visible\) #knot-bloom,/, 'the keyboard still opens it');
  // The capsule hidden takes no clicks, and nothing in it may say otherwise.
  const bloom = css.slice(css.indexOf('#knot-bloom {'), css.indexOf('body.island #knot-shell:hover #knot-bloom,'));
  assert.match(bloom, /pointer-events: none;/);
  assert.match(css, /#knot-bloom #orb-controls \{[^}]*pointer-events: inherit;/, 'the buttons go by the capsule');
  assert.doesNotMatch(css, /#toolbar:hover #orb-controls \{[^}]*pointer-events/, 'hover on the toolbar does not bring them back');
});

test('a mouse taken far from the Knot is named in route.log, with ids and numbers only', () => {
  const { mouseNoteLine } = require('../src/overlay-mouse');
  assert.equal(mouseNoteLine({ by: '#knot-bloom', x: 1605, y: 760, knotX: 1755, knotY: 100 }), 'overlay took the mouse at 1605,760, 677 px from the Knot at 1755,100: #knot-bloom');
  assert.equal(mouseNoteLine({ by: 'dragging', x: 10.4, y: 20.6, knotX: 500, knotY: 500 }), 'overlay took the mouse at 10,21, 685 px from the Knot at 500,500: dragging');
  assert.equal(mouseNoteLine({ by: 'dragged', x: 1602, y: 793, knotX: 1602, knotY: 793 }), 'the Knot was dragged to 1602,793');
  // Nothing but an element's name and numbers gets through.
  for (const bad of [null, {}, { by: 'my secret words', x: 1, y: 1, knotX: 1, knotY: 1 }, { by: '#a', x: 'x', y: 1, knotX: 1, knotY: 1 }, { by: '#a', y: 1, knotX: 1, knotY: 1 }, { by: 'a'.repeat(61), x: 1, y: 1, knotX: 1, knotY: 1 }]) assert.equal(mouseNoteLine(bad), null);
  const js = read('renderer/renderer.js');
  assert.match(js, /if \(v === false\) noteMouseTaken\(\);/, 'only when it takes the mouse, and the guard above means only on the change');
  assert.match(js, /const FAR_FROM_KNOT_PX = 120;/);
  assert.match(js, /el\.id \? '#' \+ el\.id : el\.tagName\.toLowerCase\(\)/, 'never its text');
  assert.match(js.slice(js.indexOf('function endDrag(e)'), js.indexOf("orbEl.addEventListener('pointerup', endDrag)")), /by: 'dragged'/, 'a drag says where the Knot went');
  assert.match(read('index.js'), /companionIpc\.on\('companion:mouse:note', \(_e, note\) => \{ const line = mouseNoteLine\(note\); if \(line\) routeLog\(line\); \}\);/);
});

test('a hover on the free Knot shows the panel only; the capsule still shows while listening and thinking', () => {
  const css = read('renderer/styles.css');
  const open = /([^{}]*)\{\s*opacity: 1;\s*transform: none;\s*pointer-events: auto;\s*\}/.exec(css.slice(css.indexOf('body.island #knot-shell:hover #knot-bloom,') - 1));
  const list = open[1];
  assert.match(list, /body\.island #knot-shell:hover #knot-bloom/, 'in the pill as it was');
  assert.doesNotMatch(list.replace(/body\.island #knot-shell:hover #knot-bloom/, ''), /:hover/, 'no other hover opens it');
  assert.match(list, /#toolbar\[data-knot-state='listening'\] #knot-bloom/);
  assert.match(list, /#toolbar\[data-knot-state='thinking'\] #knot-bloom/);
  assert.match(list, /#toolbar\.panel-open #knot-bloom/);
  // Its one button that matters is still reachable: the dashboard's rail starts the tour.
  assert.match(read('home/index.html'), /id="tutorial"/);
  assert.match(read('home/home.js'), /\$\('#tutorial'\)\.onclick=\(\)=>run\(\(\)=>api\.control\('tutorial'\)\);/);
  assert.match(fs.readFileSync(path.join(root, '..', 'src', 'main-companion.js'), 'utf8'), /tutorial: \(\) => companion\.startTour\(\)/);
});
