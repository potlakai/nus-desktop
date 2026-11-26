'use strict';
// Play (renderer/play.js, play-fx.js, play-sound.js): the ball, the hoop, the
// scoring and the rules around them, in plain Node with a stub host. The renderer
// wiring (a task ends the game, the screen holds the mouse) is checked live; see
// the Verified notes in ventures/nus/promo/play-1116/BUILD.md.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const KSPEC = require('../renderer/knot-spec.js');
const Play = require('../renderer/play.js');
const PlayFx = require('../renderer/play-fx.js');
const PlaySound = require('../renderer/play-sound.js');

const P = KSPEC.host.play;
const B = { w: 1920, h: 1080, m: KSPEC.host.clampMargin };

test('spec has every number the game reads', () => {
  for (const k of ['radius', 'throwMin', 'throwMax', 'releaseStaleMs', 'throwWindowMs', 'gravity', 'air', 'wall', 'floor', 'floorFriction', 'restSpeed', 'spin', 'spinMax', 'idleEndMs', 'hitstopMs']) assert.ok(Number.isFinite(P[k]), k);
  for (const k of ['per', 'max', 'k', 'damp']) assert.ok(Number.isFinite(P.squash[k]), 'squash.' + k);
  for (const k of ['r', 'rimR', 'rimBounce', 'boardBounce', 'boardUp', 'boardDown', 'boardGap', 'makesPerLevel', 'minY', 'maxY', 'margin']) assert.ok(Number.isFinite(P.hoop[k]), 'hoop.' + k);
  assert.ok(Array.isArray(P.hoop.motion) && P.hoop.motion.length >= 3);
  for (const k of ['reach', 'above', 'pull']) assert.ok(Number.isFinite(P.assist[k]), 'assist.' + k);
  for (const k of ['make', 'swish', 'bank', 'fireAt', 'fireMul']) assert.ok(Number.isFinite(P.score[k]), 'score.' + k);
});

test('a slow or stale release is a drop, a flick is a throw, capped', () => {
  assert.deepEqual(Play.throwOf({ x: 100, y: 0 }, 10, P), { x: 0, y: 0 });
  assert.deepEqual(Play.throwOf({ x: 2000, y: 0 }, P.releaseStaleMs + 1, P), { x: 0, y: 0 });
  assert.deepEqual(Play.throwOf({ x: 1200, y: -600 }, 10, P), { x: 1200, y: -600 });
  const big = Play.throwOf({ x: 99999, y: 0 }, 10, P);
  assert.ok(Math.abs(Math.hypot(big.x, big.y) - P.throwMax) < 1e-6);
});

test('a thrown ball never leaves the screen, spins, and rolls to rest on the floor', () => {
  const s = { p: { x: 1800, y: 900 }, v: { x: -3000, y: -2500 }, onFloor: false, spin: -60, rot: 0 };
  const seen = new Set();
  for (let i = 0; i < 20 * 60 && !seen.has('rest'); i++) {
    for (const [kind] of Play.stepBall(s, 1 / 60, B, P)) seen.add(kind);
    assert.ok(s.p.x >= B.m && s.p.x <= B.w - B.m, 'x inside');
    assert.ok(s.p.y >= B.m && s.p.y <= B.h - B.m, 'y inside');
  }
  assert.ok(seen.has('rest') && seen.has('wall') && seen.has('floor'));
  assert.equal(s.p.y, B.h - B.m);
  assert.notEqual(s.rot, 0, 'it turned on the way');
  assert.equal(s.spin, 0, 'at rest it has stopped turning');
});

test('however hard it is thrown, it is never seen turning faster than spinMax', () => {
  assert.ok(P.spinMax > 0 && P.spinMax < 2 * Math.PI, 'under one turn a second');
  const s = { p: { x: 900, y: 500 }, v: { x: P.throwMax, y: -400 }, onFloor: false, spin: P.throwMax / P.radius * P.spin, rot: 0 };
  for (let i = 0; i < 10 * 60; i++) {
    const before = s.rot;
    Play.stepBall(s, 1 / 60, B, P);
    let d = Math.abs(s.rot - before);
    if (d > Math.PI) d = 2 * Math.PI - d;
    assert.ok(d <= P.spinMax / 60 + 1e-9, 'step ' + i + ' turned ' + d);
  }
});

test('the board sits on the outside of the rim, and a ball thrown at it banks back', () => {
  const h = { x: 1500, y: 400, r: P.hoop.r, side: 1 };
  const parts = Play.hoopParts(h, P);
  assert.ok(parts.board.x > parts.back.x && parts.back.x > parts.front.x);
  const s = { p: { x: parts.board.x - 80, y: 340 }, v: { x: 1400, y: 0 }, onFloor: false };
  let banked = 0;
  for (let i = 0; i < 20; i++) { const prev = s.p.y; Play.stepBall(s, 1 / 60, B, P); banked = Math.max(banked, Play.stepHoop(s, prev, h, P).board); }
  assert.ok(banked > 0, 'it touched the board');
  assert.ok(s.v.x < 0, 'and came back off it');
});

