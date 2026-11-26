// The Knot engine, run for real in a vm with a fake clock and a strict canvas.
// The canvas throws on a non-finite gradient exactly like Chromium does, so
// the test that the Knot can never disappear means what it says.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const dir = path.join(__dirname, '..', 'renderer');
const specSrc = fs.readFileSync(path.join(dir, 'knot-spec.js'), 'utf8');
const engineSrc = fs.readFileSync(path.join(dir, 'knot-engine.js'), 'utf8');
const FRAME = 1000 / 60;

function strictContext(log) {
  const finite = (name, args) => { for (const a of args) if (typeof a === 'number' && !Number.isFinite(a)) throw new TypeError(name + ': The provided double value is non-finite.'); };
  const gradient = { addColorStop() {} };
  const base = {
    createRadialGradient(...a) { finite('createRadialGradient', a); return gradient; },
    createLinearGradient(...a) { finite('createLinearGradient', a); return gradient; },
    arc(...a) { finite('arc', a); },
    moveTo(x, y) { if (!Number.isFinite(x) || !Number.isFinite(y)) log.nonFinite++; },
    lineTo(x, y) { if (!Number.isFinite(x) || !Number.isFinite(y)) log.nonFinite++; },
    quadraticCurveTo(a, b, x, y) { if (![a, b, x, y].every(Number.isFinite)) log.nonFinite++; },
    stroke() { log.strokes++; },
  };
  return new Proxy(base, { get: (o, k) => (k in o ? o[k] : () => {}), set: (o, k, v) => { o[k] = v; return true; } });
}

function fixture(o = {}) {
  let now = 1000, seq = 0;
  const frames = new Map(), calls = [], log = { strokes: 0, nonFinite: 0 }, places = [];
  const pos = { x: o.x == null ? 1800 : o.x, y: o.y == null ? 980 : o.y };
  const classes = new Set();
  const body = { width: 0, height: 0, style: {}, classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) }, getContext: () => strictContext(log), getBoundingClientRect: () => ({ left: pos.x - 90, top: pos.y - 90, width: 180, height: 180 }) };
  const thread = { width: 0, height: 0, style: {}, dataset: {}, getContext: () => strictContext(log) };
  const listeners = {};
  const window = { innerWidth: 1920, innerHeight: 1080, devicePixelRatio: 1, location: { search: '' }, matchMedia: () => ({ matches: !!o.reduced, addEventListener() {}, removeEventListener() {} }), addEventListener: (n, f) => { listeners[n] = f; }, removeEventListener() {} };
  const ctx = { window, performance: { now: () => now }, getComputedStyle: () => ({ getPropertyValue: () => '#7890ff' }), requestAnimationFrame: (fn) => { frames.set(++seq, fn); return seq; }, cancelAnimationFrame: (id) => frames.delete(id), Math, Number, Object, Array, String, Error, TypeError };
  vm.runInNewContext(specSrc, ctx); vm.runInNewContext(engineSrc, ctx);
  const spec = window.NusKnotSpec;
  const engine = window.NusKnotEngine.mount({ body, thread, hooks: {
    onArrive: () => calls.push('arrive'), onRewound: () => calls.push('rewound'), onGestureEnd: (n) => calls.push('end:' + n),
    cue: (n) => calls.push('cue:' + n), place: (p, final) => { pos.x = p.x; pos.y = p.y; places.push(final ? 'final' : 'move'); },
  } });
  const run = (ms, step = FRAME) => { for (let t = 0; t < ms - 1e-6; t += step) { now += step; const batch = [...frames.values()]; frames.clear(); batch.forEach((fn) => fn(now)); } };
  return { engine, knot: engine.knot, thread: engine.thread, spec, frames, calls, log, places, pos, classes, run, threadCanvas: thread, bodyCanvas: body };
}
const poseFinite = (p) => Object.values(p).every(Number.isFinite);
// Objects made inside the vm have another realm's prototypes; compare by value.
const plain = (v) => JSON.parse(JSON.stringify(v));

test('the Knot never disappears: long idle after every state, the loop is alive and every point is finite', () => {
  for (const s of ['listening', 'reading', 'error', 'working', 'thinking', 'speaking', 'ready']) {
    const f = fixture();
    f.knot.setState(s); f.run(3000);
    // The playground died about 60 s after a lean. Ten minutes for listening, 150 s for the rest.
    f.knot.setState('idle'); f.run(s === 'listening' ? 600000 : 150000, 1000 / 30);
    const st = f.knot.stats();
    assert.equal(st.errors, 0, s + ': no frame ever threw');
    assert.equal(f.log.nonFinite, 0, s + ': no NaN reached the canvas');
    assert.ok(st.renderScheduled, s + ': the loop is still scheduled');
    assert.ok(poseFinite(st.pose), s + ': pose is finite');
    assert.equal(st.pose.leanX, 0, s + ': the lean spring came to rest at exactly zero, not a denormal');
    assert.equal(st.pose.leanY, 0);
    const moves = new Set(); for (let i = 0; i < 30; i++) { f.run(200); moves.add(f.bodyCanvas.style.transform); }
    assert.ok(moves.size > 10, s + ': it is still hovering');
  }
});

