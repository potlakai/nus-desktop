// The Knot's numbers are copied from the approved motion playground, not
// retyped from memory. This test pulls the executable SPEC out of the frozen
// playground and compares every table with the app's config module.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..', '..');
const playground = fs.readFileSync(path.join(root, 'docs', 'knot-playground.html'), 'utf8');
const spec = require('../renderer/knot-spec.js');

function playgroundSpec() {
  const from = playground.indexOf("const PARAMS=");
  const to = playground.indexOf('// Invert Bezier x');
  assert.ok(from > 0 && to > from, 'the playground still has its SPEC block');
  const src = playground.slice(from, to) + '\n;__out.SPEC = SPEC; __out.PARAMS = PARAMS;';
  const out = {};
  vm.runInNewContext(src, { __out: out, Object });
  return JSON.parse(JSON.stringify(out));
}

test('every SPEC table equals the playground, number for number', () => {
  const p = playgroundSpec();
  assert.deepEqual(JSON.parse(JSON.stringify(spec.PARAMS)), p.PARAMS);
  for (const key of Object.keys(p.SPEC)) {
    assert.deepEqual(JSON.parse(JSON.stringify(spec.SPEC[key])), p.SPEC[key], 'SPEC.' + key);
    assert.deepEqual(JSON.parse(JSON.stringify(spec[key])), p.SPEC[key], 'top-level alias ' + key);
  }
  assert.deepEqual(Object.keys(spec.SPEC).sort(), Object.keys(p.SPEC).sort(), 'no table added or dropped');
});

test('the vocabulary is complete: nine states, ten gestures, eight pose parameters', () => {
  assert.deepEqual(Object.keys(spec.states), ['idle', 'ready', 'listening', 'working', 'reading', 'thinking', 'speaking', 'error', 'sleeping']);
  assert.deepEqual(Object.keys(spec.gestures), ['acknowledge', 'done', 'error', 'poke', 'nudge', 'wake', 'sleep', 'arrive', 'gulp', 'settle']);
  assert.deepEqual(spec.PARAMS, ['scale', 'squash', 'leanX', 'leanY', 'unravel', 'straighten', 'tempo', 'bright']);
  for (const k of spec.PARAMS) { assert.ok(spec.springs[k], 'spring for ' + k); assert.ok(spec.ranges[k], 'range for ' + k); }
  for (const s of Object.keys(spec.states)) assert.ok(spec.loops[s], 'breathing loop for ' + s);
});

test('listening is red, error has its own accent, and every gesture returns to rest', () => {
  assert.equal(spec.states.listening.accent, '#EF5350');
  assert.equal(spec.states.error.accent, '#E06A5A');
  assert.equal(spec.inline.errorAccent, '#E06A5A');
  for (const [name, g] of Object.entries(spec.gestures)) {
    assert.deepEqual(g.keys[g.keys.length - 1], [1, {}], name + ' ends at zero');
    assert.equal(g.keys[0][0], 0, name + ' starts at time zero');
  }
  assert.ok(spec.gestures.acknowledge.linearFirst, 'acknowledge moves on its first frame');
  assert.ok(spec.gestures.acknowledge.keys[1][0] * spec.gestures.acknowledge.duration < 0.1, 'first acknowledge key lands inside 100 ms');
});

test('the inline literals the playground kept in its code are named here', () => {
  const src = playground;
  // Spot checks against the playground source, so a silent drift is caught.
  assert.match(src, /linearRampToValueAtTime\(\.30,/); assert.equal(spec.inline.sound.peak, .30);
  assert.match(src, /dir\.x\*\.18;p\.leanY=dir\.y\*\.18/); assert.equal(spec.inline.lean.reading, .18);
  assert.match(src, /dir\.x\*\.14;p\.leanY=dir\.y\*\.14/); assert.equal(spec.inline.lean.pointing, .14);
  assert.match(src, /drag\.vx\/1400,-\.22,\.22/); assert.deepEqual(spec.inline.lean.drag, { perSpeed: 1400, max: .22 });
  assert.match(src, /p\.scale\+=\.035;p\.squash\+=\.09;p\.leanX=dir\.x\*\.15/); assert.deepEqual(spec.inline.fileHover, { scale: .035, squash: .09 });
  assert.match(src, /Math\.sin\(clock\*8\.2\)\*Math\.sin\(clock\*3\.1\)\)\*\.7/); assert.equal(spec.inline.speaking.gain, .7);
  assert.match(src, /\(u-\.5\)\*90,wave=Math\.sin\(u\*TAU\*1\.2-clock\*2\)\*10/); assert.equal(spec.inline.ribbon.length, 90);
  assert.match(src, /stroke\(ctx,points,7,'rgb\(13,15,25\)'\);stroke\(ctx,points,5,/); assert.deepEqual(spec.inline.thread.strokes, [7, 5, 2, .65]);
  assert.match(src, /Math\.min\(100,length\(d\)\*\.25\)/); assert.equal(spec.inline.thread.bow.max, 100);
  assert.match(src, /w\*1\.72,'rgb\(13,15,25\)'/); assert.equal(spec.inline.draw.widths.body, 1.72);
});

test('host numbers the app relies on are present and sane', () => {
  assert.equal(spec.host.sleepAfterMs, 90000);
  assert.equal(spec.host.pointerLoopMs, 30000);
  assert.equal(spec.host.clampMargin, 40);
  assert.ok(spec.host.springSnap.x > 0 && spec.host.springSnap.x < 1e-2, 'springs snap to rest instead of decaying forever');
  assert.equal(typeof spec.host.speedFirst, 'boolean');
  assert.ok(spec.host.skater.minDistance > 0);
});

test('the helpers behave', () => {
  assert.equal(spec.smooth(0), 0); assert.equal(spec.smooth(1), 1); assert.equal(spec.smooth(.5), .5);
  assert.ok(Math.abs(spec.bezierEase(0, spec.ease.unwind)) < 1e-3);
  assert.ok(Math.abs(spec.bezierEase(1, spec.ease.unwind) - 1) < 1e-3);
  assert.ok(Math.abs(spec.cruiseEase(.5) - .5) < 1e-9);
  assert.ok(Math.abs(spec.midiHz(69) - 440) < 1e-9);
});