test('a ball dropped through the middle is a make; one onto the near rim or wide is not', () => {
  const h = { x: 900, y: 300, r: P.hoop.r, side: 1 };
  function drop(x) {
    const s = { p: { x, y: 120 }, v: { x: 0, y: 0 }, onFloor: false };
    for (let i = 0; i < 120; i++) { const prev = s.p.y; Play.stepBall(s, 1 / 60, B, P); if (Play.stepHoop(s, prev, h, P).made) return true; }
    return false;
  }
  assert.equal(drop(900), true);
  assert.equal(drop(900 - P.hoop.r - P.radius * 0.5), false);
  assert.equal(drop(400), false);
});

test('a ball coming up through the hoop from below does not count', () => {
  const h = { x: 900, y: 300, r: P.hoop.r, side: 1 };
  const s = { p: { x: 900, y: 420 }, v: { x: 0, y: -1400 }, onFloor: false };
  let made = false;
  for (let i = 0; i < 8; i++) { const prev = s.p.y; Play.stepBall(s, 1 / 60, B, P); if (Play.stepHoop(s, prev, h, P).made && s.v.y < 0) made = true; }
  assert.equal(made, false);
});

test('scoring: a swish or bank is worth 2, a rim-in 1, and on fire it all doubles', () => {
  assert.equal(Play.pointsFor('in', 1, P), 1);
  assert.equal(Play.pointsFor('swish', 1, P), 2);
  assert.equal(Play.pointsFor('bank', 2, P), 2);
  assert.equal(Play.pointsFor('swish', P.score.fireAt, P), 4);
  assert.equal(Play.levelOf(0, P), 1);
  assert.equal(Play.levelOf(P.hoop.makesPerLevel, P), 2);
  assert.equal(Play.motionFor(1, P).drift, 0, 'level 1 holds still');
  assert.ok(Play.motionFor(3, P).drift > 0, 'level 3 drifts');
  assert.deepEqual(Play.motionFor(99, P), P.hoop.motion[P.hoop.motion.length - 1]);
});

test('the rim magnet pulls a falling ball near the hoop toward the middle, and nothing else', () => {
  const h = { x: 900, y: 300, r: P.hoop.r, side: 1 };
  assert.ok(Play.assistPull({ p: { x: 940, y: 250 }, v: { x: 0, y: 400 } }, h, P) < 0, 'right of centre: pulled left');
  assert.ok(Play.assistPull({ p: { x: 860, y: 250 }, v: { x: 0, y: 400 } }, h, P) > 0, 'left of centre: pulled right');
  assert.equal(Play.assistPull({ p: { x: 940, y: 250 }, v: { x: 0, y: -400 } }, h, P), 0, 'never on the way up');
  assert.equal(Play.assistPull({ p: { x: 1300, y: 250 }, v: { x: 0, y: 400 } }, h, P), 0, 'never from far away');
});

function harness(storeInit) {
  let t = 0, queued = [];
  const events = [], ends = [], store = Object.assign({}, storeInit || {});
  const host = {
    now: () => t,
    raf: (fn) => { queued.push(fn); return queued.length; },
    caf: () => {},
    bounds: () => B,
    place: () => {},
    lean: () => {},
    emit: (e) => events.push(e),
    gesture: () => {},
    store: { get: (k) => store[k] || null, set: (k, v) => { store[k] = v; } },
    log: () => {},
    onEnd: (reason, at) => ends.push({ reason, at }),
    random: () => 0.5,
  };
  const play = Play.create({ doc: null, spec: P, host });
  const h = {
    play, events, ends, store, st: play._state,
    tick(ms) { t += ms; const q = queued; queued = []; for (const fn of q) fn(t); },
    run(ms) { for (let i = 0; i < ms / 16; i++) h.tick(16); },
    // A soft throw straight down through the middle of the hoop: a swish.
    swish() { const at = { x: h.st.hoop.x, y: h.st.hoop.y - 150 }; play.press(at); play.release(at, { x: 0, y: 300 }, 5); },
    // A throw that lands far from the hoop: a miss.
    miss() { const at = { x: h.st.hoop.x > B.w / 2 ? 200 : 1700, y: 600 }; play.press(at); play.release(at, { x: 0, y: 300 }, 5); },
    count(type) { return events.filter((e) => e.type === type).length; },
  };
  return h;
}

