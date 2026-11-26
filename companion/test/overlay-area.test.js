'use strict';
// An auto-hidden taskbar must still come up at the bottom edge with the overlay on.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { overlayArea } = require('../src/overlay-area');

const box = (x, y, width, height) => ({ x, y, width, height });

test('a work area that is the whole display leaves the bottom row uncovered', () => {
  assert.deepEqual(overlayArea({ bounds: box(0, 0, 1920, 1080), workArea: box(0, 0, 1920, 1080) }), box(0, 0, 1920, 1079));
  assert.deepEqual(overlayArea({ bounds: box(-1920, 200, 1920, 1080), workArea: box(-1920, 200, 1920, 1080) }), box(-1920, 200, 1920, 1079), 'a second display, off the origin');
});

test('a visible taskbar: the work area, as ever', () => {
  const bottom = { bounds: box(0, 0, 1920, 1080), workArea: box(0, 0, 1920, 1032) };
  assert.equal(overlayArea(bottom), bottom.workArea);
  assert.deepEqual(overlayArea({ bounds: box(0, 0, 1920, 1080), workArea: box(0, 48, 1920, 1032) }), box(0, 48, 1920, 1032), 'on top');
  assert.deepEqual(overlayArea({ bounds: box(0, 0, 1920, 1080), workArea: box(48, 0, 1872, 1080) }), box(48, 0, 1872, 1080), 'on the left');
});

test('the display is not changed, and the window uses this rectangle', () => {
  const display = { bounds: box(0, 0, 1920, 1080), workArea: box(0, 0, 1920, 1080) };
  overlayArea(display);
  assert.equal(display.workArea.height, 1080);
  const main = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const fn = main.slice(main.indexOf('function overlayBounds()'), main.indexOf('// Where the Knot sits on the current display'));
  assert.match(fn, /return process\.platform === 'win32' \? overlayArea\(display\) : display\.workArea;/);
});
