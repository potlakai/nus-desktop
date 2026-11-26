// The Knot engine: the body, its one thread, and how they move.
//
// This is the approved motion playground (docs/knot-playground.html) ported
// into the Companion: the same body renderer, springs, gesture curves, thread
// paths and moves, with every number read from knot-spec.js. The playground's
// page, buttons and fake targets are gone; the host (renderer.js) drives it
// through two handles, `knot` and `thread`.
//
// What differs from the playground, on purpose:
//   - Springs snap to rest, unit() is guarded and a bad frame can never stop
//     the loop. The playground lost its Knot for good about a minute after
//     any lean (the springs underflowed, the geometry went NaN, the loop died).
//   - A state change never cancels a gesture, and a replaced gesture hands
//     its leftover offset on instead of snapping.
//   - Moves run on wall-clock time, so a stalled frame cannot stretch them.
//   - Step to step the tip swings from A to B; it does not go home first.
//   - The thread canvas is sized once per path and is not drawn at all while
//     a surface is held open.
//   - The character decided 2026-11-02 (character block in knot-spec.js): one
//     curve in three poses, flat infinity at rest, trefoil thinking, a loose
//     loop with a tail when active, white with an ink outline.
//   - The colour decided 2026-11-03 (character.accent): white at rest and asleep,
//     a lap of colour and a thin core while it is doing something, with a soft
//     glow behind that follows the strand's own shape.
(() => {
  'use strict';
  const S = window.NusKnotSpec;
  if (!S) return;
  const { SPEC, inline: IN, host: HOST, character: CH, PARAMS, clamp, smooth, bezierEase, hexRgb } = S;
  const TAU = Math.PI * 2, EPS = 1e-6;

  const mix = (a, b, u) => a + (b - a) * u;
  const vec = (x, y) => ({ x, y });
  const add = (a, b) => vec(a.x + b.x, a.y + b.y);
  const sub = (a, b) => vec(a.x - b.x, a.y - b.y);
  const mul = (a, s) => vec(a.x * s, a.y * s);
  const lerp = (a, b, u) => vec(mix(a.x, b.x, u), mix(a.y, b.y, u));
  const length = (a) => Math.hypot(a.x, a.y);
  // Guarded: a zero or denormal vector has no direction. Dividing by its
  // length is what turned the playground's whole body into NaN.
  const unit = (a, fallback) => {
    const l = length(a);
    return l > EPS && Number.isFinite(l) ? vec(a.x / l, a.y / l) : (fallback || vec(0, 0));
  };
  const rgbOf = (c) => 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')';

  // ---- paths (the playground's, unchanged) --------------------------------
  function cubic(a, c1, c2, b, t) {
    const r = 1 - t;
    return vec(r * r * r * a.x + 3 * r * r * t * c1.x + 3 * r * t * t * c2.x + t * t * t * b.x,
      r * r * r * a.y + 3 * r * r * t * c1.y + 3 * r * t * t * c2.y + t * t * t * b.y);
  }
  // A cubic bowed toward the screen centre.
  function bowedPath(a, b, centre) {
    const B = IN.thread.bow, n = IN.thread.samples;
    const d = sub(b, a), mid = lerp(a, b, .5);
    const bow = mul(unit(sub(centre, mid)), Math.min(B.max, length(d) * B.perDistance));
    const c1 = add(add(a, mul(d, B.c1)), mul(bow, B.weight)), c2 = add(add(a, mul(d, B.c2)), mul(bow, B.weight));
    const out = new Array(n + 1);
    for (let i = 0; i <= n; i++) out[i] = cubic(a, c1, c2, b, i / n);
    return out;
  }
  function pathTable(points) {
    let total = 0; const lengths = [0];
    for (let i = 1; i < points.length; i++) { total += length(sub(points[i], points[i - 1])); lengths.push(total); }
    return { points, lengths, total };
  }
  function pathAt(path, distance) {
    const d = clamp(distance, 0, path.total); let i = 1;
    while (i < path.lengths.length - 1 && path.lengths[i] < d) i++;
    return lerp(path.points[i - 1], path.points[i], (d - path.lengths[i - 1]) / (path.lengths[i] - path.lengths[i - 1] || 1));
  }
  function prefix(path, u) {
    const d = path.total * clamp(u), out = [path.points[0]];
    for (let i = 1; i < path.points.length && path.lengths[i] < d; i++) out.push(path.points[i]);
    out.push(pathAt(path, d));
    return out;
  }
  // Two polylines of different lengths, blended point for point.
  function blendPoints(a, b, k) {
    const n = Math.max(a.length, b.length), out = new Array(n);
    for (let i = 0; i < n; i++) {
      const f = n > 1 ? i / (n - 1) : 0;
      out[i] = lerp(a[Math.min(a.length - 1, Math.round(f * (a.length - 1)))], b[Math.min(b.length - 1, Math.round(f * (b.length - 1)))], k);
    }
    return out;
  }
  // Rounded rectangle that starts and ends at the tip. The playground's tip is
  // always on the bottom edge; a bubble that sits below the Knot has its tip on
  // the top edge, so that case is the same outline mirrored.
  function roundedOutline(f, r) {
    const A = IN.surface, left = f.x, right = f.x + f.w, top = f.y, bottom = f.y + f.h;
    const flip = Math.abs(f.tip.y - top) < Math.abs(f.tip.y - bottom), mirror = (y) => (flip ? top + bottom - y : y);
    const pts = [vec(f.tip.x, mirror(f.tip.y))];
    const steps = A.outlineArc;
    const line = (x, y) => pts.push(vec(x, y));
    const arc = (cx, cy, a, b) => { for (let i = 1; i <= steps; i++) { const t = mix(a, b, i / steps); line(cx + r * Math.cos(t), cy + r * Math.sin(t)); } };
    if (f.tip.x <= f.x + f.w / 2) {
      line(right - r, bottom); arc(right - r, bottom - r, Math.PI / 2, 0); line(right, top + r); arc(right - r, top + r, 0, -Math.PI / 2);
      line(left + r, top); arc(left + r, top + r, -Math.PI / 2, -Math.PI); line(left, bottom - r); arc(left + r, bottom - r, Math.PI, Math.PI / 2);
    } else {
      line(left + r, bottom); arc(left + r, bottom - r, Math.PI / 2, Math.PI); line(left, top + r); arc(left + r, top + r, Math.PI, Math.PI * 1.5);
      line(right - r, top); arc(right - r, top + r, Math.PI * 1.5, Math.PI * 2); line(right, bottom - r); arc(right - r, bottom - r, 0, Math.PI / 2);
    }
    line(f.tip.x, mirror(f.tip.y));
    if (flip) for (const p of pts) p.y = mirror(p.y);
    return pathTable(pts);
  }

  function mount(opts = {}) {
    const body = opts.body;
    const bctx = body && body.getContext('2d');
    if (!bctx) return null;
    const strand = opts.thread || null;
    const sctx = strand ? strand.getContext('2d') : null;
    const hooks = Object.assign({ onArrive() {}, onRewound() {}, onGestureEnd() {}, cue() {}, place() {}, onError() {} }, opts.hooks || {});
    const G = CH.geometry, C = G.size / 2;
    const nowMs = () => performance.now();
    const viewport = () => ({ w: window.innerWidth || 0, h: window.innerHeight || 0 });
    const centre = () => { const v = viewport(); return vec(v.w / 2, v.h / 2); };

    const mq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    let reduced = !!(mq && mq.matches) || /motion=reduce/.test(String(window.location && window.location.search));

    let state = 'idle', stateStart = nowMs() / 1000;
    let phase = 0;
    let gesture = null;      // { name, start, direction }
    let residual = null;     // leftover deltas from a replaced gesture, fading out
    let thread = null;       // the one thread: reach, tap, point, perch, rewind
    let travel = null;       // the whole Knot relocating
    let burst = null;        // three short lines at the tip as a surface opens
    let trace = null;        // the intro: the tip draws the bubble's outline
    let mark = null;         // the region mark: a rounded rectangle the Knot draws round an area
    let held = false;        // a surface is open on the thread
    let frozen = false, freezePose = null, freezePoints = null, frozenThread = null;
    let overrides = {};
    let voiceLevel = null, micLevel = 0, micShown = 0;
    let beat = null;         // a gesture's moment of colour: { colour, until }
    // What the strand is wearing. out = it is on its way back to white.
    const tint = { name: null, rgb: null, start: 0, from: null, glowFrom: null, out: null };
    let pointer = null, drag = null, fileHover = null;
    let asleep = false, paused = false, raf = 0, lastTick = nowMs(), nextDue = 0, wasFast = false, lastRaf = 0, period = 0;
    // Battery saver (2026-11-07, measured on a Ryzen 4700U laptop on battery):
    // every drawn frame repaints the full-screen overlay, about 20% of a core
    // plus 16% of the GPU at 60 a second. On battery, states that only breathe
    // (listening, thinking, speaking) draw at the rest rate; the hand-driven and
    // big motions (drag, flight, gestures, file hover) keep the full rate.
    let lowPower = false;
    let bodyDPR = 1, strandDPR = 1;
    let posCache = null; let posScale = 1;
    let drewQuiet = false, quietTimer = 0;
    let hoverY = 0, hoverPhase = 0, hoverAmp = 0, hoverRate = CH.states.idle.hover[1], hoverBreath = 0, hoverShown = '';
    let backdrop = 0;
    let threadShown = false, threadDirty = false, bounds = null;
    const counters = { body: 0, thread: 0, errors: 0, frames: 0, calls: 0 };

    const springs = Object.fromEntries(PARAMS.map((k) => [k, { x: CH.states.idle.pose[k], v: 0 }]));
    const SHAPES = Object.keys(CH.springs), THIRD = TAU / 3;
    const TOWARD = unit(vec(CH.loose.toward[0], CH.loose.toward[1]));
    const shape = Object.fromEntries(SHAPES.map((k) => [k, { x: 0, v: 0 }]));
    shape.flat.x = CH.states.idle.shape.flat; shape.tail.x = CH.loose.rest; shape.mirror.x = 1;
    let spin = 0, spinV = 0, spinGoal = null, lobeTurn = 0, tailReady = 1, stretchDir = vec(1, 0);
    let lastPos = null, motionV = vec(0, 0), motionSpeed = 0, motionTrail = null, wavePhase = 0;
    const eased = { speed: 1 };

    // ---- where the Knot is ------------------------------------------------
    function position() {
      if (posCache) return posCache;
      const r = body.getBoundingClientRect();
      const o = body.parentElement && body.parentElement.getBoundingClientRect ? body.parentElement.getBoundingClientRect() : r;
      posCache = vec(o.left + o.width / 2, o.top + o.height / 2);
      // Drawn smaller or bigger than its 116 px frame (--knot-scale, the island
      // pill), the seam moves with the drawing: scale the tail's offset to match.
      posScale = r.width > 0 ? r.width / G.size : 1;
      return posCache;
    }
    // The Knot as drawn, hover included.
    function shownPosition() { const p = position(); return vec(p.x, p.y + hoverY); }
    function resizeBody() {
      // Always at least twice the screen's pixels, so the line is clean on a plain 1x monitor.
      bodyDPR = Math.max(CH.look.supersample, Math.min(IN.body.dprMax, window.devicePixelRatio || 1));
      const px = Math.round(G.size * bodyDPR);
      if (body.width !== px || body.height !== px) { body.width = px; body.height = px; }
    }

    // ---- gestures ---------------------------------------------------------
    function rawGestureDeltas(t) {
      const out = Object.fromEntries(PARAMS.map((k) => [k, 0]));
      if (!gesture) return out;
      const g = SPEC.gestures[gesture.name], u = clamp((t - gesture.start) / g.duration);
      let i = 1; while (i < g.keys.length - 1 && g.keys[i][0] < u) i++;
      const a = g.keys[i - 1], b = g.keys[i], v = (u - a[0]) / (b[0] - a[0] || 1);
      const e = g.linearFirst && i === 1 ? v : smooth(v);
      for (const k of PARAMS) out[k] = mix(a[1][k] || 0, b[1][k] || 0, e);
      if (gesture.name === 'poke') { out.leanX *= -gesture.direction.x; out.leanY *= -gesture.direction.y; }
      return out;
    }
    function gestureDeltas(t) {
      const out = rawGestureDeltas(t);
      if (reduced) { for (const k of PARAMS) out[k] = 0; return out; }
      if (residual) {
        const f = 1 - smooth((t - residual.start) / (HOST.gestureHandoffMs / 1000));
        if (f > 0) for (const k of PARAMS) out[k] += residual.deltas[k] * f;
      }
      return out;
    }
    function playGesture(name, o) {
      const g = SPEC.gestures[name];
      if (!g) return false;
      if (name === 'sleep') { sleep(); return true; }
      if (state === 'sleeping' || asleep) wakeQuietly();
      startBeat(name);
      if (reduced) { requestDraw(); return false; }
      const t = nowMs() / 1000;
      // Whatever offset is on screen right now fades out under the new gesture.
      const left = gestureDeltas(t);
      residual = PARAMS.some((k) => Math.abs(left[k]) > 1e-4) ? { deltas: left, start: t } : null;
      const dir = o && (o.dx || o.dy) ? unit(vec(Number(o.dx) || 0, Number(o.dy) || 0), vec(0, -1)) : vec(0, -1);
      gesture = { name, start: t, direction: dir };
      requestDraw();
      return true;
    }

    // ---- pose -------------------------------------------------------------
    function stateTarget(t) {
      const p = Object.assign({}, CH.states[state].pose), L = IN.lean;
      const pos = position();
      if (state === 'reading') { const dir = unit(sub(centre(), pos)); p.leanX = dir.x * L.reading; p.leanY = dir.y * L.reading; }
      if (state === 'listening' && pointer && length(sub(pointer, pos)) > L.listeningMinDistance) {
        const dir = unit(sub(pointer, pos)); p.leanX += dir.x * L.listening; p.leanY += dir.y * L.listening;
      }
      if (state === 'listening' && micLevel > 0) p.scale += micLevel * CH.loose.micPulse;
      if (state === 'speaking' && !reduced) {
        const Sp = IN.speaking;
        const level = voiceLevel === null ? Math.max(0, Math.sin(t * Sp.rateA) * Math.sin(t * Sp.rateB)) * Sp.gain : clamp(voiceLevel);
        // A held surface keeps the body's shape still.
        if (!frozen) { p.scale += level * Sp.scale; p.squash += level * Sp.squash; }
      }
      if (thread) p.unravel = thread.u;
      // The small pen: on the way to a region and while drawing it, 55 percent.
      p.scale *= penScale();
      if (fileHover) {
        const d = sub(fileHover, pos), dir = unit(d), near = clamp(length(d) / 60);
        p.scale += IN.fileHover.scale; p.squash += IN.fileHover.squash;
        p.leanX = dir.x * L.fileHover * near; p.leanY = dir.y * L.fileHover * near;
      }
      return Object.assign(p, overrides);
    }
    function integrate(dt, t) {
      const target = stateTarget(t), steps = Math.max(1, Math.ceil(dt * 120)), h = dt / steps, snap = HOST.springSnap;
      for (let i = 0; i < steps; i++) for (const k of PARAMS) {
        const s = springs[k], [stiff, damp] = SPEC.springs[k];
        s.v += (stiff * (target[k] - s.x) - damp * s.v) * h; s.x += s.v * h;
      }
      integrateShape(dt, t);
      for (const k of PARAMS) {
        const s = springs[k];
        // At rest means at rest. Without this the value decays toward zero
        // forever, underflows, and takes the geometry with it.
        if (!Number.isFinite(s.x) || !Number.isFinite(s.v) || (Math.abs(target[k] - s.x) < snap.x && Math.abs(s.v) < snap.v)) { s.x = target[k]; s.v = 0; }
      }
      const e = 1 - Math.exp(-SPEC.stateEase * dt);
      eased.speed = mix(eased.speed, SPEC.states[state].motion[0], e);
    }
    function effectivePose(t) {
      const delta = gestureDeltas(t), p = {};
      for (const k of PARAMS) p[k] = springs[k].x + delta[k];
      p.unravel = clamp(p.unravel); p.straighten = clamp(p.straighten);
      return p;
    }
    function resetSprings(t) {
      const target = stateTarget(t);
      for (const k of PARAMS) { springs[k].x = Number.isFinite(target[k]) ? target[k] : CH.states.idle.pose[k]; springs[k].v = 0; }
      const goal = shapeTargets();
      for (const k of SHAPES) { shape[k].x = goal[k]; shape[k].v = 0; }
      spin = 0; spinV = 0; spinGoal = null; lobeTurn = 0; tailReady = 1;
    }

    // ---- the shape: one curve, three poses --------------------------------
    // flat (the infinity), face (the trefoil seen straight on) and loose (one
    // lobe drawn out into the tail) are weights on the same points. tail is how
    // long the tail is, aim which way the whole loop faces, slack how far it has
    // unravelled for the lasso, stretch how much speed pulls it out of round.
    function shapeTargets() {
      const st = CH.states[state].shape, Lo = CH.loose, line = thread && !thread.silent;
      const M = CH.motion, out = !!(thread || travel);
      // Pulled along by the hand, the strand draws out behind it, then ties back up.
      const pulled = drag ? clamp(motionSpeed / M.dragTailAt) : 0;
      const lag = clamp(motionSpeed * M.lagPer, 0, M.lagMax), lagDir = motionSpeed > 1 ? mul(motionV, -1 / motionSpeed) : vec(0, 0);
      let slack = 0;
      if (line && thread.lasso) slack = thread.phase === 'lasso' ? thread.u : thread.u * CH.unravel.hold;
      else if (mark && mark.phase === 'draw') slack = mark.u * CH.unravel.hold;
      return {
        flat: out ? 0 : st.flat * (1 - pulled), face: out ? 0 : st.face * (1 - pulled), loose: out ? 1 : Math.max(st.loose, pulled),
        tail: (line ? Lo.reach : travel || pulled ? Lo.flight : Lo.rest) * penScale(),
        mirror: side(), aim: aimTarget(), slack, stretch: Math.min(CH.flight.stretchMax, motionSpeed * CH.flight.stretchPer),
        lagX: lagDir.x * lag, lagY: lagDir.y * lag, ripple: clamp(motionSpeed / M.rippleFull),
      };
    }
    // Which way the tail wants to point, as a turn away from its drawn direction.
    // On the right half of the screen it is the picture mirrored, so the tail
    // reaches inward with the loop on the outside, the same as on the left.
    let lastSide = 1;
    function side() { if (!drag) lastSide = (travel ? travel.to : position()).x <= centre().x ? 1 : -1; return lastSide; }
    function aimDirection() {
      const pos = position();
      if (thread && !thread.silent) return unit(sub(thread.lasso ? thread.lasso.start : thread.destination, pos), TOWARD);
      if ((travel || drag) && motionTrail) return motionTrail;
      if (state === 'listening' && pointer && length(sub(pointer, pos)) > IN.lean.listeningMinDistance) return unit(sub(pointer, pos), TOWARD);
      // At rest it faces into the screen, never off the edge it lives by.
      const c = centre();
      return unit(vec(side() * TOWARD.x, (pos.y >= c.y ? 1 : -1) * TOWARD.y), TOWARD);
    }
    function aimTarget() {
      const d = aimDirection(), angle = Math.atan2(d.y, d.x) - Math.atan2(TOWARD.y, side() * TOWARD.x);
      return angle + TAU * Math.round((shape.aim.x - angle) / TAU);
    }
    // How fast the Knot is really going, whatever is moving it: a flight, the hand.
    function trackMotion(dt) {
      const M = CH.motion, pos = position();
      if (lastPos && dt > 0) {
        const step = sub(pos, lastPos), k = 1 - Math.exp(-M.smooth * dt);
        // A jump (a corner picked, the screen changed) is not speed.
        const v = length(step) > M.jump ? vec(0, 0) : mul(step, 1 / dt);
        motionV = vec(mix(motionV.x, v.x, k), mix(motionV.y, v.y, k));
        if (Math.abs(motionV.x) + Math.abs(motionV.y) < 1) motionV = vec(0, 0);
      }
      lastPos = pos;
      motionSpeed = length(motionV);
      if (motionSpeed > CH.flight.trailMin) { motionTrail = mul(unit(motionV), -1); stretchDir = unit(motionV, stretchDir); }
      if (shape.ripple.x > .001) wavePhase = (wavePhase + dt * M.waveRate) % (TAU * 64);
    }
    function integrateShape(dt, t) {
      trackMotion(dt);
      const steps = Math.max(1, Math.ceil(dt * 120)), h = dt / steps, goal = shapeTargets(), snap = HOST.springSnap;
      for (let i = 0; i < steps; i++) for (const k of SHAPES) {
        const q = shape[k], [stiff, damp] = CH.springs[k];
        q.v += (stiff * (goal[k] - q.x) - damp * q.v) * h; q.x += q.v * h;
      }
      for (const k of SHAPES) {
        const q = shape[k];
        if (!Number.isFinite(q.x) || !Number.isFinite(q.v) || (Math.abs(goal[k] - q.x) < snap.x && Math.abs(q.v) < snap.v)) { q.x = goal[k]; q.v = 0; }
      }
      // The facing angle only shows through the tail (bodyPoints: turn = aim x tail),
      // so with the tail all the way in or all the way out a whole turn of it changes
      // nothing on screen. Drop whole turns there. Kept, they piled up turn by turn
      // while the Knot was dragged in circles or thrown around in a game, and the next
      // time the tail wound in or out (a click, a drop, the flight home) it unwound
      // every one of them in a fraction of a second: the "fast spin" (2026-11-16).
      {
        const shown = smooth(Math.min(clamp(shape.loose.x, 0, 1.05) * smooth(tailReady), 1));
        if ((shown < 1e-3 || shown > 1 - 1e-3) && Math.abs(shape.aim.x) > Math.PI) shape.aim.x -= TAU * Math.round(shape.aim.x / TAU);
      }
      integrateSpin(dt);
      // Coming out of a spin the tail waits until the turn has nearly landed, so
      // the lobe it grows from is already on its side of the body. Eased, so an
      // interruption at any moment never snaps it.
      // (Going into a spin nothing changes: the tail draws in on its own spring.)
      const ready = spinGoal !== null ? 1 - clamp(Math.abs(spinGoal - spin) / (THIRD * CH.spin.waitFor)) : !spinV ? 1 : shape.loose.x < .02 ? 0 : tailReady;
      tailReady = Math.abs(ready - tailReady) < 1e-3 ? ready : mix(tailReady, ready, 1 - Math.exp(-CH.spin.waitEase * dt));
    }
    // A trefoil turned a third of a turn is the identical shape, with its points
    // moved along by a third. So when the spin ends it eases forward to the next
    // third, and the tail comes out of the same place on the screen every time.
    function integrateSpin(dt) {
      const P = CH.spin, rate = thread || travel ? 0 : CH.states[state].spin;
      if (rate) {
        spinGoal = null;
        spinV += (rate - spinV) * (1 - Math.exp(-P.ease * dt));
        spin += spinV * dt;
        return;
      }
      if (spinGoal === null) {
        if (!spinV && spin === 0) return;
        // Forward from where it is heading. While a tail is still out, only a
        // third that keeps the same lobe under it will do.
        let m = Math.ceil((spin + Math.max(0, spinV) * P.lead) / THIRD - 1e-6);
        if (clamp(shape.loose.x) > .01) while (((m % 3) + 3) % 3 !== lobeTurn) m++;
        lobeTurn = ((m % 3) + 3) % 3;
        spinGoal = m * THIRD;
      }
      const steps = Math.max(1, Math.ceil(dt * 120)), h = dt / steps;
      for (let i = 0; i < steps; i++) { spinV += (P.stiff * (spinGoal - spin) - P.damp * spinV) * h; spin += spinV * h; }
      // Back at a third: the same curve with its points relabelled, so this is no jump.
      if (Math.abs(spinGoal - spin) < 1e-4 && Math.abs(spinV) < 1e-3) { spin = 0; spinV = 0; spinGoal = null; lobeTurn = 0; }
    }
    // Any shape spring still on its way: the frame rate stays up until it lands.
    function poseMoving() {
      for (const k of PARAMS) if (springs[k].v !== 0) return true;
      return false;
    }
    function shapeMoving() {
      for (const k of SHAPES) if (shape[k].v !== 0) return true;
      return spinV !== 0;
    }

    // ---- body geometry ----------------------------------------------------
    function trefoil(t) { return { x: Math.sin(t) + 2 * Math.sin(2 * t), y: Math.cos(t) - 2 * Math.cos(2 * t), z: -Math.sin(3 * t) }; }
    const tailLobe = () => (CH.loose.lobe + lobeTurn) % 3;
    const tailIndex = () => tailLobe() * G.samples / 3 + G.samples / 6;
    // The lobe's two legs run out and meet at the tip, a hair apart: a closed stem.
    function stemPath(a, b, tip) {
      const m = lerp(a, b, .5), d = sub(tip, m), l = length(d) || 1, u = mul(d, 1 / l), n = vec(-u.y, u.x);
      const side = Math.sign((a.x - b.x) * n.x + (a.y - b.y) * n.y) || 1, half = mul(n, side * CH.loose.stem / 2);
      const pa = add(tip, half), pb = sub(tip, half), pts = [];
      const c1 = add(a, mul(u, l * .35)), c2 = sub(pa, mul(u, l * .3)), c3 = sub(pb, mul(u, l * .3)), c4 = add(b, mul(u, l * .35));
      for (let i = 0; i <= 24; i++) pts.push(cubic(a, c1, c2, pa, i / 24));
      for (let i = 0; i <= 24; i++) pts.push(cubic(pb, c3, c4, b, i / 24));
      return pathTable(pts);
    }
    function drawOutTail(points, lo, toward) {
      const Lo = CH.loose, third = G.samples / 3, i0 = tailLobe() * third;
      // The tail grows out of the lobe's own apex, wherever the lobe is right now,
      // and swings round to its direction as it comes out. So the lobe never has
      // to cross the body, whatever moment the spin was at.
      const apex = points[i0 + third / 2], reach = length(apex), out = clamp(lo);
      const towardAngle = Math.atan2(toward.y, toward.x);
      let swing = Math.atan2(apex.y, apex.x) - towardAngle;
      swing -= TAU * Math.round(swing / TAU);
      const at = towardAngle + swing * (1 - smooth(out)), dir = vec(Math.cos(at), Math.sin(at));
      const tip = mul(dir, mix(reach, shape.tail.x, out)), path = stemPath(points[i0], points[i0 + third], tip);
      // Moving, a wave runs down the tail to its tip. Both legs share it, so the
      // tail stays one tail.
      const M = CH.motion, whip = shape.ripple.x * M.whip, across = vec(-dir.y, dir.x);
      for (let i = i0; i <= i0 + third; i++) {
        const u = (i - i0) / third, k = lo * smooth(Math.min(u, 1 - u) / Lo.edge), q = pathAt(path, path.total * u), o = points[i];
        if (whip > .01) { const d = 1 - Math.abs(u - .5) * 2, wave = Math.sin(d * M.whipWaves * TAU - wavePhase) * d * whip; q.x += across.x * wave; q.y += across.y * wave; }
        o.x = mix(o.x, q.x, k); o.y = mix(o.y, q.y, k); o.z = mix(o.z, .3, k); o.w = mix(1, mix(Lo.width, Lo.tipWidth, 1 - Math.abs(u - .5) * 2), k); o.persp = mix(o.persp, 1, k);
      }
    }
    // The line has to come from somewhere: the lobe beside the tail draws in, as
    // if the strand were being pulled out of the knot, and the whole body gives
    // a little. It ties back up as the line comes home.
    function loosen(points, slack) {
      const U = CH.unravel, third = G.samples / 3, i0 = ((tailLobe() + 2) % 3) * third, a = points[i0], b = points[i0 + third];
      for (let i = i0 + 1; i < i0 + third; i++) {
        const u = (i - i0) / third, k = slack * U.depth * smooth(Math.min(u, 1 - u) / .28), o = points[i];
        o.x = mix(o.x, mix(a.x, b.x, u), k); o.y = mix(o.y, mix(a.y, b.y, u), k);
      }
      const g = 1 - slack * U.shrink;
      for (const o of points) { o.x *= g; o.y *= g; }
    }
    // Slack moving along the line: a small wave sideways, travelling round the loop.
    function rippleAlong(points, amp) {
      const N = G.samples, waves = CH.motion.rippleWaves, ox = new Float64Array(N), oy = new Float64Array(N);
      for (let i = 0; i < N; i++) {
        const a = points[(i + N - 1) % N], b = points[(i + 1) % N], n = unit(vec(a.y - b.y, b.x - a.x)), w = Math.sin(i / N * TAU * waves - wavePhase) * amp;
        ox[i] = n.x * w; oy[i] = n.y * w;
      }
      for (let i = 0; i < N; i++) { points[i].x += ox[i]; points[i].y += oy[i]; }
    }
    function bodyPoints(p) {
      const B = IN.body, F = CH.flat, N = G.samples, fov = SPEC.geometry.fov;
      const fc = clamp(shape.face.x), fl = clamp(shape.flat.x), lo = clamp(shape.loose.x, 0, 1.05) * smooth(tailReady);
      const tumble = B.tumbleBase + Math.sin(phase * B.tumbleRate) * B.tumbleAmp;
      const rx = mix(tumble * B.rotX, 0, fc) + fl * F.tilt, ry = mix(tumble * B.rotY, 0, fc);
      const cx = Math.cos(rx), sx = Math.sin(rx), cy = Math.cos(ry), sy = Math.sin(ry), cz = Math.cos(spin), sz = Math.sin(spin);
      // Changing sides it really turns over in space: half a turn about the upright,
      // so midway it shows its depth, and it arrives as the exact mirror picture.
      const over = (1 - clamp(shape.mirror.x, -1, 1)) / 2 * Math.PI, co = Math.cos(over), so = Math.sin(over);
      const wide = p.scale * (1 + p.squash + fl * F.squash), tall = p.scale * (1 - p.squash - fl * F.squash) * mix(1, F.thin, fl);
      const points = new Array(N + 1);
      for (let i = 0; i <= N; i++) {
        const s = i / N, q = trefoil(s * TAU), x = q.x / 3, y = q.y / 3, z = q.z / 1.2;
        const x0 = x * cz - y * sz, y0 = x * sz + y * cz;
        const x1 = x0 * cy + z * sy, z1 = -x0 * sy + z * cy, y1 = y0 * cx - z1 * sx, z2 = y0 * sx + z1 * cx, persp = fov / (fov - z2 * B.depth);
        const px = (x1 * co + z2 * so) * G.radius * persp, py = y1 * G.radius * persp;
        points[i] = { x: px * wide + p.leanX * py, y: py * tall + p.leanY * B.leanYShift, z: z2 * co - x1 * so, persp, t: s, w: 1 };
      }
      if (lo > .002) drawOutTail(points, lo, unit(vec(TOWARD.x * co, TOWARD.y), TOWARD));
      if (shape.slack.x > .002) loosen(points, clamp(shape.slack.x));
      // The whole loop turns to face where the tail goes; speed draws it out.
      const turn = shape.aim.x * smooth(Math.min(lo, 1)), ca = Math.cos(turn), sa = Math.sin(turn), k = shape.stretch.x, dx = stretchDir.x, dy = stretchDir.y;
      for (const o of points) {
        const rxp = o.x * ca - o.y * sa, ryp = o.x * sa + o.y * ca;
        const along = rxp * dx + ryp * dy, across = -rxp * dy + ryp * dx, la = along * (1 + k), lc = across * (1 - k * .5);
        // The far parts of the strand lag behind the middle, and swing on past it
        // when it stops, on an underdamped spring: weight, like a real thread.
        const wx = la * dx - lc * dy, wy = la * dy + lc * dx, reachOut = clamp(Math.hypot(wx, wy) / CH.motion.lagReach, 0, 1.4);
        o.x = C + wx + shape.lagX.x * reachOut; o.y = C + wy + shape.lagY.x * reachOut;
      }
      if (shape.ripple.x > .002) rippleAlong(points, shape.ripple.x * CH.motion.ripple);
      points[N].x = points[0].x; points[N].y = points[0].y; points[N].z = points[0].z; points[N].w = points[0].w; points[N].persp = points[0].persp;
      return points;
    }
    const allFinite = (pts) => { for (let i = 0; i < pts.length; i++) if (!Number.isFinite(pts[i].x) || !Number.isFinite(pts[i].y)) return false; return true; };
    function tailAnchor(p) {
      const pts = freezePoints || bodyPoints(p), a = pts[tailIndex()], pos = shownPosition();
      return vec(pos.x + (a.x - C) * posScale, pos.y + (a.y - C) * posScale);
    }
    // Where the tail's tip will sit once it is fully out toward a destination.
    function predictedAnchor(destination) {
      const pos = shownPosition();
      return add(pos, mul(unit(sub(destination, pos), TOWARD), CH.loose.reach * posScale));
    }

    // ---- the thread -------------------------------------------------------
    // The point on the (slightly grown) target box nearest the Knot: the tip
    // stops there, just short of the control it is pointing at.
    function targetAnchor(rect, from) {
      const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
      const hw = rect.w / 2 + HOST.tipGap, hh = rect.h / 2 + HOST.tipGap;
      let ux = from.x - cx, uy = from.y - cy;
      const d = Math.hypot(ux, uy) || 1; ux /= d; uy /= d;
      const tx = Math.abs(ux) > 1e-4 ? hw / Math.abs(ux) : Infinity, ty = Math.abs(uy) > 1e-4 ? hh / Math.abs(uy) : Infinity;
      const k = Math.max(0, Math.min(tx, ty, d - 4));
      return vec(cx + ux * k, cy + uy * k);
    }
    function layPath(destination) {
      return pathTable(bowedPath(predictedAnchor(destination), destination, centre()));
    }
    function basePoints(th) {
      const points = prefix(th.path, th.u), anchor = tailAnchor(effectivePose(nowMs() / 1000));
      // Blend the first samples to the live seam; the target end stays fixed.
      const offset = sub(anchor, points[0]), n = IN.thread.seamBlend;
      for (let i = 0; i < points.length; i++) points[i] = add(points[i], mul(offset, 1 - smooth(i / n)));
      return points;
    }
    function threadPoints(t) {
      if (!thread) return [];
      if (frozenThread) return frozenThread;
      if (thread.lasso) return lassoPoints(thread, t);
      let points = basePoints(thread);
      if (thread.old) {
        const k = smooth((t - thread.blendStart) / (HOST.retargetMs / 1000));
        if (k >= 1) thread.old = null; else points = blendPoints(thread.old, points, k);
      }
      if (thread.phase === 'tap') {
        const u = clamp((t - thread.phaseStart) / SPEC.moves.tap), last = points[points.length - 1];
        points[points.length - 1] = vec(last.x, last.y + Math.sin(u * Math.PI) * SPEC.moves.tapPixels);
      }
      if (thread.curl && (thread.curlU || 0) > 0) { const curl = prefix(thread.curlTable, thread.curlU); for (let i = 1; i < curl.length; i++) points.push(curl[i]); }
      if (trace && trace.phase === 'draw') { const tr = prefix(trace.path, trace.u); for (let i = 1; i < tr.length; i++) points.push(tr[i]); }
      return points;
    }
    function snapshotThread(t) { return threadPoints(t).map((p) => vec(p.x, p.y)); }

    // One canvas, sized to the path once. It only grows while a thread is out.
    function growBounds(points, extra) {
      if (!strand) return;
      const pad = IN.thread.pad, pos = position();
      let x0 = pos.x - C, y0 = pos.y - C, x1 = pos.x + C, y1 = pos.y + C;
      for (const p of points) { if (p.x < x0) x0 = p.x; if (p.y < y0) y0 = p.y; if (p.x > x1) x1 = p.x; if (p.y > y1) y1 = p.y; }
      if (extra) { x0 = Math.min(x0, extra.x0); y0 = Math.min(y0, extra.y0); x1 = Math.max(x1, extra.x1); y1 = Math.max(y1, extra.y1); }
      x0 = Math.floor(x0 - pad); y0 = Math.floor(y0 - pad); x1 = Math.ceil(x1 + pad); y1 = Math.ceil(y1 + pad);
      if (bounds) { x0 = Math.min(x0, bounds.x); y0 = Math.min(y0, bounds.y); x1 = Math.max(x1, bounds.x + bounds.w); y1 = Math.max(y1, bounds.y + bounds.h); }
      const v = viewport();
      x0 = Math.max(0, x0); y0 = Math.max(0, y0); if (v.w) x1 = Math.min(v.w, x1); if (v.h) y1 = Math.min(v.h, y1);
      const next = { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
      if (bounds && next.x === bounds.x && next.y === bounds.y && next.w === bounds.w && next.h === bounds.h) return;
      bounds = next;
      strandDPR = Math.max(IN.thread.dprMax, Math.min(CH.look.supersample, window.devicePixelRatio || 1));
      strand.width = Math.ceil(bounds.w * strandDPR); strand.height = Math.ceil(bounds.h * strandDPR);
      strand.style.left = bounds.x + 'px'; strand.style.top = bounds.y + 'px';
      strand.style.width = bounds.w + 'px'; strand.style.height = bounds.h + 'px';
      threadDirty = true;
    }
    function targetExtent(rect) {
      if (!rect) return null;
      const ring = Math.max(14, Math.hypot(rect.w, rect.h) / 2 + 8) * 1.06, cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
      return { x0: Math.min(rect.x - 6, cx - ring), y0: Math.min(rect.y - 6, cy - ring), x1: Math.max(rect.x + rect.w + 6, cx + ring), y1: Math.max(rect.y + rect.h + 6, cy + ring) };
    }

    function startThread(kind, destination, o = {}) {
      const t = nowMs() / 1000;
      if (state === 'sleeping' || asleep) wakeQuietly();
      unfreeze();
      posCache = null;
      const dest = vec(destination.x, destination.y);
      if (reduced) {
        thread = { kind, destination: dest, path: null, u: 1, phase: 'hold', phaseStart: t, holdStart: t, target: o.target || null, onArrive: null, onDone: o.onDone || null, curl: o.curl || null, curlTable: o.curl ? pathTable(o.curl) : null, curlU: o.curl ? 1 : 0, corner: o.corner || null };
        thread.path = layPath(dest);
        bounds = null; growBounds(thread.path.points.concat(o.curl || []), targetExtent(thread.target));
        requestDraw();
        if (kind === 'surface') { if (o.onArrive) o.onArrive(); } else hooks.onArrive();
        return true;
      }
      if (thread) {
        // Already out (pointing, reaching, or on its way home): the tip swings
        // to the new place. It never goes home and starts again.
        const old = snapshotThread(t), homing = thread.phase === 'rewind' || thread.phase === 'uncurl';
        const from = thread.u, wasHold = !homing && from >= .999;
        thread = { kind, destination: dest, path: null, u: wasHold ? 1 : from, reachFrom: from, phase: wasHold ? 'swing' : 'reach', phaseStart: t, holdStart: t, target: o.target || null, onArrive: o.onArrive || null, onDone: o.onDone || null, curl: o.curl || null, curlTable: o.curl ? pathTable(o.curl) : null, curlU: 0, corner: o.corner || null, old, blendStart: t };
      } else {
        bounds = null;
        thread = { kind, destination: dest, path: null, u: 0, reachFrom: 0, phase: 'reach', phaseStart: t, holdStart: t, target: o.target || null, onArrive: o.onArrive || null, onDone: o.onDone || null, curl: o.curl || null, curlTable: o.curl ? pathTable(o.curl) : null, curlU: 0, corner: o.corner || null, old: null, blendStart: t };
      }
      thread.path = layPath(dest);
      growBounds(thread.path.points.concat(thread.old || [], o.curl || []), targetExtent(thread.target));
      requestDraw();
      return true;
    }
    function shortThreadTime(th, most) { return clamp(th.path.total / CH.loose.threadSpeed, CH.loose.threadMin, most); }
    function arrived(th) {
      if (th.arrivedFired) return;
      th.arrivedFired = true;
      const cb = th.onArrive; th.onArrive = null;
      if (th.kind === 'surface') { if (cb) cb(); } else hooks.onArrive();
    }
    function startRewind(onDone) {
      if (!thread) { if (onDone) onDone(); return; }
      const t = nowMs() / 1000;
      unfreeze(); burst = null; trace = null;
      thread.onArrive = null; thread.arrivedFired = true;
      if (onDone) thread.onDone = onDone;
      if (mark && mark.phase !== 'rewind') startMarkRewind(t);
      if (reduced) { finishRewind(); mark = null; threadDirty = true; return; }
      thread.old = null; thread.rewindFrom = thread.u;
      if (thread.lasso) thread.rewindTime = CH.lasso.rewind * 1.3;
      else if (thread.kind === 'surface') thread.rewindTime = shortThreadTime(thread, SPEC.moves.rewind);
      if (thread.curl && (thread.curlU || 0) > 0) { thread.phase = 'uncurl'; thread.curlFrom = thread.curlU; }
      else thread.phase = 'rewind';
      thread.phaseStart = t;
      requestDraw();
    }
    function finishRewind() {
      const th = thread; thread = null; frozenThread = null; threadDirty = true;
      if (!th) return;
      if (th.silent) { if (th.onDone) th.onDone(); requestDraw(); return; }
      if (th.kind === 'surface') { if (th.onDone) th.onDone(); }
      else { hooks.onRewound(); if (th.onDone) th.onDone(); }
      requestDraw();
    }
    function updateThread(t) {
      if (!thread) return;
      const th = thread, m = SPEC.moves, elapsed = t - th.phaseStart;
      if (th.phase === 'lasso') {
        const k = clamp(elapsed / CH.lasso.draw);
        th.u = bezierEase(k, CH.lasso.ease);
        if (k >= 1) { th.u = 1; th.phase = 'hold'; th.holdStart = t; arrived(th); }
      } else if (th.phase === 'reach') {
        const duration = th.curl ? m.perchReach : th.kind === 'surface' ? shortThreadTime(th, m.reach) : m.reach, k = clamp(elapsed / duration);
        th.u = th.reachFrom + (1 - th.reachFrom) * bezierEase(k, SPEC.ease.unwind);
        if (k >= 1) {
          th.u = 1; th.phaseStart = t;
          if (th.curl) th.phase = 'curl';
          else { th.phase = 'tap'; arrived(th); }
        }
      } else if (th.phase === 'swing') {
        if (elapsed >= HOST.retargetMs / 1000) { th.phase = 'tap'; th.phaseStart = t; th.old = null; arrived(th); }
      } else if (th.phase === 'tap') {
        if (elapsed >= m.tap) { th.phase = 'hold'; th.holdStart = t; }
      } else if (th.phase === 'curl') {
        th.curlU = smooth(elapsed / m.curl);
        if (elapsed >= m.curl) { th.curlU = 1; th.phase = 'hold'; th.holdStart = t; hooks.cue('perch'); arrived(th); }
      } else if (th.phase === 'uncurl') {
        th.curlU = (th.curlFrom || 1) * (1 - smooth(elapsed / m.curl));
        if (elapsed >= m.curl) { th.phase = 'rewind'; th.phaseStart = t; th.curlU = 0; }
      } else if (th.phase === 'rewind') {
        const time = th.rewindTime || m.rewind;
        th.u = th.rewindFrom * (1 - bezierEase(clamp(elapsed / time), SPEC.ease.rewind));
        if (elapsed >= time) finishRewind();
      }
    }
    // A settled pointer stops animating after a while; the frame just stays.
    const threadStill = (t) => !!thread && thread.phase === 'hold' && (t - thread.holdStart) * 1000 >= HOST.pointerLoopMs;

    // ---- freeze: a surface is open, nothing in the strand moves -----------
    function freeze(t) {
      if (frozen || !thread) return;
      freezePose = effectivePose(t);
      freezePoints = bodyPoints(freezePose).map((p) => Object.assign({}, p));
      frozenThread = null; frozenThread = snapshotThread(t);
      frozen = true; threadDirty = true;
    }
    function unfreeze() {
      if (!frozen && !freezePoints && !frozenThread) return;
      frozen = false; freezePose = null; freezePoints = null; frozenThread = null; threadDirty = true;
    }

    // ---- the whole Knot travelling -----------------------------------------
    // It flies as itself: the loop, tail trailing, on a curved path that eases
    // in and settles. A new destination mid-air keeps the velocity it has, so the
    // path bends instead of jerking.
    function travelTo(to, o = {}) {
      const t = nowMs() / 1000;
      if (o.region && !reduced) return startRegion(to, o);
      if (state === 'sleeping' || asleep) wakeQuietly();
      posCache = null;
      const F = CH.flight, from = position(), dest = vec(to.x, to.y), distance = length(sub(dest, from)), was = travel;
      if (reduced || (distance < 1 && !was)) {
        travel = null;
        if (o.region) { mark = Object.assign(buildMark(rectOf(o.region)), { phase: 'hold', u: 1, start: t }); growBounds(mark.path.points); threadDirty = true; }
        hooks.place(dest, true); posCache = null;
        if (o.lasso) startLasso(o.lasso, t);
        if (o.onDone) o.onDone();
        requestDraw();
        return false;
      }
      unfreeze(); burst = null; trace = null;
      if (thread && !thread.silent) comeHomeQuietly(t);
      // Sent somewhere else while a region mark holds: the mark reels in.
      if (mark && !o.chain && !o.v0 && mark.phase !== 'rewind') startMarkRewind(t);
      const d = sub(dest, from), mid = lerp(from, dest, .5), bow = mul(unit(sub(centre(), mid)), Math.min(F.bowMax, distance * F.bow));
      // A leg that follows on from another keeps the velocity it was handed.
      const v0 = o.v0 ? vec(o.v0.x, o.v0.y) : was ? was.velocity : vec(0, 0);
      travel = { from, to: dest, c1: add(add(from, mul(d, .3)), bow), c2: add(add(from, mul(d, .7)), bow), start: t, duration: clamp(distance / F.speed, F.min, F.max), v0, velocity: v0, last: from, lasso: o.lasso || null, lassoStarted: false, onDone: o.onDone || null, chain: !!o.chain, pending: !!o.pending };
      if (thread || mark) growBounds([from, dest]);
      if (was && was.onDone && !was.chain) was.onDone();
      requestDraw();
      return true;
    }
    function updateTravel(t, dt) {
      if (!travel) return;
      if (travel.kind === 'trace') { updateTrace(t, dt); return; }
      const tr = travel, F = CH.flight, tau = clamp((t - tr.start) / tr.duration);
      const r = 1 - tau, at = add(cubic(tr.from, tr.c1, tr.c2, tr.to, bezierEase(tau, F.ease)), mul(tr.v0, tr.duration * tau * r * r));
      if (dt > 0) tr.velocity = mul(sub(at, tr.last), 1 / dt);
      tr.last = at;
      if (tr.lasso && !tr.lassoStarted && tau >= CH.lasso.startAt) { tr.lassoStarted = true; startLasso(tr.lasso, t, tr.to); }
      if (tau < 1) { hooks.place(at, false); posCache = null; return; }
      // A leg with another after it: no landing, no settle, straight on.
      if (tr.chain) { const next = tr.onDone; travel = null; if (next) next(); return; }
      hooks.place(tr.to, true); posCache = null;
      const cb = tr.onDone; travel = null;
      playGesture('settle');
      if (!tr.lasso) hooks.cue('settle');
      if (cb) cb();
    }

    // ---- the region mark (O4, option C: the small pen) ----------------------
    // A rounded rectangle just outside the area the sentence names. The Knot
    // flies to its top left, shrinking to 55 percent on the way, then rides the
    // tip of the line round it, a little ahead and a little outside, the line
    // paying out of its tail, slowing into each corner. Its place comes
    // straight from eased arc length, never from a chase, so a slow frame
    // cannot make it jitter. At the close it eases back to size and flies on
    // to the control with the velocity it has, then the lasso as usual. The
    // mark holds for the sentence and reels in with the lasso.
    const rectOf = (r) => ({ x: Number(r.x) || 0, y: Number(r.y) || 0, w: Math.max(1, Number(r.w) || 1), h: Math.max(1, Number(r.h) || 1) });
    const penScale = () => (mark && (mark.phase === 'fly' || mark.phase === 'draw') ? CH.region.scale : 1);
    function buildMark(rect) {
      const R = CH.region, r = R.radius, pad = R.pad, x0 = rect.x - pad, y0 = rect.y - pad, x1 = rect.x + rect.w + pad, y1 = rect.y + rect.h + pad, pts = [], corners = [];
      const edge = (ax, ay, bx, by) => { const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / R.step)); for (let i = 0; i < n; i++) pts.push(vec(mix(ax, bx, i / n), mix(ay, by, i / n))); };
      const arcTo = (cx, cy, a0) => { corners.push(pts.length + 4); for (let i = 0; i < 8; i++) { const a = a0 + i / 8 * Math.PI / 2; pts.push(vec(cx + r * Math.cos(a), cy + r * Math.sin(a))); } };
      edge(x0 + r, y0, x1 - r, y0); arcTo(x1 - r, y0 + r, -Math.PI / 2);
      edge(x1, y0 + r, x1, y1 - r); arcTo(x1 - r, y1 - r, 0);
      edge(x1 - r, y1, x0 + r, y1); arcTo(x0 + r, y1 - r, Math.PI / 2);
      edge(x0, y1 - r, x0, y0 + r); arcTo(x0 + r, y0 + r, Math.PI);
      // It closes by running a little past its start, crossing itself once, like the lasso.
      for (let i = 0; i <= R.overrun; i++) pts.push(vec(x0 + r + i * R.step, y0 + i * .9));
      // A hand's slow wobble, small and fixed: drawn, not ruled.
      for (let i = 0; i < pts.length; i++) { const k = i * R.wobbleRate, q = pts[i]; pts[i] = vec(q.x + (Math.sin(k * 1.7) + Math.sin(k * .6 + 2) * .85) * R.wobble, q.y + (Math.sin(k * 1.3 + 1) + Math.sin(k * .5) * .85) * R.wobble); }
      const path = pathTable(pts), cornerAt = corners.map((i) => path.lengths[Math.min(i, path.lengths.length - 1)]);
      return { rect, path, centre: vec(rect.x + rect.w / 2, rect.y + rect.h / 2), cornerAt, ease: markEase(path, cornerAt) };
    }
    // Arc length against time: slow into each corner and at both ends, the
    // same total time. A table, inverted by bisection.
    function markEase(path, cornerAt) {
      const R = CH.region, n = 400, times = [0];
      const speed = (d0) => { let d = Math.min(d0 + R.slowEnds, path.total - d0 + R.slowEnds); for (const c of cornerAt) d = Math.min(d, Math.abs(d0 - c)); return R.cornerSpeed + (1 - R.cornerSpeed) * clamp(d / R.slowOver); };
      for (let i = 1; i <= n; i++) times.push(times[i - 1] + (path.total / n) / speed((i - .5) / n * path.total));
      const end = times[n];
      return (f) => { const want = clamp(f) * end; let lo = 0, hi = n; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (times[m] < want) lo = m; else hi = m; } return (lo + (want - times[lo]) / Math.max(1e-6, times[hi] - times[lo])) / n; };
    }
    // Where the Knot rides for a pen at arc fraction u: a little ahead, a little outside.
    function markRider(m, u) {
      const R = CH.region, P = m.path, d = P.total * u;
      const far = pathAt(P, Math.min(P.total, d + R.ahead)), near = pathAt(P, Math.max(0, d - 4)), tan = unit(sub(far, near), vec(1, 0));
      let nrm = vec(tan.y, -tan.x);
      if ((far.x - m.centre.x) * nrm.x + (far.y - m.centre.y) * nrm.y < 0) nrm = mul(nrm, -1);
      return add(far, mul(nrm, R.out));
    }
    function startRegion(to, o) {
      const t = nowMs() / 1000, R = CH.region;
      if (state === 'sleeping' || asleep) wakeQuietly();
      mark = Object.assign(buildMark(rectOf(o.region)), { phase: 'fly', u: 0, start: t });
      const m = R.pad + R.out + R.ahead + 60;
      growBounds(mark.path.points, { x0: mark.rect.x - m, y0: mark.rect.y - m, x1: mark.rect.x + mark.rect.w + m, y1: mark.rect.y + mark.rect.h + m });
      threadDirty = true;
      const dest = vec(to.x, to.y), lasso = o.lasso || null, onDone = o.onDone || null;
      return travelTo(markRider(mark, 0), { pending: true, chain: true, onDone: () => startTrace(dest, lasso, onDone) });
    }
    function startTrace(dest, lasso, onDone) {
      if (!mark) return;
      const t = nowMs() / 1000, R = CH.region, from = position();
      mark.phase = 'draw'; mark.start = t; mark.u = 0;
      travel = { kind: 'trace', from, to: markRider(mark, 1), start: t, duration: clamp(mark.path.total / R.speed, R.min, R.max), velocity: vec(0, 0), last: from, pending: true, lasso: null, next: { dest, lasso, onDone } };
      requestDraw();
    }
    function updateTrace(t, dt) {
      const tr = travel, m = mark;
      if (!m) { travel = null; return; }
      const tau = clamp((t - tr.start) / tr.duration);
      m.u = m.ease(tau);
      const at = markRider(m, m.u);
      if (dt > 0) tr.velocity = mul(sub(at, tr.last), 1 / dt);
      tr.last = at;
      hooks.place(at, false); posCache = null;
      threadDirty = true;
      if (tau < 1) return;
      m.phase = 'hold'; m.u = 1;
      travel = null;
      travelTo(tr.next.dest, { lasso: tr.next.lasso, onDone: tr.next.onDone, v0: tr.velocity });
    }
    function startMarkRewind(t) { if (!mark) return; mark.phase = 'rewind'; mark.start = t; mark.from = mark.u; threadDirty = true; }
    function updateMark(t) {
      if (!mark || mark.phase !== 'rewind') return;
      const k = clamp((t - mark.start) / CH.region.rewind);
      mark.u = mark.from * (1 - bezierEase(k, SPEC.ease.rewind));
      threadDirty = true;
      if (k >= 1) mark = null;
    }
    // The mark as drawn: its prefix, and while it is being drawn the line on to
    // the tail, so the line comes out of the Knot.
    function markPoints(t) {
      const R = CH.region, mp = prefix(mark.path, mark.u);
      if (mark.phase !== 'draw' || mp.length < 2) return mp;
      const tip = mp[mp.length - 1], anchor = tailAnchor(effectivePose(t)), gap = length(sub(anchor, tip));
      const along = unit(sub(tip, mp[Math.max(0, mp.length - 3)]), vec(1, 0));
      const c1 = add(tip, mul(along, gap * .35)), c2 = sub(anchor, mul(unit(sub(anchor, shownPosition()), along), gap * .3));
      for (let i = 1; i <= R.leadPoints; i++) mp.push(cubic(tip, c1, c2, anchor, i / R.leadPoints));
      return mp;
    }

    // ---- the lasso --------------------------------------------------------
    // One line out of the tail, round the control, crossing itself on the way
    // home. It is thrown a little wide and then pulled snug.
    function buildLasso(rect, from) {
      const L = CH.lasso, c = vec(rect.x + rect.w / 2, rect.y + rect.h / 2), hw = rect.w / 2 + L.gap, hh = rect.h / 2 + L.gap;
      const a0 = Math.atan2((from.y - c.y) / hh, (from.x - c.x) / hw), e = 2 / L.power, ring = [];
      const curve = (v) => Math.sign(v) * Math.pow(Math.abs(v), e);
      for (let i = 0; i <= L.points; i++) { const a = a0 + TAU * L.sweep * i / L.points; ring.push(vec(c.x + curve(Math.cos(a)) * hw, c.y + curve(Math.sin(a)) * hh)); }
      return { rect, centre: c, ring, start: ring[0], far: ring[Math.round(L.points / (2 * L.sweep))] };
    }
    function startLasso(rect, t, landing) {
      const target = { x: rect.x, y: rect.y, w: rect.w, h: rect.h }, lasso = buildLasso(target, landing || position());
      const was = thread;
      thread = { kind: 'guide', destination: lasso.far, path: pathTable(lasso.ring), lasso, lassoStart: t, u: 0, reachFrom: 0, phase: 'lasso', phaseStart: t, holdStart: t, target, onArrive: null, onDone: null, curl: null, curlTable: null, curlU: 0, corner: null, old: null, blendStart: t };
      frozenThread = null;
      if (!was) bounds = null;
      const L = CH.lasso, wide = L.thrown + L.ripple;
      growBounds(lasso.ring.concat([landing || position(), add(lasso.centre, vec(0, 0))]), { x0: rect.x - L.gap - wide, y0: rect.y - L.gap - wide, x1: rect.x + rect.w + L.gap + wide, y1: rect.y + rect.h + L.gap + wide });
      threadDirty = true;
      if (reduced) { thread.u = 1; thread.phase = 'hold'; arrived(thread); renderStatic(); }
      else requestDraw();
    }
    function lassoPoints(th, t) {
      const lz = th.lasso, L = CH.lasso, anchor = tailAnchor(effectivePose(t)), pos = shownPosition(), age = t - th.lassoStart;
      // Thrown wide, pulled snug, a last small ripple through the line. Then still.
      const close = L.draw, wide = L.thrown * (1 - smooth((age - close * .7) / L.cinch));
      const ripple = age > close ? L.ripple * Math.exp(-(age - close) * 5) : 0;
      let ring = lz.ring;
      if (wide > .01 || ripple > .01) {
        ring = lz.ring.map((q, i) => {
          const off = sub(q, lz.centre), dir = unit(off, vec(1, 0));
          return add(q, mul(dir, wide + ripple * Math.sin(i / L.points * TAU * L.rippleWaves * L.sweep + age * 7)));
        });
      }
      const start = ring[0], gap = length(sub(start, anchor));
      const c1 = add(anchor, mul(unit(sub(anchor, pos), TOWARD), gap * .4)), c2 = sub(start, mul(unit(sub(ring[1], start), TOWARD), gap * .4));
      const all = [];
      for (let i = 0; i < L.leadPoints; i++) all.push(cubic(anchor, c1, c2, start, i / L.leadPoints));
      for (const q of ring) all.push(q);
      return prefix(pathTable(all), th.u);
    }
    // The line goes home on its own as the Knot lifts off. Nobody is told.
    function comeHomeQuietly(t) {
      const th = thread;
      th.silent = true; th.onArrive = null; th.arrivedFired = true; th.old = null;
      th.curlU = 0; th.rewindFrom = th.u; th.rewindTime = CH.lasso.rewind; th.phase = 'rewind'; th.phaseStart = t;
    }

    // ---- the colour ---------------------------------------------------------
    // One target at any moment: a beat if one is running, else the state's colour,
    // else white. Everything on screen is worked out from the clock, so an
    // interrupted change carries on from what is showing.
    const AC = CH.accent;
    const tintColours = Object.fromEntries(Object.keys(AC.palette).map((k) => [k, hexRgb(AC.palette[k])]));
    const mixRgb = (a, b, u) => [mix(a[0], b[0], u), mix(a[1], b[1], u), mix(a[2], b[2], u)];
    function startBeat(name) {
      const B = AC.beats[name];
      if (!B) return;
      const t = nowMs() / 1000;
      beat = { colour: B.colour, until: t + B.hold };
      syncTint(t);
      // No loop runs under reduced motion, so something has to end the beat.
      if (reduced && typeof setTimeout === 'function') setTimeout(() => { if (reduced) renderStatic(); }, B.hold * 1000 + 20);
    }
    function clearTint() { beat = null; tint.name = null; tint.rgb = null; tint.from = null; tint.glowFrom = null; tint.out = null; micShown = 0; }
    // What is showing right now: core and glow levels 0 to 1, how much of the lap is done.
    function tintShown(t) {
      if (tint.name) {
        const u = reduced ? 1 : clamp((t - tint.start) / AC.arrive), cov = reduced ? 1 : clamp((t - tint.start) / AC.lap);
        const g = tint.glowFrom;
        return { core: 1, cov, rgb: tint.rgb, glow: g ? mix(g.k, 1, u) : u, glowRgb: g ? mixRgb(g.rgb, tint.rgb, u) : tint.rgb, under: cov < 1 ? tint.from : null };
      }
      if (!tint.out) return { core: 0, cov: 0, rgb: null, glow: 0, glowRgb: null, under: null };
      const o = tint.out, v = reduced ? 0 : 1 - smooth((t - o.start) / AC.leave);
      return { core: o.core * v, cov: o.cov, rgb: tint.rgb, glow: o.glow * v, glowRgb: o.glowRgb, under: o.under ? { rgb: o.under.rgb, k: o.under.k * v } : null };
    }
    function syncTint(t) {
      if (beat && t >= beat.until) beat = null;
      if (tint.out && (reduced || t - tint.out.start >= AC.leave) && !tint.name) { tint.out = null; tint.rgb = null; tint.from = null; tint.glowFrom = null; }
      const name = beat ? beat.colour : AC.states[state] || null;
      if (name === tint.name) return;
      const shown = tintShown(t);
      if (name) {
        tint.from = shown.core > .002 && shown.rgb ? { rgb: shown.rgb, k: shown.core } : null;
        tint.glowFrom = shown.glow > .002 && shown.glowRgb ? { rgb: shown.glowRgb, k: shown.glow } : null;
        tint.rgb = tintColours[name]; tint.start = t; tint.out = null;
      } else tint.out = { start: t, core: shown.core, cov: shown.cov, glow: shown.glow, glowRgb: shown.glowRgb, under: shown.under };
      tint.name = name;
    }
    // Is the colour still on its way in or out? Colour settled on a state needs no extra frames.
    function tintMoving(t) { return !!beat || !!tint.out || (!!tint.name && t - tint.start < AC.lap); }
    // A colour on the strand's own points, under the ink: a blurred copy of the
    // line, so it follows the shape instead of sitting round it as a disc. The
    // filter's blur is in canvas pixels and ignores the transform.
    function drawGlow(ctx, pts, shown, t) {
      const Gl = AC.glow, K = CH.look;
      const breath = reduced ? (Gl.low + Gl.high) / 2 : mix(Gl.low, Gl.high, .5 + .5 * Math.cos(t / Gl.period * TAU));
      const c = shown.glowRgb, a = shown.glow * Gl.strength * Math.min(1, breath + AC.mic.glow * micShown);
      if (a < .004) return;
      ctx.filter = 'blur(' + (Gl.spread / 2 * bodyDPR) + 'px)';
      strokeSpan(ctx, pts, 0, pts.length - 1, G.tube * K.wall + K.outline * 2, 'rgba(' + Math.round(c[0]) + ',' + Math.round(c[1]) + ',' + Math.round(c[2]) + ',' + a.toFixed(3) + ')');
      ctx.filter = 'none';
    }
    // The core of one run. Behind the lap's head it is the new colour, ahead of it
    // whatever colour was there. Whole once the lap is done: one stroke a run.
    function drawCore(ctx, pts, run, w, white, shown, coreCss, underCss) {
      const K = CH.look, n = pts.length - 1, over = K.overlapWhite * w, from = spanBack(pts, run.from, over), to = spanForward(pts, run.to, over);
      const width = white * AC.core * (1 + AC.mic.width * micShown);
      if (shown.cov >= 1) { strokeSpan(ctx, pts, from, to, width, coreCss); return; }
      const total = arc[n] || 1, tip = Math.round(tailIndex()) % n, a0 = arc[tip], head = tint.name ? AC.head : 0;
      const kindAt = (j) => {
        const v = (arc[((j % n) + n) % n] - a0) / total, x = v - Math.floor(v);
        return x > shown.cov ? 0 : shown.cov - x < head ? 2 : 1;
      };
      let start = from, kind = kindAt(from);
      for (let j = from + 1; j <= to; j++) {
        const k = j < to ? kindAt(j) : -1;
        if (k === kind) continue;
        if (kind === 0) { if (underCss) strokeSpan(ctx, pts, start, j + 1, white * AC.core, underCss); }
        else strokeSpan(ctx, pts, start, j + 1, kind === 2 ? white * AC.headWidth : width, coreCss);
        start = j; kind = k;
      }
    }

    // ---- drawing ----------------------------------------------------------
    // At rest and asleep, two strokes only on every desktop: the ink outline and
    // the white. No wall, rim, shading, band, halo or particles, ever. A state
    // that says something adds its core and, under everything, its glow.
    const INK = rgbOf(CH.look.ink), WHITE = rgbOf(CH.look.white);
    const arc = new Float64Array(G.samples + 1);
    function strokeSpan(ctx, pts, from, to, width, color) {
      const n = pts.length - 1, at = (i) => pts[((i % n) + n) % n];
      const first = at(from);
      ctx.beginPath(); ctx.moveTo(first.x, first.y);
      // Curves through the midpoints, so the line has no facets at any size.
      for (let i = from + 1; i < to; i++) { const q = at(i), r = at(i + 1); ctx.quadraticCurveTo(q.x, q.y, (q.x + r.x) / 2, (q.y + r.y) / 2); }
      const last = at(to); ctx.lineTo(last.x, last.y);
      ctx.lineWidth = width; ctx.strokeStyle = color; ctx.stroke(); counters.calls++;
    }
    // How many points back or forward along the closed curve cover this distance.
    function spanBack(pts, i, dist) { const n = pts.length - 1; let d = 0, j = i; while (d < dist && i - j < n) { const a = pts[((j - 1) % n + n) % n], b = pts[(j % n + n) % n]; d += Math.hypot(b.x - a.x, b.y - a.y); j--; } return j; }
    function spanForward(pts, i, dist) { const n = pts.length - 1; let d = 0, j = i; while (d < dist && j - i < n) { const a = pts[j % n], b = pts[(j + 1) % n]; d += Math.hypot(b.x - a.x, b.y - a.y); j++; } return j; }
    function drawBody(t) {
      const ctx = bctx, K = CH.look;
      const live = effectivePose(t);
      const p = freezePose ? Object.assign({}, freezePose, { bright: live.bright }) : live;
      let pts = freezePoints || bodyPoints(p);
      if (!allFinite(pts)) { recover(new Error('non-finite body')); pts = bodyPoints(effectivePose(t)); }
      ctx.setTransform(bodyDPR, 0, 0, bodyDPR, 0, 0); ctx.clearRect(0, 0, G.size, G.size); counters.calls++;
      ctx.lineJoin = 'round'; ctx.lineCap = 'butt';
      syncTint(t);
      const shown = tintShown(t), coloured = shown.core > .002 && !!shown.rgb;
      if (shown.glow > .002 && shown.glowRgb) drawGlow(ctx, pts, shown, t);
      const lift = tint.name === 'listening' ? AC.mic.floor + (1 - AC.mic.floor) * (reduced ? .5 : micShown) : 1;
      const coreCss = coloured ? rgbOf(mixRgb(CH.look.white, shown.rgb, shown.core * lift).map(Math.round)) : null;
      const underCss = shown.under && shown.under.k > .002 ? rgbOf(mixRgb(CH.look.white, shown.under.rgb, shown.under.k).map(Math.round)) : null;
      // Runs are cut by arc length, drawn back to front. Each stroke reaches past
      // its run, the white further than the ink, so no join ever shows.
      const n = pts.length - 1, runs = [];
      arc[0] = 0;
      for (let i = 1; i <= n; i++) arc[i] = arc[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
      for (let from = 0; from < n;) {
        let to = from + 1;
        while (to < n && arc[to] - arc[from] < K.run) to++;
        let z = 0;
        for (let j = from; j <= to; j++) z += pts[j].z;
        runs.push({ from, to, z: z / (to - from + 1) });
        from = to;
      }
      runs.sort((a, b) => a.z - b.z);
      for (const run of runs) {
        const mid = pts[(run.from + run.to) >> 1], w = G.tube * mid.w, white = w * K.wall * (1 + run.z * K.thickThin);
        strokeSpan(ctx, pts, spanBack(pts, run.from, K.overlapInk * w), spanForward(pts, run.to, K.overlapInk * w), white + K.outline * 2, INK);
        strokeSpan(ctx, pts, spanBack(pts, run.from, K.overlapWhite * w), spanForward(pts, run.to, K.overlapWhite * w), white, WHITE);
        if (coloured) drawCore(ctx, pts, run, w, white, shown, coreCss, underCss);
      }
      counters.body++;
    }
    function strokePath(ctx, points, ox, oy, width, color) {
      ctx.beginPath(); ctx.moveTo(points[0].x + ox, points[0].y + oy);
      for (let i = 1; i < points.length - 1; i++) { const q = points[i], r = points[i + 1]; ctx.quadraticCurveTo(q.x + ox, q.y + oy, (q.x + r.x) / 2 + ox, (q.y + r.y) / 2 + oy); }
      const end = points[points.length - 1]; ctx.lineTo(end.x + ox, end.y + oy);
      ctx.lineWidth = width; ctx.strokeStyle = color; ctx.stroke(); counters.calls++;
    }
    function hideThread() {
      if (!strand) return;
      if (threadShown) { sctx.setTransform(1, 0, 0, 1, 0, 0); sctx.clearRect(0, 0, strand.width, strand.height); counters.calls++; }
      strand.style.display = 'none'; threadShown = false; bounds = null;
    }
    function drawThread(t) {
      if (!strand) return;
      const points = threadPoints(t), ctx = sctx, K = CH.look, mp = mark ? markPoints(t) : null;
      if (points.length >= 2 && (travel || (thread && thread.lasso))) growBounds(points);
      if (mp && mp.length >= 2 && travel) growBounds(mp);
      if ((points.length < 2 && !(mp && mp.length >= 2)) || !bounds) { hideThread(); return; }
      strand.style.display = 'block'; threadShown = true;
      ctx.setTransform(strandDPR, 0, 0, strandDPR, 0, 0); ctx.clearRect(0, 0, bounds.w, bounds.h); counters.calls++;
      ctx.translate(-bounds.x, -bounds.y); ctx.lineJoin = ctx.lineCap = 'round';
      if (mp && mp.length >= 2) { strokePath(ctx, mp, 0, 0, K.thread + K.outline * 2, INK); strokePath(ctx, mp, 0, 0, K.thread, WHITE); }
      if (points.length >= 2) { strokePath(ctx, points, 0, 0, K.thread + K.outline * 2, INK); strokePath(ctx, points, 0, 0, K.thread, WHITE); }
      if (trace && trace.phase === 'fade') {
        // The drawn outline hands over to the real bubble frame instead of vanishing.
        const k = clamp((t - trace.start) / SPEC.surfaces.open);
        ctx.globalAlpha = 1 - k; strokePath(ctx, trace.path.points, 0, 0, K.thread, WHITE); ctx.globalAlpha = 1;
      }
      if (burst && !reduced) {
        const Bu = IN.burst, u = clamp((t - burst.start) / SPEC.surfaces.burst);
        if (u < 1) for (let i = 0; i < Bu.lines; i++) {
          const angle = Math.PI * Bu.angle + i * Bu.step, r0 = Bu.from + u * Bu.grow;
          const a = vec(burst.tip.x + Math.cos(angle) * r0, burst.tip.y + Math.sin(angle) * r0), b = vec(a.x + Math.cos(angle) * Bu.length, a.y + Math.sin(angle) * Bu.length);
          ctx.globalAlpha = 1 - u; strokePath(ctx, [a, b], 0, 0, Bu.width, WHITE); ctx.globalAlpha = 1;
        }
      }
      counters.thread++; threadDirty = false;
    }
    function render(t) {
      counters.calls = 0;
      drawBody(t);
      // While a surface is held, or a pointer has settled, the strand is not touched.
      const still = threadStill(t);
      // The moment a pointer settles for good, one clean frame with no light in flight.
      if (still && !thread.stillDrawn) { thread.stillDrawn = true; threadDirty = true; }
      const quiet = thread && (frozen || still) && !burst && !(trace && trace.phase === 'fade') && !(mark && mark.phase !== 'hold');
      if (!quiet || threadDirty) drawThread(t);
      counters.frames++;
    }

    // ---- the hover --------------------------------------------------------
    // It hangs in the air and breathes, even asleep. This only moves the finished
    // canvas (no redraw), so a sleeping Knot costs a position change, not a paint.
    function updateHover(dt, t) {
      const H = CH.states[state].hover, still = reduced || !!travel || frozen || !!drag || threadStill(t), e = 1 - Math.exp(-CH.hoverEase * dt);
      hoverAmp = mix(hoverAmp, still ? 0 : H[0] * posScale, e); hoverBreath = mix(hoverBreath, still ? 0 : H[2], e); hoverRate = mix(hoverRate, H[1], e);
      hoverPhase = (hoverPhase + dt * hoverRate) % (TAU * 2);
      hoverY = (Math.sin(hoverPhase) + .18 * Math.sin(hoverPhase * .5 + 1)) * hoverAmp;
      writeHover(1 + Math.sin(hoverPhase - .6) * hoverBreath);
    }
    function writeHover(grow) {
      if (!body.style) return;
      // In small steps: too small to see, and between them nothing touches the screen.
      const y = Math.round(hoverY / CH.hoverStep) * CH.hoverStep, g = Math.round(grow * 500) / 500, next = y + '|' + g;
      if (next === hoverShown) return;
      hoverShown = next;
      body.style.transform = 'translateY(' + y.toFixed(2) + 'px) scale(' + g.toFixed(3) + ')';
    }

    // ---- the loop ---------------------------------------------------------
    function recover(e) {
      counters.errors++;
      gesture = null; residual = null; overrides = {};
      for (const k of PARAMS) { springs[k].x = CH.states[state].pose[k]; springs[k].v = 0; }
      { const goal = shapeTargets(); for (const k of SHAPES) { shape[k].x = goal[k]; shape[k].v = 0; } spin = 0; spinV = 0; spinGoal = null; lobeTurn = 0; tailReady = 1; }
      frozen = false; freezePose = null; freezePoints = null; frozenThread = null;
      try { hooks.onError(e); } catch (_) { /* never let reporting stop the loop */ }
    }
    // Nothing but the hover to do: wait out the gap on a timer, not on every frame.
    function waitQuietly() {
      if (raf || quietTimer) return;
      if (typeof setTimeout !== 'function') { raf = requestAnimationFrame(tick); return; }
      quietTimer = setTimeout(() => { quietTimer = 0; if (!raf && !paused) raf = requestAnimationFrame(tick); }, 1000 / CH.asleepFps);
    }
    function wakeLoop() {
      if (quietTimer) { clearTimeout(quietTimer); quietTimer = 0; }
      if (asleep) { asleep = false; body.classList && body.classList.remove('knot-asleep'); }
      if (!raf && !paused) { lastTick = nowMs(); raf = requestAnimationFrame(tick); }
    }
    function requestDraw() { drewQuiet = false; if (reduced) { renderStatic(); return; } wakeLoop(); }
    function step(dt, t) {
      posCache = null;
      const ratio = overrides.tempo != null ? springs.tempo.x / CH.states[state].pose.tempo : 1;
      phase += dt * eased.speed * ratio;
      updateTravel(t, dt); updateThread(t); updateMark(t);
      if (trace) {
        if (trace.phase === 'draw') {
          trace.u = smooth((t - trace.start) / SPEC.surfaces.trace);
          if (t - trace.start >= SPEC.surfaces.trace) { trace.u = 1; trace.phase = 'fade'; trace.start = t; const cb = trace.onDone; trace.onDone = null; if (cb) cb(); }
        } else if (t - trace.start >= SPEC.surfaces.open) trace = null;
      }
      if (burst && t - burst.start >= SPEC.surfaces.burst) { burst = null; threadDirty = true; }
      integrate(dt, t);
      micShown = state === 'listening' && !reduced ? mix(micShown, micLevel, 1 - Math.exp(-AC.mic.ease * dt)) : 0;
      updateHover(dt, t);
      if (gesture && t - gesture.start >= SPEC.gestures[gesture.name].duration) { const name = gesture.name; gesture = null; hooks.onGestureEnd(name); }
      if (residual && (t - residual.start) * 1000 >= HOST.gestureHandoffMs) residual = null;
      // A held surface freezes the strand once the tip has landed and settled.
      // (Beside a lasso it stays alive: the lead line moves with it, the ring holds.)
      if (held && !frozen && thread && thread.phase === 'hold' && !thread.lasso && !burst && !trace) freeze(t);
    }
    function tick() {
      raf = 0;
      if (reduced || paused) return;
      const ms = nowMs();
      if (typeof document !== 'undefined' && document.hidden && opts.pauseWhenHidden) { lastTick = ms; return; }
      const active = gesture || residual || travel || drag || fileHover || burst || trace || (thread && thread.phase !== 'hold') || (mark && mark.phase !== 'hold') || shapeMoving() || tintMoving(ms / 1000);
      const rest = state === 'idle' || state === 'ready' || state === 'sleeping';
      // Settled at rest the shape is finished: one last paint, then only the hover runs.
      const settled = !active && state === 'idle' && !tint.name && !frozen && !thread && !mark && !poseMoving();
      const quiet = asleep || (settled && drewQuiet);
      const big = !!(drag || travel || gesture || fileHover || burst || trace);
      const fast = !!(active || (!rest && !frozen)), interval = quiet ? 1000 / CH.asleepFps : fast ? (lowPower && !big ? IN.frame.rest : IN.frame.active) : IN.frame.rest;
      // The moment something starts moving, the next frame is drawn: no waiting out a rest interval.
      if (fast && !wasFast) nextDue = ms;
      wasFast = fast;
      // How often this display really calls back (a running average).
      const gap = ms - lastRaf; lastRaf = ms;
      if (!quiet && gap > 2 && gap < 100) period = period ? period * .9 + gap * .1 : gap;
      // A display at about the target rate draws every frame. A faster one
      // (75, 120, 144 Hz) draws on a schedule, so the rate still averages 30
      // at rest and 60 in motion instead of whatever divides the refresh rate.
      if (period >= interval * .85 || ms + IN.frame.slack >= nextDue) {
        const dt = Math.min(IN.frame.maxDt, Math.max(0, (ms - lastTick) / 1000)), t = ms / 1000;
        lastTick = ms; nextDue = Math.max(nextDue + interval, ms);
        try {
          if (quiet) { updateHover(dt, t); waitQuietly(); return; }
          step(dt, t);
          if (state === 'sleeping' && t - stateStart >= SPEC.sleepStop && !gesture && !shapeMoving()) {
            // Asleep: commit the resting pose and paint it once. From here only the hover runs.
            const sp = CH.states.sleeping.pose;
            for (const k of PARAMS) { springs[k].x = sp[k]; springs[k].v = 0; }
            render(t);
            asleep = true; body.classList && body.classList.add('knot-asleep');
            waitQuietly();
            return;
          }
          render(t);
          drewQuiet = settled;
        } catch (e) { recover(e); }
      }
      // Handlers called from the step may already have scheduled a frame.
      if (!raf) raf = requestAnimationFrame(tick);
    }
    // Reduced motion: one static frame per event, no loop.
    function renderStatic() {
      const t = nowMs() / 1000;
      posCache = null;
      try {
        if (travel) { const tr = travel; travel = null; hooks.place(tr.to, true); posCache = null; if (tr.onDone) tr.onDone(); }
        gesture = null; residual = null; burst = null;
        hoverY = 0; hoverAmp = 0; hoverBreath = 0; writeHover(1);
        if (trace) { const cb = trace.onDone; trace = null; if (cb) cb(); }
        resetSprings(t);
        eased.speed = SPEC.states[state].motion[0];
        threadDirty = true;
        render(t);
      } catch (e) { recover(e); }
    }

    // ---- sleep ------------------------------------------------------------
    function wakeQuietly() {
      if (state === 'sleeping') { state = 'idle'; stateStart = nowMs() / 1000; }
      asleep = false; body.classList && body.classList.remove('knot-asleep');
    }
    function sleep() {
      if (state === 'sleeping' || reduced) return;
      const t = nowMs() / 1000;
      unfreeze(); thread = null; frozenThread = null; threadDirty = true; travel = null; burst = null; trace = null; mark = null; held = false;
      state = 'sleeping'; stateStart = t; residual = null;
      clearTint();   // nothing on the sleeping Knot, not even a fade
      gesture = { name: 'sleep', start: t, direction: vec(0, -1) };
      requestDraw();
    }
    function wake() {
      const was = state === 'sleeping' || asleep;
      if (!was) return false;
      wakeQuietly();
      if (!reduced) { gesture = { name: 'wake', start: nowMs() / 1000, direction: vec(0, -1) }; residual = null; }
      requestDraw();
      return true;
    }

    // ---- wiring -----------------------------------------------------------
    const onResize = () => { posCache = null; resizeBody(); if (thread && thread.phase !== 'rewind') relayout(); requestDraw(); };
    function relayout(dest) {
      if (!thread || !thread.path) return;
      posCache = null;
      unfreeze();
      if (thread.lasso) { thread.lasso = buildLasso(thread.lasso.rect, position()); thread.destination = thread.lasso.far; thread.path = pathTable(thread.lasso.ring); thread.lassoStart = -1e6; growBounds(thread.lasso.ring); threadDirty = true; requestDraw(); return; }
      // A surface thread is told where its corner went.
      if (dest && thread.kind === 'surface' && Number.isFinite(dest.x) && Number.isFinite(dest.y)) thread.destination = vec(dest.x, dest.y);
      // The Knot moved: the tip keeps its place, the path is laid again from the new seam.
      if (thread.target && !thread.curl) thread.destination = targetAnchor(thread.target, position());
      thread.path = layPath(thread.destination);
      thread.stillDrawn = false;
      growBounds(thread.path.points.concat(thread.curl || []), targetExtent(thread.target));
      threadDirty = true;
      requestDraw();
    }
    window.addEventListener('resize', onResize);
    const onMotion = () => { api.knot.setReducedMotion(!!mq.matches); };
    if (mq && mq.addEventListener) mq.addEventListener('change', onMotion);

    // A guide step is out from the moment the flight that carries its lasso leaves.
    const lassoFlying = () => !!travel && ((!!travel.lasso && !travel.lassoStarted) || !!travel.pending);
    const guideOut = () => lassoFlying() || (!!thread && thread.kind !== 'surface' && !thread.silent);
    const api = {
      knot: {
        setState(next) {
          if (next === 'spar') next = 'ready';
          if (!SPEC.states[next]) next = 'idle';
          // Asleep stays asleep through the host's idle ticks; anything else wakes.
          if ((state === 'sleeping' || asleep) && next === 'idle') return;
          if (next === 'sleeping') { sleep(); return; }
          if (state === 'sleeping' || asleep) wakeQuietly();
          // An unchanged state is nothing, and a change never touches the gesture.
          if (next === state) { if (reduced) renderStatic(); return; }
          state = next; stateStart = nowMs() / 1000;
          syncTint(stateStart);
          requestDraw();
        },
        getState() { return state; },
        gesture: playGesture,
        setPose(partial) {
          if (!partial) return;
          for (const k of PARAMS) if (partial[k] != null && Number.isFinite(Number(partial[k]))) overrides[k] = clamp(Number(partial[k]), SPEC.ranges[k][0], SPEC.ranges[k][1]);
          if (state === 'sleeping' || asleep) wakeQuietly();
          requestDraw();
        },
        resetPose() { overrides = {}; requestDraw(); },
        getPose() { return effectivePose(nowMs() / 1000); },
        // Microphone level while listening (0..1).
        setLevel(v) { micLevel = clamp(Number(v) || 0); },
        // The voice it speaks with. null = no real level, use the synthetic one.
        setVoiceLevel(v) { voiceLevel = v === null || v === undefined ? null : clamp(Number(v) || 0); },
        setPointer(p) { pointer = p && Number.isFinite(p.x) && Number.isFinite(p.y) ? vec(p.x, p.y) : null; },
        setDrag(d) {
          if (!d) { if (drag) { drag = null; requestDraw(); } return; }
          const k = CH.dragSmooth, vx = Number(d.vx) || 0, vy = Number(d.vy) || 0;
          drag = { vx: drag ? mix(drag.vx, vx, k) : vx * k, vy: drag ? mix(drag.vy, vy, k) : vy * k, at: nowMs() / 1000 };
          posCache = null;
          if (state === 'sleeping' || asleep) wakeQuietly();
          requestDraw();
        },
        setFileHover(p) {
          fileHover = p && Number.isFinite(p.x) && Number.isFinite(p.y) ? vec(p.x, p.y) : null;
          if (fileHover && (state === 'sleeping' || asleep)) wakeQuietly();
          requestDraw();
        },
        // Brightness of the desktop behind the Knot, 0 dark to 1 white. White with an
        // ink outline reads on any desktop, so this changes nothing about the drawing.
        setBackdrop(v) { backdrop = clamp(Number(v) || 0); },
        getBackdrop() { return backdrop; },
        sleep, wake,
        isAsleep() { return asleep; },
        isSleeping() { return state === 'sleeping'; },
        setReducedMotion(v) {
          const next = !!v;
          if (next === reduced) return;
          reduced = next;
          if (raf) { cancelAnimationFrame(raf); raf = 0; }
          if (reduced) {
            if (thread) { if (thread.phase === 'rewind' || thread.phase === 'uncurl') finishRewind(); else { thread.u = 1; thread.old = null; thread.curlU = thread.curl ? 1 : 0; thread.phase = 'hold'; arrived(thread); } }
            renderStatic();
          } else if (!asleep) requestDraw();
        },
        isReduced() { return reduced; },
        setLowPower(v) { lowPower = !!v; },
        isLowPower() { return lowPower; },
        // Viewport position of the open end. With u, where it would sit at
        // that unravel level under the current pose.
        getTailAnchor(u) {
          posCache = null;
          const a = tailAnchor(effectivePose(nowMs() / 1000));
          return { x: a.x, y: a.y, z: 0, r: G.tube / 2 };
        },
        getPosition() { posCache = null; const p = position(); return { x: p.x, y: p.y }; },
        // Relocate the whole Knot. The host moves the element through hooks.place.
        travelTo, isTravelling() { return !!travel; },
        cancelTravel() { if (!travel) return; const tr = travel; travel = null; posCache = null; if (tr.onDone) tr.onDone(); requestDraw(); },
        pause() { paused = true; if (raf) { cancelAnimationFrame(raf); raf = 0; } if (quietTimer) { clearTimeout(quietTimer); quietTimer = 0; } },
        resume() { paused = false; if (!asleep) requestDraw(); },
        redraw() { posCache = null; requestDraw(); },
        // Checks only: draw one body frame at an exact phase with every spring
        // and eased value settled, so it can be compared with the playground's.
        debugFrame(o = {}) {
          const t = o.t == null ? nowMs() / 1000 : o.t;
          phase = o.phase || 0; stateStart = t - (o.sinceState || 0);
          gesture = null; residual = null; posCache = null;
          resetSprings(t);
          eased.speed = SPEC.states[state].motion[0];
          syncTint(t); if (tint.name) tint.start = t - AC.lap;
          drawBody(t);
        },
        // Checks only: what the colour is doing right now.
        tintStats() {
          const t = nowMs() / 1000; syncTint(t);
          const c = tintShown(t);
          return { name: tint.name, core: c.core, cov: c.cov, glow: c.glow, rgb: c.rgb ? c.rgb.slice() : null, mic: micShown, moving: tintMoving(t) };
        },
        // Checks only: the points this frame would draw.
        debugPoints() { return bodyPoints(effectivePose(nowMs() / 1000)).map((q) => ({ x: q.x, y: q.y })); },
        stats() {
          return { state, asleep, sleeping: state === 'sleeping', reduced, frozen, held, backdrop, renderScheduled: !!raf, bodyDraws: counters.body, threadDraws: counters.thread, frames: counters.frames, drawCalls: counters.calls, errors: counters.errors, gesture: gesture ? gesture.name : null, travelling: !!travel, tracing: !!travel && travel.kind === 'trace', mark: mark ? { phase: mark.phase, u: mark.u } : null, pose: effectivePose(nowMs() / 1000), shape: { flat: shape.flat.x, face: shape.face.x, loose: shape.loose.x, slack: shape.slack.x, mirror: shape.mirror.x, spin }, phase: thread ? thread.phase : null, kind: thread ? thread.kind : null };
        },
        destroy() {
          if (raf) cancelAnimationFrame(raf); raf = 0; paused = true;
          if (quietTimer) { clearTimeout(quietTimer); quietTimer = 0; }
          window.removeEventListener('resize', onResize);
          if (mq && mq.removeEventListener) mq.removeEventListener('change', onMotion);
        },
      },
      thread: {
        // Point at a box (window CSS px). The thread reaches, taps and holds;
        // if it is already out, the tip swings there.
        setTarget(rect, o = {}) {
          if (!rect) { api.thread.rewind(); return false; }
          const target = { x: Number(rect.x) || 0, y: Number(rect.y) || 0, w: Math.max(1, Number(rect.w) || 1), h: Math.max(1, Number(rect.h) || 1) };
          if (o.task != null && strand) strand.dataset.task = String(o.task);
          posCache = null;
          return startThread('guide', targetAnchor(target, position()), { target });
        },
        // Little acrobat: the thread climbs onto the nearer top corner of a
        // window or card and curls round it.
        perch(targetBox, frontWindow, o = {}) {
          const a = targetBox, b = frontWindow || targetBox, A = IN.acrobat, R = SPEC.moves.curlRadius;
          const r = { left: Math.max(a.x, b.x), right: Math.min(a.x + a.w, b.x + b.w), top: Math.max(a.y, b.y), bottom: Math.min(a.y + a.h, b.y + b.h) };
          if (r.right <= r.left || r.bottom <= r.top) return false;
          if (o.task != null && strand) strand.dataset.task = String(o.task);
          posCache = null;
          const pos = position(), right = Math.abs(pos.x - r.right) < Math.abs(pos.x - r.left), corner = vec(right ? r.right : r.left, r.top), sign = right ? -1 : 1;
          const start = vec(corner.x - sign * A.offset, corner.y + A.offset), curl = [start, vec(start.x, corner.y)];
          for (let i = 1; i <= A.segments; i++) { const angle = Math.PI - i / A.segments * Math.PI * A.sweep; curl.push(vec(corner.x + sign * R * Math.cos(angle), corner.y + R * Math.sin(angle))); }
          return startThread('guide', start, { curl, corner, target: null });
        },
        // A surface by the Knot: the thread reaches to the corner the surface
        // opens from. Guide logic never sees this move.
        reachTo(point, o = {}) {
          if (guideOut()) return false;
          if (thread && thread.kind === 'surface' && thread.phase !== 'rewind' && length(sub(thread.destination, point)) < 1) { if (o.onArrive) { if (thread.phase === 'hold' || thread.phase === 'tap') o.onArrive(); else thread.onArrive = o.onArrive; } return true; }
          return startThread('surface', point, o);
        },
        releaseSurface(onDone) { if (thread && thread.kind === 'surface' && !thread.silent) startRewind(onDone); else if (onDone) onDone(); },
        surfaceOut() { return !!thread && thread.kind === 'surface' && thread.phase !== 'rewind'; },
        surfaceArrived() { return !!thread && thread.kind === 'surface' && (thread.phase === 'hold' || thread.phase === 'tap'); },
        rewind() {
          // Dismissed while it is still flying there: nothing to wind back.
          // Mid-trace it stops where it is and the mark reels in.
          if (lassoFlying()) {
            const t = nowMs() / 1000;
            if (travel.kind === 'trace' || travel.chain) { const p = position(); travel = null; hooks.place(p, true); posCache = null; }
            else travel.lasso = null;
            if (mark) startMarkRewind(t);
            hooks.onRewound(); requestDraw(); return;
          }
          if (mark && !thread && mark.phase !== 'rewind') { startMarkRewind(nowMs() / 1000); requestDraw(); }
          if (guideOut() && thread.phase !== 'rewind' && thread.phase !== 'uncurl') startRewind();
        },
        // A surface is open on the thread: once the tip has settled the strand
        // and the body's shape hold still until it closes.
        setHeld(v) { held = !!v; if (!held) unfreeze(); requestDraw(); },
        isFrozen() { return frozen; },
        // Three short lines at the tip as the surface opens.
        burst(tip) { if (reduced || !thread || thread.lasso) return; burst = { tip: vec(tip.x, tip.y), start: nowMs() / 1000 }; growBounds([vec(tip.x - 20, tip.y - 20), vec(tip.x + 20, tip.y + 20)]); requestDraw(); },
        // The introduction: the tip draws the bubble's outline by hand.
        trace(f, radius, onDone) {
          if (!thread || reduced) { if (onDone) onDone(); return false; }
          const tip = thread.destination, path = roundedOutline({ x: f.x, y: f.y, w: f.w, h: f.h, tip }, radius == null ? IN.surface.outlineRadius : radius);
          unfreeze();
          trace = { path, u: 0, phase: 'draw', start: nowMs() / 1000, onDone: onDone || null };
          growBounds(path.points);
          requestDraw();
          return true;
        },
        setTask(task) { if (strand) strand.dataset.task = String(task || ''); threadDirty = true; requestDraw(); },
        getTip() { if (!thread || !thread.path) return null; if (thread.lasso) return vec(thread.lasso.far.x, thread.lasso.far.y); const p = pathAt(thread.path, thread.path.total * thread.u); return { x: p.x, y: p.y }; },
        getTarget() { return thread && thread.target ? Object.assign({}, thread.target) : null; },
        getCorner() { return thread && thread.corner ? Object.assign({}, thread.corner) : null; },
        // What guide logic asks: idle | unwinding | pointing | rewinding.
        getState() {
          if (!guideOut()) return 'idle';
          if (!thread || thread.silent) return 'unwinding';
          const ph = thread.phase;
          return ph === 'reach' || ph === 'swing' || ph === 'lasso' ? 'unwinding' : ph === 'rewind' || ph === 'uncurl' ? 'rewinding' : 'pointing';
        },
        isOut() { return !!thread; },
        isLasso() { return !!thread && !!thread.lasso && !thread.silent; },
        // "Circle it": the line is thrown round the control again.
        replayLasso() {
          if (!thread || !thread.lasso || thread.silent || thread.phase === 'rewind') return false;
          const t = nowMs() / 1000;
          thread.u = 0; thread.phase = 'lasso'; thread.phaseStart = t; thread.lassoStart = t; thread.arrivedFired = true; threadDirty = true;
          requestDraw();
          return true;
        },
        getProgress() { return thread ? thread.u : 0; },
        relayout,
        setCallbacks(next) { Object.assign(hooks, next || {}); },
        setReducedMotion(v) { api.knot.setReducedMotion(v); },
        pause() {}, resume() { requestDraw(); },
        destroy() {},
      },
    };

    resizeBody();
    shape.mirror.x = side();
    if (reduced) { renderStatic(); body.classList && body.classList.add('knot-static'); }
    else requestDraw();
    return api;
  }

  window.NusKnotEngine = { mount, paths: { bowedPath, pathTable, pathAt, prefix, blendPoints, roundedOutline } };
})();