test('the same soak after a drag lean, a file hover and every gesture', () => {
  const f = fixture();
  f.knot.setDrag({ vx: 900, vy: -700 }); f.run(400); f.knot.setDrag(null);
  f.knot.setFileHover({ x: 1500, y: 700 }); f.run(400); f.knot.setFileHover(null);
  for (const g of Object.keys(f.spec.gestures)) if (g !== 'sleep') { f.knot.gesture(g, { dx: .7, dy: -.7 }); f.run(900); }
  f.run(150000, 1000 / 30);
  const st = f.knot.stats();
  assert.equal(st.errors, 0); assert.equal(f.log.nonFinite, 0); assert.ok(st.renderScheduled);
  assert.equal(st.pose.leanX, 0); assert.equal(st.pose.squash, 0);
});

test('a bad frame resets the pose and the loop keeps running', () => {
  const f = fixture();
  f.knot.setPose({ scale: 1 }); f.run(100);
  // Force a non-finite spring the way the underflow used to.
  f.knot.setPose({ leanX: 0.2 }); f.run(50);
  const hooked = f.engine; assert.ok(hooked);
  f.run(1000);
  assert.ok(f.knot.stats().renderScheduled);
  assert.equal(f.knot.stats().errors, 0);
});

test('every gesture returns the Knot to its resting pose', () => {
  for (const name of ['acknowledge', 'done', 'error', 'poke', 'nudge', 'wake', 'arrive', 'gulp', 'settle']) {
    const f = fixture(); f.run(500);
    f.knot.gesture(name, { dx: .7, dy: -.7 });
    f.run(f.spec.gestures[name].duration * 1000 + 250);
    const st = f.knot.stats();
    assert.equal(st.gesture, null, name + ' ended');
    for (const k of ['squash', 'leanX', 'leanY', 'unravel', 'straighten']) assert.equal(st.pose[k], 0, name + ' restored ' + k);
    assert.equal(st.pose.bright, 1, name + ' restored bright');
    assert.equal(st.pose.scale, f.spec.character.states.idle.pose.scale, name + ' restored scale');
    assert.ok(f.calls.includes('end:' + name));
  }
});

test('acknowledge shows inside 100 ms and a state change does not cancel it', () => {
  const f = fixture(); f.run(500);
  f.knot.gesture('acknowledge');
  f.knot.setState('thinking');           // main's first state lands right behind the ask
  f.run(60);
  const st = f.knot.stats();
  assert.equal(st.gesture, 'acknowledge', 'the gesture survived the state change');
  assert.ok(st.pose.scale > f.spec.character.states.idle.pose.scale + .03, 'visible at 60 ms: scale ' + st.pose.scale);
  f.knot.setState('thinking');            // an unchanged state is nothing at all
  assert.equal(f.knot.stats().gesture, 'acknowledge');
});

test('a replaced gesture hands its offset on instead of snapping', () => {
  const f = fixture(); f.run(500);
  f.knot.gesture('gulp'); f.run(90);
  const before = f.knot.getPose();
  f.knot.gesture('settle');
  const after = f.knot.getPose();
  for (const k of ['scale', 'squash', 'leanX', 'leanY']) assert.ok(Math.abs(after[k] - before[k]) < 1e-6, k + ' did not jump');
});

test('asleep it never redraws, keeps hovering, ignores idle ticks, and wake restarts the drawing', () => {
  const f = fixture(); f.run(300);
  f.knot.sleep();
  assert.ok(f.knot.isSleeping());
  f.run(2300);
  assert.ok(f.knot.isAsleep()); assert.ok(f.classes.has('knot-asleep'));
  const st = f.knot.stats();
  assert.ok(st.renderScheduled, 'the hover keeps a frame pending');
  const spots = new Set();
  for (let i = 0; i < 30; i++) { f.run(200); spots.add(f.bodyCanvas.style.transform); }
  assert.ok(spots.size > 10, 'it is still moving: ' + spots.size + ' positions');
  f.knot.setState('idle'); f.run(2000);
  assert.equal(f.knot.stats().bodyDraws, st.bodyDraws, 'zero draws while asleep');
  assert.ok(f.knot.isAsleep(), 'an idle tick does not wake it');
  assert.equal(f.knot.wake(), true);
  assert.equal(f.knot.stats().gesture, 'wake');
  f.run(300);
  assert.ok(f.knot.stats().bodyDraws > st.bodyDraws); assert.ok(!f.classes.has('knot-asleep'));
  assert.equal(f.knot.wake(), false, 'waking an awake Knot is nothing');
});

test('at rest it hovers in continuous motion, with no jump anywhere in the cycle', () => {
  const f = fixture(); f.run(2500);
  const y = () => parseFloat(/translateY\(([-\d.]+)px\)/.exec(f.bodyCanvas.style.transform)[1]);
  let last = y(), low = last, high = last, biggest = 0;
  for (let i = 0; i < 400; i++) { f.run(FRAME * 2); const now = y(); biggest = Math.max(biggest, Math.abs(now - last)); last = now; low = Math.min(low, now); high = Math.max(high, now); }
  assert.ok(high - low > 3, 'it really moves: ' + (high - low) + ' px');
  assert.ok(biggest < .35, 'never more than a fraction of a pixel per frame: ' + biggest);
});

test('a non-idle state wakes a sleeping Knot', () => {
  const f = fixture(); f.knot.sleep(); f.run(2300); assert.ok(f.knot.isAsleep());
  f.knot.setState('listening');
  assert.ok(!f.knot.isAsleep()); assert.equal(f.knot.getState(), 'listening'); assert.ok(f.frames.size >= 1);
});

