const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'renderer', 'styles.css'), 'utf8');
const js = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');

test('the persistent companion mark is the animated Nūs Knot', () => {
  assert.match(html, /class="nus-knot"/);
  assert.match(html, /id="knot-bloom"/);
  assert.doesNotMatch(html, /nus-statue-mark\.png/);
  assert.match(css, /@keyframes knotFlow/);
  assert.match(css, /@keyframes knotBreathe/);
});

test('the default sheet is one verb: guide, plus the composer', () => {
  assert.match(html, /id="primary-row"/);
  assert.match(html, /data-mode="guide"/);
  // Manual state buttons are gone: state is displayed, never set by the user.
  assert.doesNotMatch(html, /class="knot-state"/);
  // No Smart pill and no zoom chrome in the composer.
  assert.doesNotMatch(html, /id="smart-toggle"/);
  assert.doesNotMatch(html, /id="zoom-in-btn"/);
  assert.match(html, /id="smart-mode"/, 'Smart moved to Settings as a checkbox');
});

test('call and rehearsal tools only exist in context', () => {
  assert.match(html, /id="live-cluster" *(?:class="[^"]*hidden[^"]*")?/);
  assert.match(html, /class="mode-cluster hidden" id="live-cluster"/);
  assert.match(html, /class="mode-cluster hidden" id="rehearsal-cluster"/);
  assert.match(js, /#live-cluster'\)\.classList\.toggle\('hidden', !active\)/, 'live tools track the capture state');
  assert.match(js, /function syncRehearsalCluster/, 'rehearsal tools require a pack or founder mode');
});

test('the Knot remains wired to live companion state and commands', () => {
  assert.match(js, /function syncKnotUi\(\)/);
  assert.match(js, /function toggleCaptureFromUi\(\)/);
  assert.match(js, /runMode\('guide', ''\)/, 'guide is the default verb');
  assert.match(js, /if \(guideActive\(\)\) dismissGuide\('knot'\);\n\s+else if \(quickOpen\) closeQuickAsk\(\);/, 'the Knot winds the thread back, else opens or closes the quick ask');
  assert.match(js, /else \{ openQuickAsk\(\); if \(!islandOn && knotMenu && !isShown\(tourEl\)\) knotMenu\.show\('knot'\); \}/, 'idle click = the quick ask and the options together, the sheet stays one click further');
});

test('guide runs keyless and the daily line speaks first', () => {
  assert.match(js, /KEYLESS_MODES/, 'keyless modes skip the provider preflight');
  assert.match(js, /nus\.on\('daily:line'/, 'the renderer receives the daily line');
  assert.match(html, /id="daily-line"/);
  assert.match(js, /#daily-line/, 'the daily line is clickable through the overlay');
});

test('founder tooling is hidden from the student build', () => {
  assert.match(html, /data-founder/);
  assert.match(css, /html:not\(\.founder\) \[data-founder\] \{ display: none !important; \}/);
  assert.match(js, /_founderTools/);
});

test('the command sheet and original behavior hooks remain present', () => {
  for (const id of ['panel', 'messages', 'input', 'stop-btn', 'logo-btn']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
});

// Ported 2026-09-15 from the main tree's 2026-09-10 "Companion disappeared" fixes.
test('a double-click on the Knot is one activation and never dismisses the composer', () => {
  // The second click of a double-click used to close the quick ask the first
  // click had just opened and hand the mouse back to the desktop.
  assert.match(js, /function knotClickRepeated\(e\)/);
  assert.match(js, /e\.detail > 1/, 'Chromium click counting decides what a double-click is');
  assert.match(js, /KNOT_CLICK_REPEAT_MS = 400/);
  assert.match(js, /if \(knotClickRepeated\(e\)\) \{ if \(quickOpen\) \$\('#quick-input'\)\.focus\(\); return; \}\n\s+if \(guideActive\(\)\) dismissGuide\('knot'\);/, 'the repeat guard runs before any toggle');
  assert.match(js, /\$\('#orb'\)\.addEventListener\('dblclick', \(e\) => \{ e\.preventDefault\(\);/);
  assert.match(js, /const repeated = \(e && e\.detail > 1\) \|\| at - lastKnotClick < KNOT_CLICK_REPEAT_MS;\n\s+lastKnotClick = at;/, 'repeat timing is against the previous click of any kind');
});

test('the overlay re-asserts always-on-top after a fullscreen app strips it', () => {
  const main = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
  assert.match(main, /function reassertTopmost\(\)/);
  assert.match(main, /if \(!win\.isAlwaysOnTop\(\)\) \{ restoreTopmost\('guard'\); return; \} \} catch/, 'only re-assert when the OS bit is gone: an unconditional call strips it (bit on but buried: on-top.test.js)');
  assert.match(main, /win\.on\('focus', reassertTopmost\)/, 'a Knot click is the moment the bit can be restored');
  assert.match(main, /TOPMOST_GUARD_TICKS = 16/);
  assert.match(main, /if \(\+\+topmostTick >= TOPMOST_GUARD_TICKS\) \{ topmostTick = 0; reassertTopmost\(\); \}/, 'the guard rides the existing cursor probe timer');
  assert.doesNotMatch(main, /setInterval\([^)]*setAlwaysOnTop\(true\)/, 'never an unconditional periodic setAlwaysOnTop(true)');
});

test('showing the overlay restores a stripped always-on-top bit', () => {
  const main = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
  assert.match(main, /function showOverlayWindow\(\) \{\n\s+if \(!win \|\| win\.isDestroyed\(\)\) return;\n\s+if \(process\.platform === 'win32' && !win\.isAlwaysOnTop\(\)\) win\.show\(\);\n\s+else win\.showInactive\(\);/);
  assert.equal((main.match(/\bshowOverlayWindow\(\);/g) || []).length, 3, 'toggle, force show and re-enable all share it');
});

test('a stripped topmost bit is restored through the probe, with Electron as the fallback', () => {
  const main = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
  const ps = fs.readFileSync(path.join(root, 'src', 'win', 'probe.ps1'), 'utf8');
  assert.match(main, /const r = await probe\.request\('win\.topmost', \{ hwnd \}, 1500\);/);
  assert.match(main, /try \{ if \(win && !win\.isDestroyed\(\)\) \{ win\.setAlwaysOnTop\(true\); ok = win\.isAlwaysOnTop\(\); \} \} catch \(_\) \{\}/, 'Electron call stays as the fallback');
  assert.match(ps, /'win\.topmost' \{/, 'the probe answers win.topmost');
  assert.match(ps, /SetWindowPos\(\$h, \[IntPtr\]\(-1\), 0, 0, 0, 0, \[uint32\]\(0x0001 -bor 0x0002 -bor 0x0010\)\)/, 'HWND_TOPMOST without activating (NOSIZE, NOMOVE, NOACTIVATE)');
  assert.match(ps, /public static extern bool SetWindowPos\(/);
  assert.match(ps, /public static extern long GetWindowLongPtrW\(/);
});

test('touch: the Knot and the pill work from pointer events, a finger drags, a double tap opens the dashboard, and a long press stays open', () => {
  const js = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'renderer', 'styles.css'), 'utf8');
  assert.match(css, /#orb, #island \{ touch-action: none; \}/, 'without it the browser cancels the pointer a few pixels into a drag');
  for (const f of ['renderer.js', 'pill.js', 'knot-menu.js', 'quick-options.js', 'surface.js', 'task-panel.js']) {
    const src = fs.readFileSync(path.join(root, 'renderer', f), 'utf8');
    assert.doesNotMatch(src, /addEventListener\('mouse(?:down|up|enter|leave|over|out)'/, f + ' has a mouse-only press or hover');
  }
  assert.match(js, /if \(e\.timeStamp - knotTapAt < KNOT_DOUBLE_TAP_MS\) \{ knotTapAt = 0; knotDashboard\(\); \}/);
  assert.match(js, /if \(e\.pointerType !== 'touch' \|\| suppressClick\) return;/, 'a drag is no tap');
  assert.match(js, /function knotDashboard\(\) \{\s+if \(performance\.now\(\) - knotDashAt < 600\) return;/, 'a tap count and a dblclick open it once');
  assert.match(js, /if \(knotMenu && !pressedLong\) knotMenu\.toggle\('pill'\);/, 'the contextmenu of a long press does not shut the menu it opened');
  assert.match(js, /knotMenu && !\(islandOn && pressedLong\)/);
  assert.match(js, /function pressStart\(e\) \{\s+pressedLong = false;\s+if \(e\.button !== 0\) return;/, 'a right click after a long press still opens the menu');
  assert.match(js, /islandEl\.addEventListener\('pointercancel', pressEnd\);/);
  assert.match(js, /orbEl\.addEventListener\('pointercancel', \(\) => pressEnd\(\)\);/);
});

// ---- the touch pad ----
const { createTouchPad, cleanRects, cleanEvent, shapeFor, isPlainRectangle, TOUCH_LASTS_MS } = require('../src/touch-pad');
const { EventEmitter } = require('node:events');
require('../renderer/touch-forward.js');

function padRig() {
  const made = [], calls = { topmost: 0, events: [] };
  let clock = 10000;
  class FakeWindow extends EventEmitter {
    constructor(o) { super(); this.o = o; this.log = []; this.top = false; this.dead = false; this.webContents = { setWindowOpenHandler() {}, on() {} }; made.push(this); }
    isDestroyed() { return this.dead; } destroy() { this.dead = true; this.log.push('destroy'); }
    loadFile() { return Promise.resolve(); }
    setBounds(b) { this.log.push(['bounds', b]); } setShape(r) { this.log.push(['shape', r]); }
    setIgnoreMouseEvents(v) { this.ignoring = v; this.log.push(['ignore', v]); }
    showInactive() { this.visible = true; this.log.push('show'); } hide() { this.visible = false; this.log.push('hide'); }
    isAlwaysOnTop() { return this.top; }
    getNativeWindowHandle() { const b = Buffer.alloc(8); b.writeUInt32LE(4242, 0); return b; }
  }
  const ipc = new EventEmitter();
  const pad = createTouchPad({ BrowserWindow: FakeWindow, ipcMain: ipc, page: 'p.html', preload: 'p.js', overlayBounds: () => ({ x: 0, y: 0, width: 1920, height: 1080 }), topmost: (h) => { calls.topmost = h; made[0].top = true; }, onEvent: (e) => calls.events.push(e), now: () => clock });
  const settle = () => new Promise((r) => setImmediate(r));
  return { pad, made, calls, ipc, settle, advance: (ms) => { clock += ms; } };
}
const KNOT = [{ x: 100, y: 100, width: 80, height: 80 }];
const AWAY = { x: 900, y: 900 }, OVER = { x: 120, y: 120 };

test('touch pad: no controls reported, no window; it never activates and is sandboxed', async () => {
  const g = padRig();
  g.pad.tick({ visible: true, allowed: true, cursor: AWAY });
  assert.equal(g.made.length, 0, 'a machine with no touchscreen never reports, so never gets one');
  g.pad.setRects(KNOT);
  g.pad.tick({ visible: true, allowed: true, cursor: AWAY });
  assert.equal(g.made.length, 1);
  const o = g.made[0].o;
  assert.equal(o.focusable, false);
  assert.equal(o.show, false);
  assert.equal(o.alwaysOnTop, undefined, 'the option does not hold on a window that cannot be foreground');
  assert.deepEqual([o.webPreferences.sandbox, o.webPreferences.contextIsolation, o.webPreferences.nodeIntegration], [true, true, false]);
});

test('touch pad: cut to the controls, topmost from outside, standing aside for the mouse and for Hands', async () => {
  const g = padRig();
  g.pad.setRects(KNOT);
  g.pad.tick({ visible: true, allowed: true, cursor: AWAY });
  await g.settle();
  g.pad.tick({ visible: true, allowed: true, cursor: AWAY });
  await g.settle();
  const w = g.made[0];
  // The Knot alone is one rectangle; the window's shape leaves one corner pixel out (next test).
  assert.deepEqual(w.log.find((l) => l[0] === 'shape')[1], [{ x: 100, y: 100, width: 79, height: 1 }, { x: 100, y: 101, width: 80, height: 79 }]);
  assert.equal(w.o.type, process.platform === 'win32' ? 'toolbar' : undefined, 'a tool window on Windows');
  assert.equal(w.ignoring, false, 'catching, with the cursor elsewhere');
  assert.equal(w.visible, true);
  assert.equal(g.calls.topmost, 4242);
  const shapes = () => w.log.filter((l) => l[0] === 'shape').length;
  g.pad.tick({ visible: true, allowed: true, cursor: AWAY });
  assert.equal(shapes(), 1, 'reshaped only when it changes');
  g.pad.tick({ visible: true, allowed: true, cursor: OVER });
  assert.equal(w.ignoring, true, 'the mouse over a control: the overlay has it');
  g.pad.tick({ visible: true, allowed: false, cursor: AWAY });
  assert.equal(w.visible, false, 'Hands is clicking: its clicks must reach the app');
  g.pad.tick({ visible: true, allowed: true, cursor: AWAY });
  assert.equal(w.visible, true);
  g.pad.tick({ visible: false, allowed: true, cursor: AWAY });
  assert.equal(w.visible, false, 'the overlay is hidden');
  g.pad.setRects([]);
  g.pad.tick({ visible: true, allowed: true, cursor: AWAY });
  assert.equal(w.visible, false, 'an empty shape would mean the whole window, so no controls hides it');
  g.pad.close();
  assert.equal(w.dead, true);
});

// The freeze under a resting Knot (2026-11-11): a window shaped as one plain rectangle counts,
// to Chrome, Electron apps and Firefox, as covering its whole frame (here the whole screen), and
// they stop drawing under it. The live check is scripts/lag/rest-freeze.cjs check.
test('touch pad: the shape is never one plain rectangle', () => {
  const area = (rects) => { let n = 0; const seen = new Set(); for (const r of rects) for (let x = r.x; x < r.x + r.width; x++) for (let y = r.y; y < r.y + r.height; y++) { const k = x + ',' + y; if (!seen.has(k)) { seen.add(k); n++; } } return n; };
  // The Knot alone: one pixel short of its rectangle, and not a rectangle any more.
  const alone = shapeFor(KNOT);
  assert.equal(isPlainRectangle(KNOT), true);
  assert.equal(isPlainRectangle(alone), false);
  assert.equal(area(alone), 80 * 80 - 1);
  // The Knot and a bubble apart from it: already not a rectangle, left exactly as it is.
  const two = [KNOT[0], { x: 300, y: 40, width: 200, height: 60 }];
  assert.equal(isPlainRectangle(two), false);
  assert.strictEqual(shapeFor(two), two);
  // Pieces that add up to one rectangle are caught too: side by side, overlapping, or one inside another.
  for (const made of [
    [{ x: 0, y: 0, width: 40, height: 50 }, { x: 40, y: 0, width: 40, height: 50 }],
    [{ x: 0, y: 0, width: 50, height: 50 }, { x: 30, y: 0, width: 50, height: 50 }],
    [{ x: 0, y: 0, width: 80, height: 50 }, { x: 60, y: 0, width: 20, height: 10 }],
  ]) {
    assert.equal(isPlainRectangle(made), true);
    const out = shapeFor(made);
    assert.equal(isPlainRectangle(out), false, JSON.stringify(made));
    assert.equal(area(out), area(made) - 1, 'exactly one pixel is left out');
  }
  // An L is not a rectangle; a single pixel has nothing to leave out.
  assert.equal(isPlainRectangle([{ x: 0, y: 0, width: 10, height: 30 }, { x: 0, y: 20, width: 30, height: 10 }]), false);
  assert.deepEqual(shapeFor([{ x: 5, y: 5, width: 1, height: 1 }]), [{ x: 5, y: 5, width: 1, height: 1 }]);
  assert.deepEqual(shapeFor([]), []);
});

test('touch pad: every shape it sets while the controls change stays clear of a plain rectangle', async () => {
  const g = padRig();
  const shown = [KNOT, [KNOT[0], { x: 300, y: 40, width: 200, height: 60 }], KNOT, [{ x: 0, y: 0, width: 1920, height: 40 }], [{ x: 10, y: 10, width: 40, height: 40 }, { x: 50, y: 10, width: 40, height: 40 }]];
  for (const rects of shown) { g.pad.setRects(rects); g.pad.tick({ visible: true, allowed: true, cursor: AWAY }); await g.settle(); g.pad.tick({ visible: true, allowed: true, cursor: AWAY }); }
  const shapes = g.made[0].log.filter((l) => l[0] === 'shape').map((l) => l[1]);
  assert.equal(shapes.length, shown.length);
  for (const s of shapes) assert.equal(isPlainRectangle(s), false, JSON.stringify(s));
});

test('touch pad: a finger keeps it catching with the cursor parked on a control, until a mouse moves', async () => {
  const g = padRig();
  g.pad.setRects(KNOT);
  g.pad.tick({ visible: true, allowed: true, cursor: AWAY });
  await g.settle();
  const w = g.made[0];
  g.ipc.emit('companion:touchpad:event', { sender: w.webContents }, { type: 'down', x: 120, y: 120, id: 7, kind: 'touch', button: 0 });
  assert.equal(g.pad.touching(), true);
  assert.deepEqual(g.calls.events[0], { type: 'down', x: 120, y: 120, id: 7, kind: 'touch', button: 0 });
  g.pad.tick({ visible: true, allowed: true, cursor: OVER });
  assert.equal(w.ignoring, false, 'Windows parks the cursor where the finger was: the pad stays, the next tap comes the same way');
  assert.equal(g.pad.touching(), true, 'the cursor jumping with the touch is not a mouse');
  g.advance(TOUCH_LASTS_MS + 1);
  g.pad.tick({ visible: true, allowed: true, cursor: { x: 140, y: 140 } });
  assert.equal(g.pad.touching(), false, 'the cursor moving later is');
  assert.equal(w.ignoring, true);
  g.ipc.emit('companion:touchpad:event', { sender: w.webContents }, { type: 'down', x: 1, y: 1, id: 1, kind: 'mouse', button: 0 });
  assert.equal(g.pad.touching(), false, 'a mouse that got there first is no finger');
});

test('touch pad: only its own page is heard, and only well-formed events', () => {
  const g = padRig();
  g.pad.setRects(KNOT);
  g.pad.tick({ visible: true, allowed: true, cursor: AWAY });
  g.ipc.emit('companion:touchpad:event', { sender: {} }, { type: 'down', x: 1, y: 1 });
  g.ipc.emit('companion:touchpad:event', { sender: g.made[0].webContents }, { type: 'run', x: 1, y: 1 });
  g.ipc.emit('companion:touchpad:event', { sender: g.made[0].webContents }, { type: 'down', x: 'a', y: 1 });
  assert.equal(g.calls.events.length, 0);
  assert.equal(cleanEvent(null), null);
  assert.deepEqual(cleanRects([{ x: 1.5, y: 2.5, width: 3.2, height: 0 }, { x: 1.5, y: 2.5, width: 3.2, height: 4.1 }, null, 'x']), [{ x: 1, y: 2, width: 4, height: 5 }]);
});

// A page's worth of DOM for the forwarder: events are recorded, not dispatched.
function forwardRig({ target = 'orb', zoom = 1 } = {}) {
  const seen = [];
  const el = (name, typing) => ({ name, focused: false, focus() { this.focused = true; }, closest() { return typing ? this : null; }, dispatchEvent(e) { seen.push(Object.assign({ on: name }, e)); return true; } });
  const nodes = { orb: el('orb'), field: el('field', true) };
  let clock = 0;
  const Ev = function (type, init) { return Object.assign({ type }, init); };
  const doc = { elementFromPoint: (x, y) => (target ? Object.assign(nodes[target], { hit: [x, y] }) : null) };
  const f = globalThis.NusTouchForward.create({ doc, view: { PointerEvent: Ev, MouseEvent: Ev }, zoom: () => zoom, now: () => clock });
  const ev = (type, x, y, extra) => Object.assign({ type, x, y, id: 7, kind: 'touch', button: 0 }, extra || {});
  return { f, seen, nodes, ev, types: () => seen.map((s) => s.type), advance: (ms) => { clock += ms; } };
}

test('forwarded: a tap is the pointer events and a click, with the finger\'s kind and place', () => {
  const g = forwardRig({ zoom: 2 });
  assert.equal(g.f.handle(g.ev('down', 200, 100)), null);
  assert.equal(g.f.handle(g.ev('up', 200, 100)), 'tap');
  assert.deepEqual(g.types(), ['pointerdown', 'pointerup', 'click']);
  assert.equal(g.seen[0].pointerType, 'touch', 'the double tap and the long press read this');
  assert.equal(g.seen[0].pointerId, 7);
  assert.equal(g.seen[0].button, 0);
  assert.equal(g.seen[0].bubbles, true);
  assert.deepEqual([g.seen[2].clientX, g.seen[2].clientY, g.seen[2].detail], [100, 50, 1], 'window DIPs to CSS px at the zoom');
  assert.deepEqual(g.nodes.orb.hit, [100, 50]);
});

test('forwarded: a drag and a long press are no click; a cancel ends the press; off the controls nothing fires', () => {
  let g = forwardRig();
  g.f.handle(g.ev('down', 100, 100)); g.f.handle(g.ev('move', 130, 100));
  assert.equal(g.f.handle(g.ev('up', 130, 100)), null);
  assert.deepEqual(g.types(), ['pointerdown', 'pointermove', 'pointerup']);
  g = forwardRig();
  g.f.handle(g.ev('down', 100, 100)); g.advance(600);
  assert.equal(g.f.handle(g.ev('up', 100, 100)), null, 'the pill\'s long press had its timer');
  g = forwardRig();
  g.f.handle(g.ev('down', 100, 100)); g.f.handle(g.ev('menu', 100, 100, { button: 2 }));
  assert.equal(g.f.handle(g.ev('up', 100, 100)), null);
  assert.deepEqual(g.types(), ['pointerdown', 'contextmenu', 'pointerup']);
  g = forwardRig();
  g.f.handle(g.ev('down', 100, 100)); g.f.handle(g.ev('cancel', 100, 100));
  assert.deepEqual(g.types(), ['pointerdown', 'pointercancel']);
  assert.equal(g.f.handle(g.ev('up', 100, 100)), null);
  g = forwardRig({ target: null });
  g.f.handle(g.ev('down', 100, 100));
  assert.equal(g.f.handle(g.ev('up', 100, 100)), null);
  assert.deepEqual(g.types(), []);
});

test('forwarded: a tap on a text field focuses it', () => {
  const g = forwardRig({ target: 'field' });
  g.f.handle(g.ev('down', 10, 10)); g.f.handle(g.ev('up', 10, 10));
  assert.equal(g.nodes.field.focused, true);
  assert.equal(g.types().at(-1), 'click');
});

test('the rects are what shows and takes the mouse, in window DIPs', () => {
  const box = (left, top, width, height) => ({ getBoundingClientRect: () => ({ left, top, width, height }) });
  const els = [Object.assign(box(10, 20, 30, 40), { st: {} }), Object.assign(box(1, 1, 9, 9), { st: { display: 'none' } }), Object.assign(box(1, 1, 9, 9), { st: { visibility: 'hidden' } }), Object.assign(box(1, 1, 9, 9), { st: { pointerEvents: 'none' } }), Object.assign(box(1, 1, 0, 9), { st: {} })];
  const rects = globalThis.NusTouchForward.rectsOf({ querySelectorAll: () => els }, { getComputedStyle: (e) => e.st }, 'x', 1.2);
  assert.deepEqual(rects, [{ x: 12, y: 24, width: 36, height: 48 }]);
});

test('touch pad wiring: same controls as the hit test, in the page, in main, before the overlay goes', () => {
  const js = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
  const hit = js.match(/el\.closest\('(#knot-shell[^']+)'\) \|\| overPillAt/)[1].split(', ').concat(js.match(/el\.closest\('(#island\.live[^']+)'\)/)[1].split(', '));
  const list = js.match(/const TOUCH_CONTROLS = '([^']+)'/)[1].split(', ');
  for (const s of hit) assert.ok(list.includes(s), s + ' is a control the pad must cover');
  assert.match(js, /if \(navigator\.maxTouchPoints > 0 && nus\.touchPadRects && window\.NusTouchForward\)/, 'nothing runs without a touchscreen');
  assert.match(js, /setIgnore\(fingerInUse \? !modalOpen\(\) : !overUIAt\(x \/ z, y \/ z\)\);/);
  assert.match(js, /if \(!fingerInUse\) setIgnore\(!overUIAt\(e\.clientX, e\.clientY\)\);/);
  assert.match(main, /process\.platform === 'win32' && process\.env\.NUS_NO_TOUCH_PAD !== '1'/);
  assert.match(main, /topmost: \(hwnd\) => \(probeReady\(\) \? probe\.request\('win\.topmost', \{ hwnd \}, 1500\) : null\)/);
  assert.match(main, /allowed: !\(agent && agent\.active\(\) && !agent\.asking\(\)\) && handsMouseOps === 0/, 'it stands aside exactly when the overlay does');
  assert.ok(main.indexOf('touchPad.tick(') < main.indexOf("if (!win || win.isDestroyed() || !win.isVisible()) return;\n    if (++topmostTick"), 'a hidden overlay still reaches the pad, which hides');
  assert.match(main, /if \(touchPad\) touchPad\.close\(\);\s+if \(win && !win\.isDestroyed\(\)\) win\.destroy\(\);/);
  assert.match(html, /<script src="touch-forward\.js[^"]*"><\/script>\s+<script src="renderer\.js/);
  const pre = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
  assert.match(pre, /'touchpad:event'/);
  const padPre = fs.readFileSync(path.join(root, 'touch-pad-preload.js'), 'utf8');
  assert.equal((padPre.match(/ipcRenderer\.\w+\(/g) || []).length, 1, 'the pad page can say one thing');
});

test('after a click on the Knot the keys stay on the ask line, and go back to the app when nothing here wants them', () => {
  const js = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');
  const main = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
  // The settled pick stands: one click opens both. Only the keys change.
  assert.match(js, /else \{ openQuickAsk\(\); if \(!islandOn && knotMenu && !isShown\(tourEl\)\) knotMenu\.show\('knot'\); \}/);
  assert.match(js, /if \(!handsState\.active && !quickOpen\) knotMenu\.el\.focus\(\{ preventScroll: true \}\);/, 'the menu takes the keys only with no ask line');
  // Every way a Knot click ends.
  const close = js.slice(js.indexOf('function closeQuickAsk()'), js.indexOf("quickInput.addEventListener('keydown'"));
  assert.match(close, /releaseKeys\(\);/, 'the ask line closed');
  const dismiss = js.slice(js.indexOf('function dismissGuide(reason)'), js.indexOf('// The consent chip'));
  assert.match(dismiss, /releaseKeys\(\);/, 'a guide dismissed');
  assert.match(js, /else if \(knotMenu\.source === 'knot'\) releaseKeys\(\);/, 'the Knot menu folded; the pill keeps what it had');
  assert.match(js, /hideTiles\(\); releaseKeys\(\);/, 'the sheet folded');
  assert.match(js.slice(js.indexOf('function endDrag(e)'), js.indexOf("orbEl.addEventListener('pointerup', endDrag)")), /releaseKeys\(\);/, 'a drag ended');
  assert.match(main, /'companion:keys:release', \(\) => \{ if \(win && !win\.isDestroyed\(\) && win\.isFocused\(\)\) \{ try \{ win\.blur\(\);/, 'main hands it back only while it holds it');
  assert.match(fs.readFileSync(path.join(__dirname, '../preload.js'), 'utf8'), /releaseKeys: \(\) => ipcRenderer\.send\('companion:keys:release'\)/);
});

// keysWanted and releaseKeys from the real source, with the page stubbed.
function releaseRig(over = {}) {
  const js = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');
  const body = js.slice(js.indexOf('function keysWanted()'), js.indexOf('function closeQuickAsk()'));
  const timers = [];
  const sent = [];
  const ctx = Object.assign({
    quickOpen: false, modalOpen: () => false, isShown: () => false, tourEl: {}, knotMenu: { open: false },
    document: { activeElement: { matches: () => false }, hasFocus: () => true },
    nus: { releaseKeys: () => sent.push('release') },
    setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout: (id) => { if (id) timers[id - 1] = null; },
  }, over);
  vm.runInNewContext(body, ctx);
  return { ctx, sent, run: () => { for (const t of timers.splice(0)) if (t) t(); } };
}

test('the keyboard is handed back once, a tick later, and only with nothing here wanting keys', () => {
  const r = releaseRig();
  r.ctx.releaseKeys(); r.ctx.releaseKeys(); r.ctx.releaseKeys();
  assert.equal(r.sent.length, 0, 'not at once: whatever closed this may be opening the next surface');
  r.run();
  assert.equal(r.sent.length, 1, 'three closes in one tick, one hand-back');
  // A surface opened in the same tick keeps them.
  const opened = releaseRig();
  opened.ctx.releaseKeys();
  opened.ctx.quickOpen = true;
  opened.run();
  assert.equal(opened.sent.length, 0);
  for (const [why, over] of [
    ['the ask line', { quickOpen: true }],
    ['settings or onboarding', { modalOpen: () => true }],
    ['the tour', { isShown: () => true }],
    ['the menu', { knotMenu: { open: true } }],
    ['a text field', { document: { activeElement: { matches: () => true }, hasFocus: () => true } }],
    ['another window already has the keyboard', { document: { activeElement: { matches: () => false }, hasFocus: () => false } }],
  ]) {
    const held = releaseRig(over);
    held.ctx.releaseKeys();
    held.run();
    assert.equal(held.sent.length, 0, why);
  }
});
