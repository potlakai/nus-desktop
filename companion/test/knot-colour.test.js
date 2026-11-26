// The Knot's colour (decided 2026-11-03), run for real in a vm on a recording
// canvas: white at rest and asleep; while it does something, a lap of colour, a
// thin core and a soft glow in the strand's own shape.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const dir = path.join(__dirname, '..', 'renderer');
const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
const specSrc = read('knot-spec.js'), engineSrc = read('knot-engine.js');
const FRAME = 1000 / 60;
const INK = 'rgb(13,15,25)', WHITE = 'rgb(245,245,247)';
const css = (rgb) => 'rgb(' + rgb.join(',') + ')';

function recorder(log) {
  let style = '', filter = 'none', width = 1;
  const base = {
    stroke() { log.push({ style, filter, width }); },
    createRadialGradient() { log.gradients = (log.gradients || 0) + 1; return { addColorStop() {} }; },
    createLinearGradient() { log.gradients = (log.gradients || 0) + 1; return { addColorStop() {} }; },
    arc() { log.arcs = (log.arcs || 0) + 1; }, fill() { log.fills = (log.fills || 0) + 1; },
  };
  return new Proxy(base, {
    get: (o, k) => (k in o ? o[k] : () => {}),
    set: (o, k, v) => { if (k === 'strokeStyle') style = v; if (k === 'filter') filter = v; if (k === 'lineWidth') width = v; if (k === 'shadowBlur' && v) log.shadows = (log.shadows || 0) + 1; return true; },
  });
}

function fixture(o = {}) {
  let now = 1000, seq = 0;
  const frames = new Map(), body = [], line = [], timers = [];
  const pos = { x: 1800, y: 980 };
  const canvas = { width: 0, height: 0, style: {}, classList: { add() {}, remove() {} }, getContext: () => recorder(body), getBoundingClientRect: () => ({ left: pos.x - 90, top: pos.y - 90, width: 180, height: 180 }) };
  const strand = { width: 0, height: 0, style: {}, dataset: {}, getContext: () => recorder(line) };
  const window = { innerWidth: 1920, innerHeight: 1080, devicePixelRatio: 1, location: { search: '' }, matchMedia: () => ({ matches: !!o.reduced, addEventListener() {}, removeEventListener() {} }), addEventListener() {}, removeEventListener() {} };
  const ctx = { window, performance: { now: () => now }, getComputedStyle: () => ({ getPropertyValue: () => '#7890ff' }), requestAnimationFrame: (fn) => { frames.set(++seq, fn); return seq; }, cancelAnimationFrame: (id) => frames.delete(id), setTimeout: (fn, ms) => { timers.push({ fn, at: now + ms }); return timers.length; }, clearTimeout() {}, Math, Number, Object, Array, String, Error, TypeError, Float64Array };
  vm.runInNewContext(specSrc, ctx); vm.runInNewContext(engineSrc, ctx);
  const e = window.NusKnotEngine.mount({ body: canvas, thread: strand, hooks: { place: (p) => { pos.x = p.x; pos.y = p.y; } } });
  const run = (ms) => {
    for (let t = 0; t < ms - 1e-6; t += FRAME) {
      now += FRAME;
      for (const x of timers.splice(0)) { if (x.at <= now) x.fn(); else timers.push(x); }
      const batch = [...frames.values()]; frames.clear(); batch.forEach((fn) => fn(now));
    }
  };
  // Only what the next stretch of time draws.
  const during = (ms) => { body.length = 0; run(ms); return body.slice(); };
  return { knot: e.knot, thread: e.thread, spec: window.NusKnotSpec, run, during, body, line };
}
const plain = (v) => JSON.parse(JSON.stringify(v));
const colours = (strokes) => new Set(strokes.map((s) => s.style));
const glows = (strokes) => strokes.filter((s) => s.filter !== 'none');
const lines = (strokes) => strokes.filter((s) => s.filter === 'none');
const alphaOf = (s) => Number(s.style.match(/rgba\(\d+,\d+,\d+,([\d.]+)\)/)[1]);

const PALETTE = { idle: '#F5F5F7', listening: '#C58AFF', thinking: '#FFC76A', speaking: '#59B9FF', done: '#72DDA8', error: '#FF706B' };
const EXPECT = { listening: 'listening', thinking: 'thinking', working: 'thinking', speaking: 'speaking', reading: 'speaking', error: 'error' };