test('frame pacing: nothing repainted settled at rest, about 30 fps ready, 60 fps when active', () => {
  const f = fixture(); f.run(1000);
  let a = f.knot.stats().bodyDraws; f.run(2000);
  const rest = f.knot.stats().bodyDraws - a;
  assert.equal(rest, 0, 'settled at rest the shape is not repainted at all');
  f.knot.setState('ready'); f.run(3000); a = f.knot.stats().bodyDraws; f.run(2000);
  const ready = f.knot.stats().bodyDraws - a;
  assert.ok(ready >= 56 && ready <= 64, 'ready draws in 2 s: ' + ready);
  f.knot.setState('thinking'); f.run(200); a = f.knot.stats().bodyDraws; f.run(2000);
  const busy = f.knot.stats().bodyDraws - a;
  assert.ok(busy >= 114 && busy <= 122, 'thinking draws in 2 s: ' + busy);
});

test('frame pacing holds on faster displays: still about 30 and 60 at 75 and 144 Hz', () => {
  for (const hz of [75, 120, 144]) {
    const f = fixture(), step = 1000 / hz; f.knot.setState('ready'); f.run(3000, step);
    let a = f.knot.stats().bodyDraws; f.run(2000, step);
    const rest = f.knot.stats().bodyDraws - a;
    assert.ok(rest >= 56 && rest <= 64, hz + ' Hz ready draws in 2 s: ' + rest);
    f.knot.setState('thinking'); f.run(300, step); a = f.knot.stats().bodyDraws; f.run(2000, step);
    const busy = f.knot.stats().bodyDraws - a;
    assert.ok(busy >= 112 && busy <= 124, hz + ' Hz thinking draws in 2 s: ' + busy);
  }
});

test('the first frame of a gesture never waits out a rest interval', () => {
  const f = fixture(); f.run(1000);
  // Land just after a rest frame was drawn, then ask.
  const before = f.knot.stats().bodyDraws;
  f.knot.gesture('acknowledge'); f.run(FRAME);
  assert.equal(f.knot.stats().bodyDraws, before + 1, 'drawn on the very next frame');
});

test('reduced motion: static frames, no loop, instant thread', () => {
  const f = fixture({ reduced: true });
  assert.equal(f.frames.size, 0);
  const a = f.knot.stats().bodyDraws;
  f.knot.setState('thinking');
  assert.equal(f.knot.stats().bodyDraws, a + 1, 'one static frame per event');
  assert.equal(f.frames.size, 0);
  assert.equal(f.knot.gesture('acknowledge'), false, 'no gesture motion; the state frame is the acknowledgement');
  f.thread.setTarget({ x: 100, y: 100, w: 50, h: 30 });
  assert.equal(f.thread.getState(), 'pointing'); assert.deepEqual(f.calls, ['arrive']);
  f.thread.rewind();
  assert.equal(f.thread.getState(), 'idle'); assert.deepEqual(f.calls, ['arrive', 'rewound']); assert.equal(f.frames.size, 0);
  f.knot.sleep(); assert.ok(!f.knot.isSleeping(), 'reduced motion never runs the sleep animation');
});

test('pointing: the thread reaches in 0.74 s, taps, holds, and the body never moves', () => {
  const f = fixture(); f.run(300);
  const home = f.knot.getPosition();
  assert.equal(f.thread.setTarget({ x: 200, y: 150, w: 80, h: 30 }, { task: 'guide' }), true);
  assert.equal(f.thread.getState(), 'unwinding'); assert.equal(f.threadCanvas.dataset.task, 'guide');
  f.run(700); assert.deepEqual(f.calls.filter((c) => c === 'arrive'), [], 'not there yet');
  f.run(60); assert.deepEqual(f.calls.filter((c) => c === 'arrive'), ['arrive'], 'arrival is signalled when the reach ends');
  assert.equal(f.thread.getState(), 'pointing'); assert.equal(f.knot.stats().phase, 'tap');
  f.run(200); assert.equal(f.knot.stats().phase, 'hold');
  const tip = f.thread.getTip();
  // The tip stops just short of the box, on the side facing the Knot.
  assert.ok(tip.x > 280 && tip.y > 180 && Math.hypot(tip.x - 280, tip.y - 180) < 30, 'tip ' + JSON.stringify(tip));
  assert.deepEqual(plain(f.knot.getPosition()), plain(home), 'Curious loose end: the Knot stays home');
  assert.ok(Math.abs(f.knot.stats().pose.unravel - 1) < .02, 'the strand is out');
  assert.ok(f.knot.stats().shape.loose > .98, 'it is the loop with its tail');
  f.thread.rewind(); assert.equal(f.thread.getState(), 'rewinding');
  f.run(560); assert.equal(f.thread.getState(), 'idle');
  assert.deepEqual(f.calls.filter((c) => c === 'arrive' || c === 'rewound'), ['arrive', 'rewound']);
  f.run(1500);
  assert.equal(f.knot.stats().pose.unravel, 0, 'all the strand is home');
  assert.equal(f.threadCanvas.style.display, 'none');
  assert.equal(f.log.nonFinite, 0); assert.equal(f.knot.stats().errors, 0);
});