test('a game: swishes score 2, three in a row is on fire at double, and the hoop moves', () => {
  const h = harness();
  h.play.start({ x: 1700, y: 900 });
  assert.equal(h.count('start'), 1);
  assert.equal(h.count('hoopIn'), 1);
  assert.ok(h.st.hoop.x < B.w / 2, 'first hoop is on the far side from the Knot');
  assert.equal(h.st.hoop.side, -1, 'and its board is on the outside');
  const first = h.st.hoop.baseX;
  for (let n = 1; n <= 3; n++) { h.swish(); h.run(900); assert.equal(h.st.makes, n); }
  const makes = h.events.filter((e) => e.type === 'make');
  assert.deepEqual(makes.map((e) => e.kind), ['swish', 'swish', 'swish']);
  assert.deepEqual(makes.map((e) => e.points), [2, 2, 4]);
  assert.equal(makes[2].fireStart, true);
  assert.equal(h.st.score, 8);
  assert.equal(h.store['play.best.hoop'], '8');
  h.run(600);
  assert.equal(h.count('hoopMove'), 1);
  assert.equal(h.st.level, 2);
  assert.ok(Math.abs(h.st.hoop.baseX - first) >= 200, 'it moved far enough to see');
  h.play.stop('user');
});

test('a miss ends the streak; a rim-in is worth 1; beating the old best says so once', () => {
  const h = harness({ 'play.best.hoop': '2' });
  h.play.start({ x: 1700, y: 900 });
  h.swish(); h.run(900);
  h.miss(); h.run(1500);
  assert.equal(h.st.streak, 0);
  assert.equal(h.count('miss'), 1);
  // Mark the next shot as having touched the rim: it is a plain make.
  h.swish(); h.st.shot.rim = true; h.run(900);
  const last = h.events.filter((e) => e.type === 'make').pop();
  assert.equal(last.kind, 'in');
  assert.equal(last.points, 1);
  assert.equal(h.st.score, 3);
  assert.equal(h.count('record'), 1, 'past the old best of 2');
  h.swish(); h.run(900);
  assert.equal(h.count('record'), 1, 'only once a game');
  h.play.stop('user');
});

test('a catch mid-air is no miss, and a still release just drops it', () => {
  const h = harness();
  h.play.start({ x: 960, y: 500 });
  h.miss(); h.run(80);
  h.play.press({ x: 700, y: 400 });
  assert.equal(h.play.held, true);
  assert.equal(h.st.shot, null, 'the shot in the air is off');
  h.play.dragTo({ x: 720, y: 380 });
  assert.deepEqual(h.play.position(), { x: 720, y: 380 });
  h.play.release({ x: 720, y: 380 }, { x: 50, y: 0 }, 5);
  assert.deepEqual(h.st.s.v, { x: 0, y: 0 });
  assert.equal(h.st.shot, null, 'a drop is not a shot');
  h.run(1500);
  assert.equal(h.count('miss'), 0);
  h.play.stop('user');
});

test('stop says why and where the Knot was; untouched, the game ends by itself', () => {
  const h = harness();
  h.play.start({ x: 960, y: 540 });
  const at = h.play.stop('task');
  assert.equal(h.play.active, false);
  assert.equal(h.ends[0].reason, 'task');
  assert.equal(h.events[h.events.length - 1].type, 'stop');
  assert.ok(at && Number.isFinite(at.x));
  assert.equal(h.play.stop('task'), null, 'stopping twice is nothing');
  h.play.start({ x: 960, y: 540 });
  h.miss(); h.tick(16);
  h.tick(P.idleEndMs + 1);
  assert.equal(h.play.active, false);
  assert.equal(h.ends[1].reason, 'idle');
});

// A canvas that takes any drawing call and does nothing.
function fakeDoc() {
  const made = [];
  const ctx = new Proxy({}, { get: (o, k) => (k in o ? o[k] : (k === 'createRadialGradient' ? () => ({ addColorStop() {} }) : () => {})), set: (o, k, v) => { o[k] = v; return true; } });
  const doc = {
    body: { appendChild(c) { made.push(c); } },
    createElement() { const c = { style: {}, width: 0, height: 0, setAttribute() {}, getContext: () => ctx, remove() { c.removed = true; } }; return c; },
  };
  const view = { innerWidth: 1920, innerHeight: 1080, devicePixelRatio: 2, addEventListener() {}, removeEventListener() {} };
  return { doc, view, made };
}