test('the palette is Pranav\'s, one colour per meaning, in one place', () => {
  const { spec } = fixture(), A = spec.character.accent;
  assert.deepEqual(plain(A.palette), PALETTE);
  assert.deepEqual(plain(A.states), EXPECT, 'reading wears speaking\'s blue, working wears thinking\'s amber');
  assert.deepEqual(plain(spec.character.look.white), plain(spec.hexRgb(PALETTE.idle)), 'the white at rest is the palette\'s white');
});

test('the pill and the CSS wear the same colours as the Knot', () => {
  const { spec } = fixture(), I = spec.character.island.accents, styles = read('styles.css'), look = read('knot-look.css');
  assert.equal(I.listening, PALETTE.listening);
  assert.equal(I.thinking, PALETTE.thinking);
  assert.equal(I.speaking, PALETTE.speaking);
  assert.equal(I.reading, PALETTE.speaking);
  assert.equal(I.hands, PALETTE.thinking);
  assert.equal(I.done, PALETTE.done);
  assert.equal(I.error, PALETTE.error);
  assert.equal(I.idle, PALETTE.idle);
  for (const tone of ['listening', 'thinking', 'hands', 'reading', 'speaking']) {
    assert.ok(styles.includes("#island[data-state='" + tone + "'] { --isl-acc: " + spec.hexRgb(I[tone]).join(',') + ';'), tone + ': the pill rule has the spec\'s numbers');
  }
  for (const s of ['listening', 'thinking', 'working', 'reading']) {
    assert.ok(look.includes("data-knot-state='" + s + "'] #orb { --knot-accent: " + PALETTE[EXPECT[s]] + '; }'), s + ': the CSS accent has the spec\'s colour');
  }
  assert.doesNotMatch(styles + look, /EF5350|239,83,80|8C96FF|140,150,255|224,182,99/i, 'none of the old state colours are left');
  assert.doesNotMatch(styles, /#orb\.k3d(\.listening|\[data-state="listening"\])\s*\{\s*box-shadow/, 'the wide shadow round the mic is gone; the glow follows the shape');
});

test('each state wears its accent once settled: core and glow, on top of ink and white', () => {
  for (const [s, name] of Object.entries(EXPECT)) {
    const f = fixture(), rgb = f.spec.hexRgb(PALETTE[name]);
    f.knot.setState(s); f.run(1500);
    if (s === 'listening') { f.knot.setLevel(1); f.run(800); }
    const seen = f.during(FRAME * 2);
    assert.ok(colours(lines(seen)).has(INK), s + ' keeps its ink');
    assert.ok(colours(lines(seen)).has(WHITE), s + ' keeps its white');
    assert.ok([...colours(lines(seen))].some((c) => c === css(rgb)), s + ': the core is ' + PALETTE[name] + ', got ' + [...colours(lines(seen))].join(' '));
    assert.equal(colours(lines(seen)).size, 3, s + ': ink, white, the accent and nothing else');
    assert.ok(glows(seen).length > 0, s + ' has its glow');
    for (const g of glows(seen)) assert.ok(g.style.startsWith('rgba(' + rgb.join(',') + ','), s + ': the glow is the same colour');
    assert.equal(f.knot.stats().errors, 0);
    assert.equal(f.knot.tintStats().name, name);
  }
});

test('at rest and asleep: ink and white only, no glow, no filter, nothing filled', () => {
  for (const s of ['idle', 'ready']) {
    const f = fixture();
    f.knot.setState(s); f.run(1500);
    const seen = f.body;
    assert.deepEqual([...colours(seen)].sort(), [WHITE, INK].sort(), s);
    assert.equal(glows(seen).length, 0, s + ' has no glow');
    assert.equal(f.knot.tintStats().name, null);
  }
  const f = fixture(); f.knot.sleep(); f.run(3000);
  assert.deepEqual([...colours(f.body)].sort(), [WHITE, INK].sort());
  assert.equal(glows(f.body).length, 0, 'asleep has no glow');
});

test('sleep takes the colour at once, and a sleeping Knot draws nothing new', () => {
  const f = fixture();
  f.knot.setState('thinking'); f.run(900);
  f.knot.setState('idle'); f.knot.sleep();
  const t = f.knot.tintStats();
  assert.equal(t.core, 0); assert.equal(t.glow, 0); assert.equal(t.name, null);
  const seen = f.during(3000);
  assert.deepEqual([...colours(seen)].sort(), [WHITE, INK].sort(), 'no fade on the way down');
  assert.equal(f.during(1000).length, 0, 'asleep it paints nothing');
});

test('arrival: first colour on the next frame, the glow there by 100 ms, the lap done by 500 ms', () => {
  const f = fixture(); f.run(1500);
  f.knot.setState('listening');
  const first = f.during(FRAME), rgb = f.spec.hexRgb(PALETTE.listening);
  assert.ok(glows(first).some((g) => g.style.startsWith('rgba(' + rgb.join(',') + ',')), 'the glow has started on the next frame');
  assert.ok(lines(first).some((c) => c.style.includes(rgb[0] + ',') || c.style !== INK && c.style !== WHITE), 'the lap has started on the next frame');
  const early = f.knot.tintStats();
  assert.ok(early.cov > 0 && early.cov < .1, 'the lap has only just begun: ' + early.cov);
  f.run(100 - FRAME + 1);
  assert.equal(f.knot.tintStats().glow, 1, 'the glow has arrived within 100 ms');
  f.run(400);
  assert.equal(f.knot.tintStats().cov, 1, 'the core covers the whole strand by 500 ms');
});

test('leaving: gone within 300 ms, then a settled Knot repaints nothing', () => {
  const f = fixture();
  f.knot.setState('thinking'); f.run(1500);
  f.knot.setState('idle');
  f.run(150);
  const mid = f.knot.tintStats();
  assert.ok(mid.core > .1 && mid.core < .9, 'part way out at 150 ms: ' + mid.core);
  f.run(150 + FRAME);
  const t = f.knot.tintStats();
  assert.equal(t.core, 0); assert.equal(t.glow, 0); assert.equal(t.moving, false);
  const after = f.during(FRAME * 2);
  for (const c of colours(after)) assert.ok(c === INK || c === WHITE, 'white again: ' + c);
  f.run(1500);
  assert.equal(f.during(1000).length, 0, 'nothing repainted once settled, the same as before there was colour');
});

test('a change mid-state: the old colour stays ahead of the lap, never a flash of white', () => {
  const f = fixture(), A = f.spec.hexRgb(PALETTE.thinking), B = f.spec.hexRgb(PALETTE.speaking);
  f.knot.setState('thinking'); f.run(1500);
  f.knot.setState('speaking');
  const seen = f.during(FRAME * 12);
  assert.ok(colours(lines(seen)).has(css(A)), 'the old colour is still ahead of the head');
  assert.ok(colours(lines(seen)).has(css(B)), 'the new colour is behind it');
  f.run(600);
  assert.ok(!colours(lines(f.during(FRAME * 2))).has(css(A)), 'the old colour has gone once the lap is over');
});

test('the glow is a blurred copy of the strand: medium spread, scaled by the canvas, no disc', () => {
  const f = fixture();
  f.knot.setState('thinking'); f.run(900);
  const seen = f.during(FRAME), g = glows(seen);
  assert.equal(g.length, 1, 'one stroke a frame, under everything');
  assert.equal(g[0].filter, 'blur(' + (f.spec.character.accent.glow.spread / 2 * f.spec.character.look.supersample) + 'px)');
  assert.ok(seen.indexOf(g[0]) === 0, 'drawn first, so the ink and the white sit on top');
  assert.ok(f.spec.character.accent.glow.spread >= 10 && f.spec.character.accent.glow.spread <= 16, 'medium spread, 10 to 16 px');
  assert.equal(f.body.arcs, undefined, 'no disc');
  assert.equal(f.body.fills, undefined, 'nothing filled');
  assert.equal(f.body.gradients, undefined, 'no gradient');
  assert.equal(f.body.shadows, undefined, 'no canvas shadow');
});

test('the glow breathes between 60 and 100 percent on a slow cycle while the state lasts', () => {
  const f = fixture(), G = f.spec.character.accent.glow;
  assert.ok(G.period >= 2 && G.period <= 3, 'a 2 to 3 s cycle');
  f.knot.setState('thinking'); f.run(800);
  const alphas = glows(f.during(G.period * 2000)).map(alphaOf), hi = Math.max(...alphas), lo = Math.min(...alphas);
  assert.ok(Math.abs(hi - G.strength) < .01, 'up to 100 percent: ' + hi);
  assert.ok(Math.abs(lo - G.strength * G.low) < .01, 'down to 60 percent: ' + lo);
  for (let i = 1; i < alphas.length; i++) assert.ok(Math.abs(alphas[i] - alphas[i - 1]) < .02, 'no jump in the breath');
  const later = glows(f.during(30000));
  assert.ok(later.length > 1000, 'it is still breathing 30 s on, for as long as the action lasts');
});

test('the mic lifts the listening colour a little', () => {
  const f = fixture(), M = f.spec.character.accent.mic, rgb = f.spec.hexRgb(PALETTE.listening), white = f.spec.hexRgb(PALETTE.idle);
  f.knot.setState('listening'); f.run(1500);
  const core = (strokes) => lines(strokes).filter((c) => c.style !== INK && c.style !== WHITE);
  const quiet = core(f.during(FRAME))[0];
  const quietMix = white.map((v, i) => Math.round(v + (rgb[i] - v) * M.floor));
  assert.equal(quiet.style, css(quietMix), 'an open mic in silence still shows most of its colour');
  f.knot.setLevel(1); f.run(800);
  const loud = core(f.during(FRAME))[0];
  assert.equal(loud.style, css(rgb), 'full colour at a loud voice');
  f.knot.setLevel(0); f.run(800);
  const again = core(f.during(FRAME))[0];
  assert.ok(Math.abs(again.width - quiet.width) < 1, 'it comes back down');
  assert.ok(f.knot.tintStats().mic < .01);
  // The core's width at the same point on the strand.
  const widest = (level) => { f.knot.setLevel(level); f.run(800); return Math.max(...core(f.during(FRAME)).map((c) => c.width)); };
  const a = widest(0), b = widest(1);
  assert.ok(b > a * 1.2 && b < a * 1.45, 'a little wider, not a lot: ' + a + ' to ' + b);
  f.knot.setState('thinking'); f.knot.setLevel(1); f.run(800);
  assert.equal(f.knot.tintStats().mic, 0, 'only listening listens');
});

test('done is a short green that outranks the state, then the state comes back', () => {
  const f = fixture(), hold = f.spec.character.accent.beats.done.hold * 1000;
  f.knot.setState('speaking'); f.run(1500);
  f.knot.gesture('done');
  assert.equal(f.knot.tintStats().name, 'done');
  f.run(600);
  assert.ok(colours(lines(f.during(FRAME))).has(css(f.spec.hexRgb(PALETTE.done))), 'green over the speaking blue');
  f.run(hold - 600);
  assert.equal(f.knot.tintStats().name, 'speaking', 'the state has its colour again');
  const g = fixture();
  g.knot.setState('idle'); g.run(1500);
  g.knot.gesture('done'); g.run(hold + 400);
  assert.equal(g.knot.tintStats().name, null); assert.equal(g.knot.tintStats().core, 0);
  g.run(1500);
  assert.equal(g.during(1000).length, 0, 'a beat at rest ends in a settled Knot');
  assert.equal(g.knot.stats().errors, 0);
});

test('an error beat is coral, and the other gestures bring no colour', () => {
  const f = fixture();
  f.run(1000);
  f.knot.gesture('error');
  assert.equal(f.knot.tintStats().name, 'error');
  f.run(1500);
  for (const g of ['acknowledge', 'poke', 'nudge', 'arrive', 'gulp', 'settle']) {
    f.knot.gesture(g);
    assert.equal(f.knot.tintStats().name, null, g + ' brings no colour');
    f.run(800);
  }
  assert.equal(f.knot.tintStats().core, 0);
  assert.equal(f.knot.stats().errors, 0);
});

test('the thread and the lasso stay white while the Knot is coloured', () => {
  const f = fixture();
  f.knot.setState('speaking');
  f.thread.setTarget({ x: 400, y: 300, w: 80, h: 30 }, { task: 'guide' }); f.run(1500);
  f.knot.travelTo({ x: 500, y: 400 }, { lasso: { x: 600, y: 350, w: 90, h: 30 } }); f.run(2000);
  assert.ok(f.line.length > 0, 'the thread drew');
  for (const c of colours(f.line)) assert.ok(c === INK || c === WHITE, 'thread stroke ' + c);
  assert.equal(glows(f.line).length, 0, 'no glow on the thread');
  assert.equal(f.knot.stats().errors, 0);
});

test('reduced motion: the colour still shows, cut in and out, with no lap, no breath, no mic lift', () => {
  const f = fixture({ reduced: true }), rgb = f.spec.hexRgb(PALETTE.thinking);
  f.body.length = 0;
  f.knot.setState('thinking');
  const t = f.knot.tintStats();
  assert.equal(t.cov, 1, 'no lap'); assert.equal(t.glow, 1);
  assert.ok(colours(lines(f.body)).has(css(rgb)), 'the core is there in the one static frame');
  const g = glows(f.body);
  assert.equal(g.length, 1, 'one frame, one glow');
  const a = alphaOf(g[0]);
  f.body.length = 0; f.run(5000);
  assert.equal(f.body.length, 0, 'no loop runs');
  f.knot.redraw();
  assert.equal(alphaOf(glows(f.body)[0]), a, 'the glow holds still');
  f.body.length = 0;
  f.knot.setState('idle');
  assert.equal(f.knot.tintStats().core, 0, 'gone at once');
  assert.deepEqual([...colours(f.body)].sort(), [WHITE, INK].sort(), 'white in the very next static frame');
  f.body.length = 0;
  f.knot.gesture('done');
  assert.ok(colours(lines(f.body)).has(css(f.spec.hexRgb(PALETTE.done))), 'a beat still shows');
  f.body.length = 0;
  f.run(1000);
  assert.equal(f.knot.tintStats().name, null, 'and ends without a loop');
  assert.deepEqual([...colours(f.body)].sort(), [WHITE, INK].sort());
});

test('the colour interrupted at every moment never throws or draws a bad number', () => {
  const f = fixture(), seq = ['listening', 'idle', 'thinking', 'speaking', 'error', 'ready', 'reading', 'working', 'idle'];
  for (let round = 0; round < 3; round++) for (const s of seq) {
    f.knot.setState(s); f.run(40 + round * 90);
    if (s === 'speaking') f.knot.gesture('done');
    f.knot.setLevel(round / 2);
  }
  for (const s of f.body) if (s.filter !== 'none') assert.ok(Number.isFinite(alphaOf(s)), 'glow alpha ' + s.style);
  for (const s of f.body) assert.doesNotMatch(String(s.style), /NaN|undefined|null/, 'stroke ' + s.style);
  assert.equal(f.knot.stats().errors, 0);
});

test('there is one amber: every gold the overlay paints is the thinking colour', () => {
  const family = ([r, g, b]) => {
    const M = Math.max(r, g, b), m = Math.min(r, g, b), d = M - m;
    if (!d || d / M <= .3 || r <= 150 || M !== r) return false;
    const h = ((g - b) / d) * 60;
    return h >= 28 && h <= 55;
  };
  const off = [];
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.css'))) {
    read(f).split('\n').forEach((line, i) => {
      const found = [];
      for (const m of line.matchAll(/#([0-9a-fA-F]{6})\b/g)) found.push([1, 3, 5].map((k) => parseInt(m[0].slice(k, k + 2), 16)));
      for (const m of line.matchAll(/(?:rgba?\(|--[a-z-]+:\s*)(\d{1,3}),\s*(\d{1,3}),\s*(\d{1,3})/g)) found.push([+m[1], +m[2], +m[3]]);
      for (const c of found) if (family(c) && c.join() !== '255,199,106') off.push(f + ':' + (i + 1) + ' ' + c.join());
    });
  }
  assert.deepEqual(off, []);
  assert.equal(family([255, 199, 106]), true, 'the check sees the amber itself');
  assert.equal(family([224, 182, 99]), true, 'and the old golds');
  assert.equal(family([255, 112, 107]), false, 'not the coral');
});