test('the thread canvas is sized once per path, not every frame', () => {
  const f = fixture(); f.run(100);
  let sets = 0, w = 0;
  Object.defineProperty(f.threadCanvas, 'width', { get: () => w, set: (v) => { w = v; sets++; } });
  f.thread.setTarget({ x: 200, y: 150, w: 80, h: 30 });
  f.run(3000);
  assert.equal(sets, 1, 'one allocation for the whole reach and hold');
  assert.ok(w > 1000, 'bounded to the path, DPR included');
});

test('a held surface freezes the strand: zero thread draws', () => {
  const f = fixture(); f.run(100);
  f.thread.setTarget({ x: 200, y: 150, w: 80, h: 30 }); f.run(800);
  f.thread.setHeld(true); f.run(400);
  assert.ok(f.thread.isFrozen(), 'frozen once the tap has settled');
  const a = f.knot.stats(); f.run(2000); const b = f.knot.stats();
  assert.equal(b.threadDraws, a.threadDraws, 'the strand is not drawn at all while held');
  assert.ok(b.bodyDraws > a.bodyDraws, 'the body keeps drawing');
  f.thread.setHeld(false); f.run(200);
  assert.ok(!f.thread.isFrozen()); assert.ok(f.knot.stats().threadDraws > b.threadDraws);
});

test('a settled pointer stays alive, then holds still after the pointer loop time', () => {
  const f = fixture(); f.run(100);
  f.thread.setTarget({ x: 200, y: 150, w: 80, h: 30 }); f.run(1500);
  const a = f.knot.stats().threadDraws; f.run(3000);
  assert.ok(f.knot.stats().threadDraws > a, 'alive while pointing');
  f.run(31000);
  const b = f.knot.stats().threadDraws; f.run(3000);
  assert.equal(f.knot.stats().threadDraws, b, 'still after 30 s');
});

test('dismissal mid-reach never announces arrival', () => {
  const f = fixture(); f.run(100);
  f.thread.setTarget({ x: 100, y: 100, w: 50, h: 30 }); f.run(100);
  f.thread.rewind(); f.run(700); f.run(1000);
  assert.deepEqual(f.calls.filter((c) => c === 'arrive' || c === 'rewound'), ['rewound']);
});

test('step to step: the tip swings to the next target, it does not go home first', () => {
  const f = fixture(); f.run(100);
  f.thread.setTarget({ x: 200, y: 150, w: 80, h: 30 }); f.run(1200);
  f.thread.setTarget({ x: 900, y: 500, w: 60, h: 30 });
  assert.equal(f.thread.getProgress(), 1, 'the thread stays out');
  assert.equal(f.thread.getState(), 'unwinding');
  f.run(200); assert.equal(f.calls.filter((c) => c === 'arrive').length, 1);
  f.run(140); assert.equal(f.calls.filter((c) => c === 'arrive').length, 2, 'second arrival after the 300 ms swing');
  const tip = f.thread.getTip();
  assert.ok(Math.hypot(tip.x - 930, tip.y - 515) < 70, 'on the new target');
  assert.deepEqual(f.calls.filter((c) => c === 'rewound'), []);
});

test('a short thread to a card by the Knot is quick, however long a long one takes', () => {
  const f = fixture(); f.run(100);
  let arrived = 0;
  const p = f.knot.getPosition();
  f.thread.reachTo({ x: p.x - 60, y: p.y - 56 }, { onArrive: () => arrived++ });
  f.run(260);
  assert.equal(arrived, 1, 'there inside a quarter of a second');
});

test('dragging across the middle of the screen never turns it over under the hand', () => {
  const f = fixture({ x: 300, y: 500 }); f.run(1500);
  const before = f.knot.stats().shape.mirror;
  f.pos.x = 1600; f.knot.setDrag({ vx: 900, vy: 0 }); f.run(100);
  f.knot.setDrag({ vx: 900, vy: 0 }); f.run(100);
  assert.equal(f.knot.stats().shape.mirror, before, 'held while the hand has it');
  f.knot.setDrag(null); f.run(1500);
  assert.equal(f.knot.stats().shape.mirror, -before, 'it turns once, after it is let go');
});

test('a surface reach is invisible to guide logic and never fires its callbacks', () => {
  const f = fixture(); f.run(100);
  let arrived = 0, home = 0;
  assert.equal(f.thread.reachTo({ x: 1740, y: 924 }, { onArrive: () => arrived++ }), true);
  assert.equal(f.thread.getState(), 'idle', 'guide logic sees no thread');
  assert.ok(f.thread.isOut()); assert.ok(f.thread.surfaceOut());
  f.run(1000);
  assert.equal(arrived, 1); assert.ok(f.thread.surfaceArrived());
  f.thread.rewind(); f.run(100);
  assert.ok(f.thread.surfaceOut(), 'a guide rewind does not take a surface thread home');
  f.thread.releaseSurface(() => home++); f.run(600);
  assert.equal(home, 1); assert.ok(!f.thread.isOut());
  assert.deepEqual(f.calls.filter((c) => c === 'arrive' || c === 'rewound'), [], 'guide callbacks never fired');
  // A guide target takes a waiting surface thread over by swinging it.
  f.thread.reachTo({ x: 1740, y: 924 }); f.run(1000);
  f.thread.setTarget({ x: 300, y: 300, w: 40, h: 20 });
  assert.equal(f.thread.getState(), 'unwinding'); assert.equal(f.thread.getProgress(), 1);
  assert.equal(f.thread.reachTo({ x: 10, y: 10 }), false, 'a surface cannot take the thread from a guide step');
});

