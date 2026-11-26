'use strict';
// A finger has no hover. The overlay is click-through until the cursor probe
// finds the pointer over the Knot or a card, so with a touchscreen the first tap
// on any of them landed on the app underneath, and a tap anywhere while the
// overlay held the mouse was lost.
//
// So on a touchscreen an invisible window sits over the overlay's visible
// controls, cut to their shape: inside the shape it catches the touch, outside
// it the touch goes straight to the app (measured 2026-11-03 with WindowFromPoint:
// shape and ignore both take effect at once, and it never takes focus). What it
// catches goes to the overlay as a stream of events (renderer/touch-forward.js).
//
// Once a finger is in use the overlay stays click-through and everything comes
// this way; a mouse moving ends that, and the overlay takes the mouse as before.
// No window exists until the renderer reports controls, which it does only on a
// machine with a touchscreen. Electron's alwaysOnTop does not hold on a window
// that cannot be foreground, so topmost is set from outside (the probe).
//
// Electron is injected, so this runs in tests.

const TOUCH_LASTS_MS = 800;     // the cursor moving this long after a touch is a mouse
const TOPMOST_EVERY_MS = 2000;
const MAX_RECTS = 24;
const CHANNEL = 'companion:touchpad:event';

function cleanRects(list) {
  const out = [];
  for (const r of Array.isArray(list) ? list.slice(0, MAX_RECTS) : []) {
    const x = Math.floor(Number(r && r.x)), y = Math.floor(Number(r && r.y)), width = Math.ceil(Number(r && r.width)), height = Math.ceil(Number(r && r.height));
    if ([x, y, width, height].every(Number.isFinite) && width > 0 && height > 0) out.push({ x, y, width, height });
  }
  return out;
}
// The freeze under a resting Knot (found 2026-11-11, on every release since this window
// arrived in 0.1.15): Chrome, Edge, every Electron app (the Claude app, the Nus dashboard) and
// Firefox stop drawing a window they believe is covered. They decide that from the windows
// above them, and a window whose shape is ONE plain rectangle counts as covering its whole
// frame, which here is the whole screen. With only the Knot showing the shape was one
// rectangle, so every such app under it stopped painting: nothing typed or scrolled showed
// until the bubble or the greeting box added a second rectangle, or a hover made the window
// click-through. Measured with scripts/lag/rest-freeze.cjs: 0 frames a second under a resting
// Knot, 60 with either of the two guards below.
//   1. The shape is never one plain rectangle: when the controls add up to exactly their
//      bounding box, one corner pixel is left out of it. Nobody can see or miss one pixel.
//   2. The window is a tool window (see ensure), which those apps never count as a cover.
// Either one is enough alone; both are kept so a change to one cannot bring the freeze back.
function unionBox(rects) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rects) { x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, r.x + r.width); y1 = Math.max(y1, r.y + r.height); }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}
// The area the rectangles cover together, overlaps counted once.
function unionArea(rects) {
  const xs = [...new Set(rects.flatMap((r) => [r.x, r.x + r.width]))].sort((a, b) => a - b);
  const ys = [...new Set(rects.flatMap((r) => [r.y, r.y + r.height]))].sort((a, b) => a - b);
  let area = 0;
  for (let i = 0; i + 1 < xs.length; i++) for (let j = 0; j + 1 < ys.length; j++) {
    if (rects.some((r) => r.x <= xs[i] && r.x + r.width >= xs[i + 1] && r.y <= ys[j] && r.y + r.height >= ys[j + 1])) area += (xs[i + 1] - xs[i]) * (ys[j + 1] - ys[j]);
  }
  return area;
}
function isPlainRectangle(rects) {
  if (!rects.length) return false;
  const box = unionBox(rects);
  return unionArea(rects) === box.width * box.height;
}
// The shape handed to the window: the same rectangles, minus the top right pixel of their
// bounding box when together they would make one plain rectangle.
function shapeFor(rects) {
  if (!isPlainRectangle(rects)) return rects;
  const box = unionBox(rects);
  if (box.width < 2 || box.height < 2) return rects;      // a line or a dot: nothing to leave out
  const px = box.x + box.width - 1, py = box.y;
  const out = [];
  for (const r of rects) {
    if (!(px >= r.x && px < r.x + r.width && py >= r.y && py < r.y + r.height)) { out.push(r); continue; }
    if (r.width > 1) out.push({ x: r.x, y: r.y, width: r.width - 1, height: 1 });
    if (r.height > 1) out.push({ x: r.x, y: r.y + 1, width: r.width, height: r.height - 1 });
  }
  return out;
}
const TYPES = new Set(['down', 'move', 'up', 'cancel', 'menu']);
function cleanEvent(ev) {
  if (!ev || !TYPES.has(ev.type)) return null;
  const x = Number(ev.x), y = Number(ev.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { type: ev.type, x, y, id: Number(ev.id) || 1, kind: ev.kind === 'mouse' || ev.kind === 'pen' ? ev.kind : 'touch', button: Number(ev.button) || 0 };
}

function createTouchPad({ BrowserWindow, ipcMain, page, preload, overlayBounds, topmost, onEvent, log = () => {}, now = () => Date.now(), platform = process.platform }) {
  let pad = null, ready = false, shown = false;
  let rects = [], shapeKey = '', boundsKey = '', through = null;
  let touchMode = false, touchAt = 0, cursorAt = null, topmostAt = 0;

  ipcMain.on(CHANNEL, (event, raw) => {
    if (!pad || pad.isDestroyed() || event.sender !== pad.webContents) return;
    const ev = cleanEvent(raw);
    if (!ev) return;
    if (ev.kind !== 'mouse') sawTouch();
    onEvent(ev);
  });

  function sawTouch() { touchMode = true; touchAt = now(); }

  function ensure() {
    if (pad && !pad.isDestroyed()) return;
    const b = overlayBounds();
    pad = new BrowserWindow({ x: b.x, y: b.y, width: b.width, height: b.height, frame: false, transparent: true, hasShadow: false, resizable: false, movable: false, skipTaskbar: true, focusable: false, fullscreenable: false, show: false,
      // A tool window: apps under it never treat it as covering them (see shapeFor above).
      ...(platform === 'win32' ? { type: 'toolbar' } : {}),
      webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true } });
    ready = false; shown = false; shapeKey = ''; boundsKey = ''; through = null; topmostAt = 0;
    const mine = pad;
    pad.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    pad.webContents.on('will-navigate', (e) => e.preventDefault());
    pad.on('closed', () => { if (pad === mine) { pad = null; ready = false; shown = false; } });
    Promise.resolve(pad.loadFile(page)).then(() => { if (pad === mine) ready = true; }).catch((e) => log('touch pad: ' + e.message));
    log('touch pad up');
  }

  function hide() { if (pad && !pad.isDestroyed() && shown) { pad.hide(); shown = false; } }

  // Every probe tick. allowed: false while Hands has the mouse, whose clicks must
  // reach the app under the pad just as they pass through the overlay.
  function tick({ visible, allowed, cursor }) {
    if (cursor) {
      if (touchMode && cursorAt && (Math.abs(cursor.x - cursorAt.x) > 3 || Math.abs(cursor.y - cursorAt.y) > 3) && now() - touchAt > TOUCH_LASTS_MS) touchMode = false;
      cursorAt = { x: cursor.x, y: cursor.y };
    }
    if (!rects.length || !visible || !allowed) { hide(); return; }
    ensure();
    if (!ready) return;
    const b = overlayBounds();
    const bk = [b.x, b.y, b.width, b.height].join();
    if (bk !== boundsKey) { boundsKey = bk; pad.setBounds(b); }
    const sk = JSON.stringify(rects);
    if (sk !== shapeKey) { shapeKey = sk; pad.setShape(shapeFor(rects)); }
    // The mouse over a control: the overlay has it, so the pad stands aside.
    const over = Boolean(cursor) && rects.some((r) => cursor.x - b.x >= r.x && cursor.x - b.x < r.x + r.width && cursor.y - b.y >= r.y && cursor.y - b.y < r.y + r.height);
    const pass = over && !touchMode;
    if (pass !== through) { through = pass; pad.setIgnoreMouseEvents(pass); }
    if (!shown) { pad.showInactive(); shown = true; topmostAt = 0; }
    if (!pad.isAlwaysOnTop() && now() - topmostAt >= TOPMOST_EVERY_MS) {
      topmostAt = now();
      Promise.resolve().then(() => topmost(pad.getNativeWindowHandle().readUInt32LE(0))).catch((e) => log('touch pad topmost: ' + e.message));
    }
  }

  function close() {
    rects = [];
    if (pad && !pad.isDestroyed()) pad.destroy();
    pad = null; ready = false; shown = false;
  }

  return { setRects: (list) => { rects = cleanRects(list); }, tick, sawTouch, close, touching: () => touchMode, active: () => shown };
}

module.exports = { createTouchPad, cleanRects, cleanEvent, shapeFor, isPlainRectangle, CHANNEL, TOUCH_LASTS_MS };
