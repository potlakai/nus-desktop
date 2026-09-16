const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture(reduced = false) {
  let now = 1000, sequence = 0; const frames = new Map(); const callbacks = [];
  const context = new Proxy({}, { get: (o, key) => o[key] || (() => {}), set: (o, key, value) => { o[key] = value; return true; } });
  const canvas = { width: 1920, height: 1080, dataset: {}, getContext: () => context };
  const bright = [];
  const material = { parseColor: () => [120, 144, 255], lightSide: () => 1, sprites: () => ({}), drawTube() {}, drawBright(ctx, run) { bright.push(run.length); }, drawLight() {} };
  const window = { innerWidth: 1920, innerHeight: 1080, devicePixelRatio: 1, location: { search: '' }, NusKnot3D: { material }, matchMedia: () => ({ matches: reduced }), addEventListener() {}, removeEventListener() {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../renderer/strand.js'), 'utf8'), { window, performance: { now: () => now }, getComputedStyle: () => ({ getPropertyValue: () => '#7890ff' }), requestAnimationFrame: (fn) => { frames.set(++sequence, fn); return sequence; }, cancelAnimationFrame: (id) => frames.delete(id) });
  const knot = { getTailAnchor: (u) => ({ x: 1780 + (u || 0) * 30, y: 950, r: 4 }), setUnravel() {} };
  const strand = window.NusStrand.mount(canvas, knot, { onArrive: () => callbacks.push('arrive'), onRewound: () => callbacks.push('rewound') });
  return { strand, frames, callbacks, bright, tick(ms) { now += ms; const batch = [...frames.values()]; frames.clear(); batch.forEach((fn) => fn(now)); } };
}
test('reduced motion arrives and rewinds exactly once without a running frame loop', () => {
  const f = fixture(true); f.strand.setTarget({ x: 100, y: 100, w: 50, h: 30 });
  assert.equal(f.strand.getState(), 'pointing'); assert.deepEqual(f.callbacks, ['arrive']);
  f.strand.rewind(); assert.equal(f.strand.getState(), 'idle');
  assert.deepEqual(f.callbacks, ['arrive', 'rewound']); assert.equal(f.frames.size, 0);
});
test('long journeys are capped; a settled pointer keeps breathing, then holds still after 30s', () => {
  const f = fixture(); f.strand.setTarget({ x: 20, y: 20, w: 50, h: 30 });
  f.tick(800); assert.equal(f.strand.getState(), 'pointing');
  assert.equal(f.frames.size, 1, 'the ring and strand keep breathing while pointing');
  for (let i = 0; i < 62; i++) f.tick(500);
  assert.equal(f.frames.size, 0, 'after POINTING_LOOP_MS the pointer holds a still frame');
  f.strand.rewind(); f.tick(600); assert.equal(f.strand.getState(), 'idle');
  assert.deepEqual(f.callbacks, ['arrive', 'rewound']);
});
test('while pointing, a light leaves the Knot every period and runs to the tip', () => {
  const f = fixture(); f.strand.setTarget({ x: 20, y: 20, w: 50, h: 30 });
  f.tick(800); assert.equal(f.strand.getState(), 'pointing');
  f.bright.length = 0;
  f.tick(100); assert.equal(f.bright.length, 0, 'no travelling light straight after arrival; the tip light marks it');
  f.tick(2600); f.tick(50); assert.ok(f.bright.length >= 1, 'first light left after one period');
  f.bright.length = 0;
  f.tick(1000); assert.ok(f.bright.length >= 1, 'the light is still travelling a second later');
  // Retargeting while out restarts the breathing clock and clears lights.
  for (let i = 0; i < 62; i++) f.tick(500);
  assert.equal(f.frames.size, 0);
  f.strand.setTarget({ x: 400, y: 300, w: 60, h: 30 });
  assert.equal(f.frames.size, 1, 'retarget restarts the loop');
  f.strand.rewind(); f.tick(600); assert.equal(f.strand.getState(), 'idle'); assert.equal(f.frames.size, 0);
});
test('dismissal during outward motion cannot later announce arrival', () => {
  const f = fixture(); f.strand.setTarget({ x: 100, y: 100, w: 50, h: 30 });
  f.tick(100); f.strand.rewind(); f.tick(600); f.tick(1000);
  assert.deepEqual(f.callbacks, ['rewound']); assert.equal(f.frames.size, 0);
});