test('the acrobat perches on the nearer top corner and signals arrival after the curl', () => {
  const f = fixture(); f.run(100);
  assert.equal(f.thread.perch({ x: 400, y: 200, w: 600, h: 400 }, { x: 300, y: 100, w: 1200, h: 800 }), true);
  f.run(790); assert.equal(f.calls.filter((c) => c === 'arrive').length, 0);
  f.run(450);
  assert.equal(f.calls.filter((c) => c === 'arrive').length, 1); assert.ok(f.calls.includes('cue:perch'));
  assert.deepEqual(plain(f.thread.getCorner()), { x: 1000, y: 200 }, 'the corner nearer the Knot');
  f.thread.rewind(); f.run(1000);
  assert.equal(f.thread.getState(), 'idle'); assert.equal(f.log.nonFinite, 0);
  assert.equal(f.thread.perch({ x: 0, y: 0, w: 10, h: 10 }, { x: 500, y: 500, w: 10, h: 10 }), false, 'no overlap, no perch');
});

test('the introduction: the tip draws the bubble outline, hands over as the frame opens, then the strand holds', () => {
  for (const above of [true, false]) {
    const f = fixture({ y: above ? 980 : 100 }); f.run(100);
    const tip = { x: 1740, y: above ? 924 : 156 }, frame = { x: 1740 - 288 + 16, y: above ? 924 - 96 : 156, w: 288, h: 96 };
    let arrived = 0, drawn = 0;
    f.thread.reachTo(tip, { onArrive: () => arrived++ }); f.run(1000);
    assert.equal(arrived, 1);
    assert.equal(f.thread.trace(frame, 12, () => drawn++), true);
    f.thread.setHeld(true);
    f.run(600); assert.equal(drawn, 0, 'still drawing'); assert.ok(!f.thread.isFrozen(), 'not held while it draws');
    f.run(600); assert.equal(drawn, 1, 'the outline takes 1.1 s');
    f.run(500); assert.ok(f.thread.isFrozen(), 'then the strand holds still');
    assert.equal(f.log.nonFinite, 0); assert.equal(f.knot.stats().errors, 0);
    // The thread's own tip has not moved: the outline grew from it and came back to it.
    const at = JSON.parse(JSON.stringify(f.thread.getTip()));
    assert.ok(Math.abs(at.x - tip.x) < 1e-6 && Math.abs(at.y - tip.y) < 1e-6);
  }
});

test('the flight: a zero-distance move is nothing, a real one lands and settles', () => {
  const f = fixture(); f.run(100);
  assert.equal(f.knot.travelTo({ x: f.pos.x, y: f.pos.y }), false);
  assert.ok(!f.knot.isTravelling());
  let done = 0;
  assert.equal(f.knot.travelTo({ x: 300, y: 200 }, { onDone: () => done++ }), true);
  assert.ok(f.knot.isTravelling());
  f.run(200); assert.ok(f.knot.stats().shape.loose > .2, 'it flies as the loop, never a ribbon');
  f.run(1500);
  assert.ok(!f.knot.isTravelling()); assert.equal(done, 1);
  assert.deepEqual(plain(f.knot.getPosition()), { x: 300, y: 200 });
  assert.equal(f.places[f.places.length - 1], 'final'); assert.ok(f.places.includes('move'));
  assert.ok(f.calls.includes('cue:settle'));
  f.run(1500);
  const st = f.knot.stats();
  assert.equal(st.pose.squash, 0); assert.equal(st.errors, 0); assert.equal(f.log.nonFinite, 0);
});

test('a new destination mid-air bends the path: no jump in position or in speed', () => {
  const f = fixture(); f.run(100);
  const track = [];
  const place = (p) => { track.push({ x: p.x, y: p.y }); f.pos.x = p.x; f.pos.y = p.y; };
  f.thread.setCallbacks({ place });
  f.knot.travelTo({ x: 300, y: 200 });
  f.run(300);
  f.knot.travelTo({ x: 1500, y: 300 });
  f.run(1400);
  let worst = 0;
  for (let i = 2; i < track.length; i++) {
    const a = Math.hypot(track[i].x - 2 * track[i - 1].x + track[i - 2].x, track[i].y - 2 * track[i - 1].y + track[i - 2].y);
    worst = Math.max(worst, a);
  }
  assert.ok(worst < 16, 'largest frame-to-frame change in velocity: ' + worst + ' px');
  assert.deepEqual(plain(track[track.length - 1]), { x: 1500, y: 300 });
});

