'use strict';
// Pointing on a Mac: the model's box reaches the screen through companion/src/screen-points.js
// (Electron's own conversion is Windows only). This drives a real reply through the same chain the
// guide uses, on a Retina display, and checks where it lands.
//
// 0.1.27 took out 0.1.24's pointing changes (a [DONE] step with a target is pointed at; half-pixel
// boxes). The cases for those went with them; they come back when the Windows build brings them back.
const test = require('node:test');
const assert = require('node:assert/strict');
const { parsePointReply, validatePoint } = require('../src/guide/pointing');
const { physRectFromNorm, physRectToWindow } = require('../src/guide/verify');
const { createScreenPoints } = require('../src/screen-points');

// A 14-inch MacBook: 1512 x 982 points at scale 2, the menu bar 25 points tall.
const display = { id: 1, bounds: { x: 0, y: 0, width: 1512, height: 982 }, workArea: { x: 0, y: 25, width: 1512, height: 957 }, scaleFactor: 2 };
const screen = { getAllDisplays: () => [display], getDisplayNearestPoint: () => display };
const points = createScreenPoints(screen, 'darwin');
// The guide's screenshot: shrunk to 1280 wide for the model, pxWidth the display's real pixels (src/screen.js).
const cap = { width: 1280, height: Math.round(982 * 1280 / 1512), pxWidth: 1512 * 2, pxHeight: 982 * 2, display };
const win = { x: 0, y: 25, width: 1512, height: 957 };   // the overlay covers the work area

function landOnMac(raw) {
  const v = validatePoint(parsePointReply(raw), [], { verified: false, image: { width: cap.width, height: cap.height } });
  assert.ok(v.ok && v.reply && v.reply.target, 'the reply is accepted with a target');
  const t = v.reply.target, box = t.box ? { x: t.box[0], y: t.box[1], w: t.box[2], h: t.box[3] } : t;
  const origin = points.dipToScreen({ x: display.bounds.x, y: display.bounds.y });
  return physRectToWindow(physRectFromNorm(box, cap, origin), win, points.screenToDip);
}

test('a pointed box lands where the model put it on a Retina Mac', () => {
  // The control at 50% across, 40% down, 10% x 5% of the screenshot.
  const rect = landOnMac('Click the Wi-Fi switch to turn it on.\n[POINT:0.5,0.4,0.1,0.05]\n[CONF:0.9]');
  // In window points: x = 0.5 x 1512 = 756; y = 0.4 x 982 - 25 (the window starts under the menu bar) = 367.8.
  assert.ok(Math.abs(rect.x - 756) <= 1, 'x ' + rect.x);
  assert.ok(Math.abs(rect.y - 367.8) <= 1, 'y ' + rect.y);
  assert.ok(Math.abs(rect.w - 151.2) <= 1.5 && Math.abs(rect.h - 49.1) <= 1.5, 'size ' + rect.w + ' x ' + rect.h);
});

test('a box in screenshot pixels lands on the same spot', () => {
  const rect = landOnMac('Click the Wi-Fi switch.\n[POINT:' + (0.5 * cap.width) + ',' + (0.4 * cap.height) + ',' + (0.1 * cap.width) + ',' + (0.05 * cap.height) + ']');
  assert.ok(Math.abs(rect.x - 756) <= 1.5 && Math.abs(rect.y - 367.8) <= 1.5, rect.x + ',' + rect.y);
});