test('the look: drawn while something moves, then still; nothing left after the game', () => {
  const { doc, view, made } = fakeDoc();
  const pal = KSPEC.character.accent.palette;
  const fx = PlayFx.create({ doc, view, spec: P, palette: pal, font: 'sans-serif' });
  fx.start();
  assert.equal(made.length, 2, 'two canvases, back and front');
  assert.equal(made[0].width, 3840, 'sharp on a 2x screen');
  const hoop = { x: 400, y: 300, r: P.hoop.r, side: -1, baseX: 400, baseY: 300, phase: 0 };
  fx.event({ type: 'hoopIn', hoop });
  for (const e of [{ type: 'rim', impact: 900, x: 400, y: 300 }, { type: 'board', impact: 900, x: 330, y: 280 }, { type: 'make', kind: 'swish', points: 4, streak: 3, fire: true, fireStart: true, x: 400, y: 300 }, { type: 'record', score: 9, x: 400, y: 300 }, { type: 'floor', impact: 2000, x: 900, y: 1040, normal: 'y' }, { type: 'catch', x: 900, y: 900 }, { type: 'miss', streak: 4, x: 900, y: 1000 }]) fx.event(e);
  const v = { ball: { x: 900, y: 600, vx: 900, vy: -600, held: false, resting: false }, hoop: Object.assign({ parts: Play.hoopParts(hoop, P) }, hoop), fire: true, level: 1, frozen: false };
  assert.equal(fx.draw(1 / 60, v, B), true, 'busy while it all plays out');
  const still = { ball: { x: 900, y: 1040, vx: 0, vy: 0, held: false, resting: true }, hoop: v.hoop, fire: false, level: 1, frozen: false };
  let busy = true;
  for (let i = 0; i < 60 * 4 && busy; i++) busy = fx.draw(1 / 60, still, B);
  assert.equal(busy, false, 'and still once everything has landed');
  fx.stop();
  assert.ok(made.every((c) => c.removed && c.width === 0 && c.height === 0), 'canvases removed and emptied');
  assert.equal(fx.on, false);
  assert.equal(fx.draw(1 / 60, still, B), false, 'nothing drawn after the game');
});

test('the sound: a no-op without audio, and it never throws', () => {
  const snd = PlaySound.create({ enabled: () => true });
  for (const type of ['start', 'floor', 'rim', 'board', 'catch', 'throw', 'make', 'record', 'hoopIn', 'miss', 'stop']) snd.event({ type, impact: 900, speed: 1200, streak: 3, kind: 'swish', fireStart: true });
  assert.equal(snd.state, 'none');
  assert.equal(PlaySound.PENT[0], 62, 'in the Knot\'s key, D');
});

test('one game, started on purpose: the menu row, the tray item, and a task always wins', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');
  const menu = read('../renderer/knot-menu.js');
  assert.match(menu, /canPlay && canPlay\(\)/);
  assert.match(menu, /'Shoot hoops'/);
  assert.match(read('../index.js'), /'Shoot hoops with the Knot', click: \(\) => send\('play:start'/);
  assert.match(read('../preload.js'), /'play:start'/);
  const html = read('../renderer/index.html');
  for (const f of ['play-sound.js', 'play-fx.js', 'play.js', 'play.css']) assert.ok(html.includes(f), f);
  const r = read('../renderer/renderer.js');
  for (const where of ["if (play && play.active && (guideState || busy || acking || listening)) stopPlay('task');", "if (pttHeld && play && play.active) stopPlay('task');", "nus.on('tour:card', () => stopPlay('task'));"]) assert.ok(r.includes(where), where);
  assert.match(r, /openQuickAsk\(about, feedback, contact\) \{\n    if \(play && play\.active\) stopPlay\('task'\);/);
  assert.match(r, /function playBlocker\(\) \{[\s\S]*?islandOn[\s\S]*?reducedMotion\(\)[\s\S]*?guideActive\(\) \|\| busy \|\| pttHeld/);
  // Sound follows the Knot's own rules: off with Sound cues, the mic or its voice.
  assert.match(r, /enabled: \(\) => cues\.isEnabled\(\) && !pttHeld && !speakingNow && !captureOn\(\)/);
  // Nothing of the game is made before the first game.
  assert.match(r, /function makePlay\(\) \{\n    if \(play \|\| !window\.NusPlay\) return play;/);
});

test('with Reduce motion on, Shoot hoops stays in the menu and says why there is no game', () => {
  const r = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  assert.match(r, /canPlay: \(\) => \{ const why = playBlocker\(\); return why === '' \|\| why === 'reduced-motion'; \}/);
  assert.match(r, /if \(why === 'reduced-motion'\) showHint\(\{ text: nus\.platform === 'darwin' \? 'Hoops needs motion\. Turn off Reduce motion/);
  assert.match(r, /'Hoops needs motion\. Turn on Animation effects in Settings > Accessibility > Visual effects to play\.'/);
});