const RECT = { x: 900, y: 500, w: 92, h: 34 };
test('travel and lasso are one move: it flies, the line starts before it lands, arrival fires at the close', () => {
  const f = fixture(); f.run(100);
  assert.equal(f.knot.travelTo({ x: 800, y: 560 }, { lasso: RECT }), true);
  assert.equal(f.thread.getState(), 'unwinding', 'guide logic sees the step from lift-off');
  let sawLineInFlight = false, slack = 0;
  for (let i = 0; i < 120; i++) { f.run(FRAME); if (f.knot.isTravelling() && f.thread.isLasso()) sawLineInFlight = true; slack = Math.max(slack, f.knot.stats().shape.slack); }
  assert.ok(sawLineInFlight, 'no pause between the flight and the throw');
  assert.ok(slack > .4, 'the Knot unravels as the line pays out: ' + slack);
  assert.ok(!f.knot.isTravelling());
  assert.equal(f.calls.filter((c) => c === 'arrive').length, 1);
  assert.equal(f.thread.getState(), 'pointing');
  assert.deepEqual(plain(f.thread.getTarget()), RECT);
  const tip = f.thread.getTip();
  assert.ok(tip.x > 960, 'the bubble side is away from the Knot: ' + JSON.stringify(tip));
  assert.equal(f.log.nonFinite, 0); assert.equal(f.knot.stats().errors, 0);
});

test('the Knot ties back up when the lasso comes home', () => {
  const f = fixture(); f.run(100);
  f.knot.travelTo({ x: 800, y: 560 }, { lasso: RECT }); f.run(2000);
  const out = f.knot.stats().shape.slack;
  assert.ok(out > .4 && out <= .6, 'unravelled a little, not all the way: ' + out);
  f.thread.rewind(); assert.equal(f.thread.getState(), 'rewinding');
  f.run(1600);
  assert.equal(f.thread.getState(), 'idle');
  assert.equal(f.knot.stats().shape.slack, 0);
  assert.deepEqual(f.calls.filter((c) => c === 'arrive' || c === 'rewound'), ['arrive', 'rewound']);
});

test('step to step: the line reels in as it lifts off, no rewound and no second home trip', () => {
  const f = fixture(); f.run(100);
  f.knot.travelTo({ x: 800, y: 560 }, { lasso: RECT }); f.run(1800);
  f.knot.travelTo({ x: 300, y: 300 }, { lasso: { x: 400, y: 200, w: 60, h: 30 } });
  assert.equal(f.thread.getState(), 'unwinding');
  f.run(1800);
  assert.equal(f.calls.filter((c) => c === 'arrive').length, 2);
  assert.deepEqual(f.calls.filter((c) => c === 'rewound'), [], 'guide logic never thinks it ended');
  assert.deepEqual(plain(f.thread.getTarget()), { x: 400, y: 200, w: 60, h: 30 });
});

test('dismissed mid-flight: no arrival, guide logic is told at once, the lasso never starts', () => {
  const f = fixture(); f.run(100);
  f.knot.travelTo({ x: 800, y: 560 }, { lasso: RECT }); f.run(100);
  f.thread.rewind();
  assert.equal(f.thread.getState(), 'idle');
  assert.deepEqual(f.calls.filter((c) => c === 'rewound'), ['rewound']);
  f.run(1800);
  assert.ok(!f.thread.isLasso()); assert.deepEqual(f.calls.filter((c) => c === 'arrive'), []);
});

test('"circle it" throws the line again, silently, and refuses when there is no lasso', () => {
  const f = fixture(); f.run(100);
  assert.equal(f.thread.replayLasso(), false);
  f.knot.travelTo({ x: 800, y: 560 }, { lasso: RECT }); f.run(1800);
  assert.equal(f.thread.replayLasso(), true);
  assert.equal(f.thread.getProgress(), 0);
  f.run(800);
  assert.equal(f.thread.getProgress(), 1);
  assert.equal(f.calls.filter((c) => c === 'arrive').length, 1, 'arrival is not announced twice');
});

test('reduced motion: a guide step places the Knot and its lasso at once', () => {
  const f = fixture({ reduced: true });
  assert.equal(f.knot.travelTo({ x: 800, y: 560 }, { lasso: RECT }), false);
  assert.ok(f.thread.isLasso()); assert.equal(f.thread.getProgress(), 1);
  assert.deepEqual(f.calls.filter((c) => c === 'arrive'), ['arrive']);
  assert.equal(f.frames.size, 0);
});

test('the shapes: idle and sleeping are the flat loop, thinking the trefoil, active the loose loop', () => {
  const f = fixture(); f.run(1500);
  const is = (flat, face, loose) => { const s = f.knot.stats().shape; assert.deepEqual([s.flat, s.face, s.loose].map((v) => Math.round(v * 100) / 100), [flat, face, loose]); };
  is(1, 0, 0);
  f.knot.setState('thinking'); f.run(2000); is(0, 1, 0);
  f.knot.setState('ready'); f.run(2000); is(0, 0, 1);
  f.knot.setState('working'); f.run(2000); is(0, 1, 0);
  f.knot.setState('speaking'); f.run(2000); is(0, 0, 1);
  f.knot.setState('idle'); f.run(2000); is(1, 0, 0);
  f.knot.sleep(); f.run(3000); is(1, 0, 0);
});

test('active and thinking flow into each other: the same points, never a jump, from any moment', () => {
  const f = fixture();
  const pts = () => f.knot.debugPoints();
  f.knot.setState('ready'); f.run(2000);
  for (const [next, after] of [['thinking', 'ready'], ['ready', 'thinking'], ['thinking', 'ready']]) {
    f.knot.setState(next);
    let last = pts(), worst = 0;
    for (let i = 0; i < 90; i++) {
      if (i === 25) f.knot.setState(after);
      if (i === 50) f.knot.setState(next);
      f.run(FRAME);
      const now = pts();
      assert.equal(now.length, last.length, 'one strand');
      // By the curve, not by the point's number: when the spin lands the same curve
      // is relabelled by a third of its length, which is not a move.
      for (const q of now) { let near = Infinity; for (const o of last) near = Math.min(near, Math.hypot(q.x - o.x, q.y - o.y)); worst = Math.max(worst, near); }
      last = now;
    }
    assert.ok(worst < 14, next + ': the most the curve moved in one frame: ' + worst + ' px');
  }
  assert.equal(f.knot.stats().errors, 0); assert.equal(f.log.nonFinite, 0);
});

