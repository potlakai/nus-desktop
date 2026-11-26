// White with its outline at rest (decided 2026-11-02). The engine draws onto a
// recording canvas through the resting states, the gestures that say nothing,
// the thread and the moves, and the only colours it may use there are the ink
// and the white. What a working state adds is in knot-colour.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const dir = path.join(__dirname, '..', 'renderer');
const specSrc = fs.readFileSync(path.join(dir, 'knot-spec.js'), 'utf8');
const engineSrc = fs.readFileSync(path.join(dir, 'knot-engine.js'), 'utf8');
const INK = 'rgb(13,15,25)', WHITE = 'rgb(245,245,247)';

function recorder(seen) {
  const base = {
    createRadialGradient() { seen.gradients++; return { addColorStop() {} }; },
    createLinearGradient() { seen.gradients++; return { addColorStop() {} }; },
    arc() { seen.fills++; }, fill() { seen.fills++; }, fillRect() { seen.fills++; },
  };
  return new Proxy(base, {
    get: (o, k) => (k in o ? o[k] : () => {}),
    set: (o, k, v) => { if (k === 'strokeStyle') seen.colours.add(v); if (k === 'fillStyle') seen.fillColours.add(v); if (k === 'shadowBlur' && v) seen.shadows++; return true; },
  });
}

function fixture() {
  let now = 1000, seq = 0;
  const frames = new Map(), seen = { colours: new Set(), fillColours: new Set(), gradients: 0, fills: 0, shadows: 0 };
  const pos = { x: 1800, y: 980 };
  const body = { width: 0, height: 0, style: {}, classList: { add() {}, remove() {} }, getContext: () => recorder(seen), getBoundingClientRect: () => ({ left: pos.x - 90, top: pos.y - 90, width: 180, height: 180 }) };
  const thread = { width: 0, height: 0, style: {}, dataset: {}, getContext: () => recorder(seen) };
  const window = { innerWidth: 1920, innerHeight: 1080, devicePixelRatio: 1, location: { search: '' }, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), addEventListener() {}, removeEventListener() {} };
  const ctx = { window, performance: { now: () => now }, getComputedStyle: () => ({ getPropertyValue: () => '#7890ff' }), requestAnimationFrame: (fn) => { frames.set(++seq, fn); return seq; }, cancelAnimationFrame: (id) => frames.delete(id), Math, Number, Object, Array, String, Error, TypeError, Float64Array };
  vm.runInNewContext(specSrc, ctx); vm.runInNewContext(engineSrc, ctx);
  const e = window.NusKnotEngine.mount({ body, thread, hooks: { place: (p) => { pos.x = p.x; pos.y = p.y; } } });
  const run = (ms) => { for (let t = 0; t < ms; t += 1000 / 60) { now += 1000 / 60; const batch = [...frames.values()]; frames.clear(); batch.forEach((fn) => fn(now)); } };
  return { e, knot: e.knot, thread: e.thread, seen, run, spec: window.NusKnotSpec };
}

function assertWhite(seen, label) {
  for (const c of seen.colours) assert.ok(c === INK || c === WHITE, label + ': stroke colour ' + c);
  assert.equal(seen.fillColours.size, 0, label + ': nothing is filled, so nothing can shade: ' + [...seen.fillColours].join(' '));
  assert.equal(seen.gradients, 0, label + ': no gradients');
  assert.equal(seen.fills, 0, label + ': no halo, no particles, no glow');
  assert.equal(seen.shadows, 0, label + ': no shadows');
}

test('every resting state is ink and white, and looks the same at any moment', () => {
  for (const s of ['idle', 'ready']) {
    const f = fixture();
    f.knot.setLevel(.8);
    f.knot.setState(s); f.run(1500);
    assertWhite(f.seen, s);
    assert.ok(f.seen.colours.has(INK) && f.seen.colours.has(WHITE), s + ' drew both');
    assert.equal(f.knot.stats().errors, 0);
  }
  const f = fixture(); f.knot.sleep(); f.run(3000); assertWhite(f.seen, 'sleeping');
});

test('every gesture but the two that say something stays ink and white', () => {
  const f = fixture(); f.run(100);
  for (const g of Object.keys(f.spec.gestures)) if (g !== 'sleep' && !f.spec.character.accent.beats[g]) { f.knot.gesture(g, { dx: .5, dy: .5 }); f.run(700); }
  assertWhite(f.seen, 'gestures');
});

test('the thread, the lasso, a held card and the flight are ink and white on any desktop', () => {
  const f = fixture(); f.run(100);
  f.knot.setBackdrop(1); f.run(800);
  f.thread.setTarget({ x: 400, y: 300, w: 80, h: 30 }, { task: 'guide' }); f.run(1500); f.thread.rewind(); f.run(900);
  f.thread.reachTo({ x: 1700, y: 900 }); f.run(900); f.thread.burst({ x: 1700, y: 900 }); f.thread.setHeld(true); f.run(400); f.thread.setHeld(false); f.thread.releaseSurface(); f.run(800);
  f.knot.travelTo({ x: 500, y: 400 }, { lasso: { x: 600, y: 350, w: 90, h: 30 } }); f.run(2000);
  f.knot.travelTo({ x: 1500, y: 800 }); f.run(1500);
  assertWhite(f.seen, 'strand');
  assert.equal(f.knot.stats().errors, 0);
});

test('the source keeps no shading, no orb and no particles, and one blur for the glow', () => {
  assert.doesNotMatch(engineSrc, /createRadialGradient|createLinearGradient|shadowBlur|globalCompositeOperation/, 'no gradient or shadow machinery in the engine');
  assert.equal((engineSrc.match(/\.filter = 'blur\(/g) || []).length, 1, 'one blur: the glow in the strand\'s own shape');
});
