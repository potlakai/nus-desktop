'use strict';
// companion/src/screen-points.js: the Mac stand-in for Electron's Windows-only
// screen.dipToScreenPoint / screenToDipPoint.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createScreenPoints } = require('../src/screen-points');

const retina = { id: 1, bounds: { x: 0, y: 0, width: 1440, height: 900 }, scaleFactor: 2 };
const side = { id: 2, bounds: { x: 1440, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 };
const fakeScreen = (list) => ({ getAllDisplays: () => list,
  getDisplayNearestPoint: (p) => list.find((d) => p.x >= d.bounds.x && p.x < d.bounds.x + d.bounds.width) || list[0] });

test('a Mac maps points to pixels per display, and back', () => {
  const p = createScreenPoints(fakeScreen([retina, side]), 'darwin');
  assert.deepEqual(p.dipToScreen({ x: 100, y: 50 }), { x: 200, y: 100 });
  assert.deepEqual(p.screenToDip({ x: 200, y: 100 }), { x: 100, y: 50 });
  assert.deepEqual(p.dipToScreen({ x: 0, y: 0 }), { x: 0, y: 0 }, 'a display keeps its origin');
  assert.deepEqual(p.dipToScreen({ x: 1500, y: 10 }), { x: 1500, y: 10 }, 'the 1x display is unchanged');
  for (const pt of [{ x: 720, y: 450 }, { x: 1439, y: 899 }]) assert.deepEqual(p.screenToDip(p.dipToScreen(pt)), pt);
});

test('a Mac never calls the Windows-only Electron functions', () => {
  const s = fakeScreen([retina]);
  s.dipToScreenPoint = () => { throw new Error('not on a Mac'); };
  s.screenToDipPoint = () => { throw new Error('not on a Mac'); };
  const p = createScreenPoints(s, 'darwin');
  assert.doesNotThrow(() => p.dipToScreen({ x: 1, y: 1 }));
  assert.doesNotThrow(() => p.screenToDip({ x: 1, y: 1 }));
});

test('Windows uses Electron\'s own conversion', () => {
  const s = { dipToScreenPoint: (pt) => ({ x: pt.x * 3, y: pt.y * 3 }), screenToDipPoint: (pt) => ({ x: pt.x / 3, y: pt.y / 3 }) };
  const p = createScreenPoints(s, 'win32');
  assert.deepEqual(p.dipToScreen({ x: 2, y: 4 }), { x: 6, y: 12 });
  assert.deepEqual(p.screenToDip({ x: 6, y: 12 }), { x: 2, y: 4 });
});

test('no displays at all: points pass through rather than throw', () => {
  const p = createScreenPoints({ getAllDisplays: () => [] }, 'darwin');
  assert.deepEqual(p.dipToScreen({ x: 5, y: 6 }), { x: 5, y: 6 });
});