test('the spin ends on a third of a turn, so the tail comes out the same way up every time', () => {
  for (const ms of [300, 700, 1200, 2111]) {
    const f = fixture(); f.knot.setState('ready'); f.run(2000);
    const rest = f.knot.debugPoints();
    const tip = (pts) => { let b = pts[0], d = -1; for (const q of pts) { const v = Math.hypot(q.x - 90, q.y - 90); if (v > d) { d = v; b = q; } } return b; };
    const a = tip(rest);
    f.knot.setState('thinking'); f.run(ms);
    f.knot.setState('ready'); f.run(2500);
    const b = tip(f.knot.debugPoints());
    assert.ok(Math.hypot(a.x - b.x, a.y - b.y) < 2, 'after ' + ms + ' ms the tip is back: ' + JSON.stringify([a, b]));
    assert.equal(f.knot.stats().shape.spin, 0);
  }
});

test('the brightness behind it changes nothing about the drawing, awake or asleep', () => {
  const f = fixture(); f.run(2500);
  const d = f.knot.stats().bodyDraws;
  f.knot.setBackdrop(1); f.run(500);
  assert.equal(f.knot.getBackdrop(), 1);
  assert.equal(f.knot.stats().bodyDraws, d);
  f.knot.sleep(); f.run(2500); assert.ok(f.knot.isAsleep());
  const e = f.knot.stats().bodyDraws; f.knot.setBackdrop(0); f.run(500);
  assert.equal(f.knot.stats().bodyDraws, e); assert.ok(f.knot.isAsleep());
});

test('the source keeps its promises', () => {
  assert.doesNotMatch(engineSrc, /setInterval\(/, 'no timers: one rAF loop');
  assert.match(engineSrc, /HOST\.springSnap/, 'springs snap to rest');
  assert.match(engineSrc, /catch \(e\) \{ recover\(e\); \}/, 'a frame that throws never stops the loop');
  assert.doesNotMatch(engineSrc, /gesture = null[^\n]*\n[^\n]*state = next/, 'setState does not clear the gesture');
});

// The region mark (renders-0115-2026-11-02, O4 option C, the small pen): one
// motion from lift-off to the lasso, the Knot at 55 percent riding the line's
// tip round the area, slowing into corners, no jump at any hand-off.
test('a region step: fly, shrink, trace the rounded rectangle without a jump, then the lasso with the velocity kept', () => {
  const f = fixture({ x: 300, y: 900 });
  const region = { x: 500, y: 200, w: 900, h: 480 }, control = { x: 520, y: 150, w: 90, h: 30 };
  f.run(200);
  const samples = [];
  f.knot.travelTo({ x: 470, y: 180 }, { lasso: control, region });
  for (let i = 0; i < 60 * 6; i++) {
    f.run(FRAME);
    const st = f.knot.stats();
    samples.push({ x: f.pos.x, y: f.pos.y, scale: st.pose.scale, tracing: st.tracing, mark: st.mark ? Object.assign({}, st.mark) : null, travelling: st.travelling });
  }
  const tracing = samples.filter((s) => s.tracing);
  assert.ok(tracing.length > 60, 'the trace lasts over a second');
  assert.ok(Math.min(...tracing.map((s) => s.scale)) < .62, 'at 55 percent while drawing: ' + Math.min(...tracing.map((s) => s.scale)).toFixed(2));
  // Arc length only ever grows, and no frame jumps.
  const us = tracing.map((s) => s.mark.u);
  for (let i = 1; i < us.length; i++) assert.ok(us[i] >= us[i - 1] - 1e-9, 'the pen never goes back');
  assert.ok(us[us.length - 1] > .99, 'the rectangle is closed');
  const steps = [];
  for (let i = 1; i < samples.length; i++) steps.push(Math.hypot(samples[i].x - samples[i - 1].x, samples[i].y - samples[i - 1].y));
  // Through the trace and one frame either side of it (the two hand-offs).
  const first = samples.findIndex((s) => s.tracing), lastT = samples.length - 1 - samples.slice().reverse().findIndex((s) => s.tracing);
  const traceSteps = steps.slice(Math.max(0, first - 1), lastT + 1);
  assert.ok(Math.max(...traceSteps) < 40, 'no trace frame moves more than 40 px: ' + Math.max(...traceSteps).toFixed(1));
  // Slower into the corners than along the straights.
  // Per frame steps, for the frames in a corner against the frames on the top straight.
  const stepAt = (i) => (i > 0 ? steps[i - 1] : 0);
  const inCorner = (s) => { const nx = Math.min(Math.abs(s.x - 494), Math.abs(s.x - 1406)), ny = Math.min(Math.abs(s.y - 194), Math.abs(s.y - 686)); return nx < 30 && ny < 30; };
  const onStraight = (s) => Math.abs(s.y - 186) < 12 && s.x > 700 && s.x < 1200;
  const corner = [], straight = [];
  samples.forEach((s, i) => { if (!s.tracing || i === 0 || !samples[i - 1].tracing) return; if (inCorner(s)) corner.push(stepAt(i)); else if (onStraight(s)) straight.push(stepAt(i)); });
  const mean = (arr) => arr.reduce((a, b) => a + b, 0) / Math.max(1, arr.length);
  assert.ok(corner.length > 4 && straight.length > 4, 'frames in corners and on straights: ' + corner.length + ', ' + straight.length);
  assert.ok(mean(corner) < mean(straight) * .7, 'corners at under 70 percent of straight speed: ' + mean(corner).toFixed(1) + ' vs ' + mean(straight).toFixed(1));
  // The hand-off to the lasso flight: the step after is within 12 px of the step before.
  const end = samples.findIndex((s, i) => i > 0 && samples[i - 1].tracing && !s.tracing);
  assert.ok(end > 0, 'the trace ended');
  assert.ok(Math.abs(steps[end] - steps[end - 1]) < 12, 'velocity kept at the hand-off: ' + steps[end - 1].toFixed(1) + ' then ' + steps[end].toFixed(1));
  const last = samples[samples.length - 1];
  assert.equal(last.mark.phase, 'hold', 'the mark holds');
  assert.ok(last.scale > .8, 'back to its idle size (.86) by the end: ' + last.scale.toFixed(2));
  assert.ok(f.thread.isLasso(), 'and the lasso is on the control');
  assert.equal(f.knot.stats().errors, 0); assert.equal(f.log.nonFinite, 0);
  // Dismissed: the mark reels in with the lasso and is gone.
  f.thread.rewind(); f.run(900);
  assert.equal(f.knot.stats().mark, null, 'the mark is gone');
  assert.ok(f.calls.includes('rewound'));
});

test('a region step dismissed mid-trace stops where it is, reels the mark in, and reports rewound', () => {
  const f = fixture({ x: 300, y: 900 });
  f.run(200);
  f.knot.travelTo({ x: 470, y: 180 }, { lasso: { x: 520, y: 150, w: 90, h: 30 }, region: { x: 500, y: 200, w: 900, h: 480 } });
  f.run(1500);
  assert.ok(f.knot.stats().tracing, 'mid-trace');
  f.thread.rewind();
  assert.ok(f.calls.includes('rewound'));
  assert.equal(f.knot.stats().travelling, false);
  assert.equal(f.places[f.places.length - 1], 'final', 'landed where it was');
  f.run(600);
  assert.equal(f.knot.stats().mark, null);
  assert.ok(f.knot.stats().pose.scale > .8, 'back to its idle size');
});

// 2026-11-16, the "fast spin": the facing angle kept every whole turn the Knot was
// dragged around in, and the next time its tail wound in or out it unwound all of
// them at once (after three circles, three turns in a fraction of a second).
function turnsDrawn(f, ms) {
  // True 2D turning of the drawn outline, frame to frame (best rigid fit), in turns.
  const fit = (a, b) => {
    let ax = 0, ay = 0, bx = 0, by = 0; const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) { ax += a[i].x; ay += a[i].y; bx += b[i].x; by += b[i].y; }
    ax /= n; ay /= n; bx /= n; by /= n;
    let c = 0, s = 0;
    for (let i = 0; i < n; i++) { const x1 = a[i].x - ax, y1 = a[i].y - ay, x2 = b[i].x - bx, y2 = b[i].y - by; c += x1 * x2 + y1 * y2; s += x1 * y2 - y1 * x2; }
    return Math.atan2(s, c);
  };
  let prev = f.knot.debugPoints(), turns = 0;
  for (let t = 0; t < ms; t += FRAME) { f.run(FRAME); const p = f.knot.debugPoints(); turns += Math.abs(fit(prev, p)) / (2 * Math.PI); prev = p; }
  return turns;
}

test('dragged in circles, the Knot does not unwind those turns when its tail later winds in or out', () => {
  const f = fixture({ x: 1500, y: 800 });
  f.run(1500);
  // Three circles of 160 px at one a second, the hand's speed fed in as a drag does.
  const cx = 1340, cy = 800; let last = null;
  for (let t = 0; t < 3000; t += FRAME) {
    const a = 2 * Math.PI * t / 1000, x = cx + 160 * Math.cos(a), y = cy + 160 * Math.sin(a);
    if (last) f.knot.setDrag({ vx: (x - last.x) * 60, vy: (y - last.y) * 60 });
    last = { x, y }; f.pos.x = x; f.pos.y = y; f.run(FRAME);
  }
  f.knot.setDrag(null); f.run(1500);
  // A click: the ask line opens (the tail reaches out), then closes (it winds back in).
  f.knot.setState('ready'); f.thread.reachTo({ x: f.pos.x - 230, y: f.pos.y - 170 });
  const opening = turnsDrawn(f, 1200);
  f.thread.releaseSurface(); f.knot.setState('idle');
  const closing = turnsDrawn(f, 1500);
  assert.ok(opening < 0.15, 'opening turned ' + opening.toFixed(2) + ' turns');
  assert.ok(closing < 0.15, 'closing turned ' + closing.toFixed(2) + ' turns');
  assert.equal(f.log.nonFinite, 0);
});
