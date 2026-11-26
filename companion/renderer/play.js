// Play: one small game with the Knot, started on purpose (the Knot's menu or
// the tray), never in the middle of a task. Pranav, 2026-11-15: "when i see the
// companion in the bottom right i just like moving it around and playing with
// it, and my friend did the same thing". Then: "make it more entertaining and
// better looking, and a LOT more satisfying to play".
//
// The game is hoops. Grab the Knot, throw it. It spins, bounces off the screen's
// edges, the rim and the backboard, and falls back down.
//   Make     1 point. A swish (nothing touched) or a bank shot (board, no rim) is 2.
//   Streak   3 makes in a row and it is on fire: every make counts double.
//   Miss     it lands on the floor without going in. The streak ends.
//   Levels   every 3 makes the hoop moves; from level 3 it drifts, from 5 it bobs.
// (Three games were built first, toss, hoop and tag, then ruled down to this one.
// The others are in ventures/nus/promo/play-1116/three-games.patch.)
//
// The host (renderer.js) owns the Knot's layout, the mouse and the rule that a
// task always wins: any ask, the hotkey, a guide step or a state change calls
// stop('task'). This file is the game's rules and physics. What it looks and
// sounds like is play-fx.js and play-sound.js, fed through host.emit (events)
// and host.draw (one call a frame). Every number is in knot-spec.js (host.play).
//
// Pure apart from the doc it draws the score line into, so it runs in plain Node.
(function (root) {
  'use strict';

  const MAKE_GAP_MS = 400;        // one pass through the rim is one make
  const MOVE_AFTER_MS = 480;      // the swish plays out before the hoop moves
  const CONTACT_GAP_MS = 70;      // one touch of the rim or board is one event

  // ---- pure physics -----------------------------------------------------------

  // The ball in the air for one step. s: { p, v, onFloor, spin, rot }. b: { w, h, m }.
  // Returns events: ['wall'|'floor'|'rest', impact px/s, normal 'x'|'y'].
  function stepBall(s, dt, b, P) {
    const ev = [];
    const p = s.p, v = s.v;
    if (!s.onFloor) v.y += P.gravity * dt;
    const keep = Math.max(0, 1 - P.air * dt);
    v.x *= keep; if (!s.onFloor) v.y *= keep;
    const sp = Math.hypot(v.x, v.y);
    if (sp > P.throwMax) { v.x *= P.throwMax / sp; v.y *= P.throwMax / sp; }
    p.x += v.x * dt; p.y += v.y * dt;
    const lo = b.m, hiX = b.w - b.m, hiY = b.h - b.m;
    if (p.x < lo) { p.x = lo; if (v.x < 0) { ev.push(['wall', -v.x, 'x']); v.x = -v.x * P.wall; s.spin = -(s.spin || 0) * 0.6; } }
    if (p.x > hiX) { p.x = hiX; if (v.x > 0) { ev.push(['wall', v.x, 'x']); v.x = -v.x * P.wall; s.spin = -(s.spin || 0) * 0.6; } }
    if (p.y < lo) { p.y = lo; if (v.y < 0) { ev.push(['wall', -v.y, 'y']); v.y = -v.y * P.wall; } }
    if (p.y >= hiY) {
      p.y = hiY;
      if (v.y > 0) {
        ev.push(['floor', v.y, 'y']);
        v.y = -v.y * P.floor;
        // Too small a hop to see: it is rolling now.
        if (Math.abs(v.y) < 140) { v.y = 0; s.onFloor = true; }
      }
    } else if (s.onFloor && v.y < 0) s.onFloor = false;
    if (s.onFloor) {
      v.x *= Math.max(0, 1 - P.floorFriction * dt);
      if (Math.abs(v.x) < P.restSpeed) { v.x = 0; ev.push(['rest', 0, 'y']); }
      // Rolling: it turns exactly as far as it travels.
      s.spin = v.x / P.radius;
    } else s.spin = (s.spin || 0) * Math.max(0, 1 - 0.4 * dt);
    // What the eye sees turns no faster than spinMax: a true roll at these speeds
    // is a blur of 5 to 10 turns a second (Pranav, 2026-11-15: "spins rapidly").
    const turn = Math.max(-P.spinMax, Math.min(P.spinMax, s.spin || 0));
    s.rot = ((s.rot || 0) + turn * dt) % (Math.PI * 2);
    return ev;
  }

  // Where the hoop's parts are. side: +1 the board is on the right, -1 on the left.
  function hoopParts(h, P) {
    const H = P.hoop, r = h.r;
    const boardX = h.x + h.side * (r + H.boardGap * r);
    return {
      front: { x: h.x - h.side * r, y: h.y },            // the open side's rim end
      back: { x: h.x + h.side * r, y: h.y },             // the rim end at the board
      board: { x: boardX, top: h.y - H.boardUp * r, bottom: h.y + H.boardDown * r },
    };
  }

  // The ball against the rim ends and the board, then the make test.
  // Returns { made, rim, board } (rim/board: impact speed, 0 if none).
  function stepHoop(s, prevY, h, P) {
    const out = { made: false, rim: 0, board: 0 };
    const parts = hoopParts(h, P);
    const R = P.radius * 0.8 + P.hoop.rimR;
    for (const end of [parts.front, parts.back]) {
      const dx = s.p.x - end.x, dy = s.p.y - end.y, d = Math.hypot(dx, dy);
      if (d > 0 && d < R) {
        const nx = dx / d, ny = dy / d;
        s.p.x = end.x + nx * R; s.p.y = end.y + ny * R;
        const vn = s.v.x * nx + s.v.y * ny;
        if (vn < 0) { s.v.x -= (1 + P.hoop.rimBounce) * vn * nx; s.v.y -= (1 + P.hoop.rimBounce) * vn * ny; out.rim = Math.max(out.rim, -vn); }
      }
    }
    // The board: a vertical plank. Its face is the side toward the rim.
    const b = parts.board, half = P.radius * 0.82;
    if (s.p.y > b.top - half && s.p.y < b.bottom + half) {
      const dx = s.p.x - b.x;
      if (Math.abs(dx) < half + 4) {
        const inY = s.p.y >= b.top && s.p.y <= b.bottom;
        if (inY) {
          const dir = dx === 0 ? -h.side : Math.sign(dx);
          s.p.x = b.x + dir * (half + 4);
          if (s.v.x * dir < 0) { out.board = Math.abs(s.v.x); s.v.x = -s.v.x * P.hoop.boardBounce; s.spin = -(s.spin || 0) * 0.5; }
        } else {
          // The board's top or bottom edge: a corner.
          const ey = s.p.y < b.top ? b.top : b.bottom, ex = b.x;
          const cx = s.p.x - ex, cy = s.p.y - ey, d = Math.hypot(cx, cy);
          if (d > 0 && d < half + 4) {
            const nx = cx / d, ny = cy / d;
            s.p.x = ex + nx * (half + 4); s.p.y = ey + ny * (half + 4);
            const vn = s.v.x * nx + s.v.y * ny;
            if (vn < 0) { s.v.x -= 1.7 * vn * nx; s.v.y -= 1.7 * vn * ny; out.board = -vn; }
          }
        }
      }
    }
    const lo = Math.min(parts.front.x, parts.back.x), hi = Math.max(parts.front.x, parts.back.x), inset = P.radius * 0.45;
    out.made = prevY < h.y && s.p.y >= h.y && s.v.y > 0 && s.p.x > lo + inset && s.p.x < hi - inset;
    return out;
  }

  // A light pull toward the hoop for a ball already coming down near it, so a
  // shot that deserved to go in usually does. Pure: returns the x acceleration.
  function assistPull(s, h, P) {
    const A = P.assist;
    if (!A || s.v.y <= 0 || s.p.y >= h.y) return 0;
    const dx = s.p.x - h.x, reach = A.reach * h.r;
    if (Math.abs(dx) > reach || h.y - s.p.y > A.above * h.r) return 0;
    return -Math.sign(dx) * A.pull * (1 - Math.abs(dx) / reach);
  }

  // A throw from the hand's speed, or none if the hand had stopped.
  function throwOf(v, msSinceMove, P) {
    if (!v || msSinceMove > P.releaseStaleMs) return { x: 0, y: 0 };
    const sp = Math.hypot(v.x, v.y);
    if (sp < P.throwMin) return { x: 0, y: 0 };
    const k = sp > P.throwMax ? P.throwMax / sp : 1;
    return { x: v.x * k, y: v.y * k };
  }

  // Points for one make. kind: 'swish' | 'bank' | 'in'. streak: makes in a row, this one included.
  function pointsFor(kind, streak, P) {
    const S = P.score, base = kind === 'swish' ? S.swish : kind === 'bank' ? S.bank : S.make;
    return base * (streak >= S.fireAt ? S.fireMul : 1);
  }
  function levelOf(makes, P) { return 1 + Math.floor(makes / P.hoop.makesPerLevel); }
  // How the hoop moves at a level: drift (fraction of the width) and speed (rad/s), bob (fraction of the height).
  function motionFor(level, P) {
    const M = P.hoop.motion, i = Math.min(level - 1, M.length - 1);
    return M[Math.max(0, i)];
  }

  // A spring for squash: x is the compression, pushed by impacts, back to 0.
  function stepSpring(sp, dt, k, damp) {
    sp.v += (-k * sp.x - damp * sp.v) * dt;
    sp.x += sp.v * dt;
    if (Math.abs(sp.x) < 1e-4 && Math.abs(sp.v) < 1e-3) { sp.x = 0; sp.v = 0; }
  }

  function create({ doc, spec, host }) {
    const P = spec;
    const now = host.now || (() => Date.now());
    const raf = host.raf || ((fn) => setTimeout(() => fn(now()), 16));
    const caf = host.caf || ((id) => clearTimeout(id));
    const emit = (e) => { if (host.emit) host.emit(e); };
    const st = {
      on: false, s: null, held: false, loop: 0, idle: 0, last: 0, startedAt: 0, touchedAt: 0,
      makes: 0, score: 0, streak: 0, level: 1, hoop: null, madeAt: -1e9, moveAt: 0, stopUntil: 0,
      shot: null, rimAt: -1e9, boardAt: -1e9, bestAtStart: 0, newBest: false,
      sqx: { x: 0, v: 0 }, sqy: { x: 0, v: 0 },
    };

    function best() { const v = Number(host.store && host.store.get('play.best.hoop')); return Number.isFinite(v) && v > 0 ? v : 0; }
    function setBest(v) { if (host.store) host.store.set('play.best.hoop', String(v)); }

    // ---- the score line (DOM) ----------------------------------------------------
    let field = null, hud = null, scoreEl = null, bestEl = null, fireEl = null, shownScore = -1;
    function make(tag, cls, text) { const n = doc.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = String(text); return n; }
    function build() {
      if (hud || !doc) return;
      // The field: while the game is on, the screen is the court. It holds the
      // mouse so a missed grab never lands on the app underneath. A right click
      // anywhere ends the game.
      field = make('div', ''); field.id = 'play-field'; field.hidden = true;
      field.addEventListener('contextmenu', (e) => { e.preventDefault(); stop('user'); });
      hud = make('div', ''); hud.id = 'play-hud'; hud.hidden = true; hud.setAttribute('role', 'group'); hud.setAttribute('aria-label', 'Hoops');
      scoreEl = make('span', 'p-score', '0'); scoreEl.setAttribute('role', 'status'); scoreEl.setAttribute('aria-live', 'polite');
      fireEl = make('span', 'p-fire', '2×'); fireEl.hidden = true; fireEl.setAttribute('aria-label', 'On fire, double points');
      bestEl = make('span', 'p-best', '');
      const x = make('button', 'p-close', '×'); x.type = 'button'; x.setAttribute('aria-label', 'Stop playing');
      x.addEventListener('click', () => stop('user'));
      hud.appendChild(scoreEl); hud.appendChild(fireEl); hud.appendChild(bestEl); hud.appendChild(x);
      doc.body.insertBefore(field, doc.body.firstChild);
      doc.body.appendChild(hud);
    }
    function paintScore() {
      if (!scoreEl) return;
      if (st.score !== shownScore) {
        const up = st.score > shownScore && shownScore >= 0;
        shownScore = st.score; scoreEl.textContent = String(st.score);
        if (up) { scoreEl.classList.remove('pop'); void scoreEl.offsetWidth; scoreEl.classList.add('pop'); }
      }
      const b = Math.max(best(), st.score);
      const bt = b ? 'best ' + b : '';
      if (bestEl.textContent !== bt) bestEl.textContent = bt;
      const fire = st.streak >= P.score.fireAt;
      if (fireEl.hidden === fire) fireEl.hidden = !fire;
      hud.classList.toggle('fire', fire);
      hud.classList.toggle('record', st.newBest);
    }

    // ---- the loop ------------------------------------------------------------------
    function wake() { if (st.idle) { clearTimeout(st.idle); st.idle = 0; } if (!st.loop && st.on) { st.last = now(); st.loop = raf(frame); } }
    function frame() {
      st.loop = 0;
      if (!st.on) return;
      const t = now(), dt = Math.min(0.033, Math.max(0, (t - st.last) / 1000)); st.last = t;
      if (t - st.touchedAt > P.idleEndMs) { stop('idle'); return; }
      const b = host.bounds();
      if (st.moveAt && t >= st.moveAt) { st.moveAt = 0; placeHoop(true); }
      // The hoop's own motion, from level 3.
      const h = st.hoop, mo = motionFor(st.level, P);
      let hoopMoving = false;
      if (h && (mo.drift || mo.bob)) {
        h.phase += mo.speed * dt;
        h.x = h.baseX + mo.drift * b.w * Math.sin(h.phase);
        h.y = h.baseY + mo.bob * b.h * Math.sin(h.phase * 1.37);
        hoopMoving = true;
      }
      let moving = false;
      const s = st.s;
      const frozen = t < st.stopUntil;   // the beat of stillness after a make
      if (!st.held && !frozen && !s.resting) {
        const prevY = s.p.y;
        if (h) s.v.x += assistPull(s, h, P) * dt;
        const ev = stepBall(s, dt, b, P);
        if (h) {
          const hit = stepHoop(s, prevY, h, P);
          if (hit.rim > 60 && t - st.rimAt > CONTACT_GAP_MS) { st.rimAt = t; if (st.shot) st.shot.rim = true; emit({ type: 'rim', impact: hit.rim, x: s.p.x, y: s.p.y }); kick(hit.rim, 'x'); }
          if (hit.board > 60 && t - st.boardAt > CONTACT_GAP_MS) { st.boardAt = t; if (st.shot) st.shot.board = true; emit({ type: 'board', impact: hit.board, x: s.p.x, y: s.p.y }); kick(hit.board, 'x'); }
          if (hit.made && t - st.madeAt > MAKE_GAP_MS) made(t);
        }
        for (const [kind, impact, normal] of ev) {
          if (kind === 'wall' || kind === 'floor') { if (impact > 120) emit({ type: kind, impact, x: s.p.x, y: s.p.y, normal }); kick(impact, normal); }
          if (kind === 'floor' && st.shot) missed();
          if (kind === 'rest') s.resting = true;
        }
        moving = !s.resting;
      }
      stepSpring(st.sqx, dt, P.squash.k, P.squash.damp);
      stepSpring(st.sqy, dt, P.squash.k, P.squash.damp);
      const squashing = st.sqx.x !== 0 || st.sqy.x !== 0;
      const sx = 1 - st.sqx.x + st.sqy.x * 0.6, sy = 1 - st.sqy.x + st.sqx.x * 0.6;
      if (!st.held) host.place({ x: s.p.x, y: s.p.y, rot: s.rot || 0, sx, sy });
      paintScore();
      const drawing = host.draw ? host.draw(dt, view(t)) : false;
      // Nothing moving, nothing animating: the loop sleeps until the next throw,
      // and wakes once a second for the idle check.
      if (moving || st.held || frozen || squashing || hoopMoving || st.moveAt || drawing) st.loop = raf(frame);
      else { clearTimeout(st.idle); st.idle = setTimeout(() => { st.idle = 0; wake(); }, 1000); }
    }
    function view(t) {
      const s = st.s;
      return {
        ball: { x: s.p.x, y: s.p.y, vx: s.v.x, vy: s.v.y, held: st.held, resting: !!s.resting },
        hoop: st.hoop ? Object.assign({ parts: hoopParts(st.hoop, P) }, st.hoop) : null,
        fire: st.streak >= P.score.fireAt, level: st.level, frozen: t < st.stopUntil,
      };
    }
    // An impact squashes the Knot along the impact's direction.
    function kick(impact, normal) {
      const amt = Math.min(P.squash.max, impact * P.squash.per);
      if (normal === 'x') st.sqx.v += amt * P.squash.k * 0.06; else st.sqy.v += amt * P.squash.k * 0.06;
    }
    function made(t) {
      const shot = st.shot || { rim: true, board: false };
      const kind = !shot.rim && !shot.board ? 'swish' : !shot.rim && shot.board ? 'bank' : 'in';
      st.shot = null; st.madeAt = t; st.makes++; st.streak++;
      const pts = pointsFor(kind, st.streak, P);
      st.score += pts;
      const level = levelOf(st.makes, P);
      const before = st.bestAtStart;
      let record = false;
      if (st.score > best()) setBest(st.score);
      if (!st.newBest && before > 0 && st.score > before) { st.newBest = true; record = true; }
      st.stopUntil = t + (kind === 'in' ? P.hitstopMs * 0.6 : P.hitstopMs);
      const h = st.hoop;
      emit({ type: 'make', kind, points: pts, streak: st.streak, fire: st.streak >= P.score.fireAt, fireStart: st.streak === P.score.fireAt, x: h.x, y: h.y, makes: st.makes });
      if (record) emit({ type: 'record', score: st.score, x: h.x, y: h.y });
      if (host.gesture) host.gesture('done');
      if (level !== st.level) { st.level = level; st.moveAt = t + MOVE_AFTER_MS; }
    }
    function missed() {
      st.shot = null;
      const had = st.streak;
      st.streak = 0;
      emit({ type: 'miss', streak: had, x: st.s.p.x, y: st.s.p.y });
    }
    function placeHoop(moving) {
      const b = host.bounds(), H = P.hoop, r = Math.min(H.r, b.w * 0.07);
      const mo = motionFor(st.level, P), drift = mo.drift * b.w;
      const lo = H.margin * b.w + r * 2 + drift, hi = (1 - H.margin) * b.w - r * 2 - drift;
      const rnd = host.random || Math.random;
      let x;
      if (!moving || !st.hoop) {
        // First on the far side from where the Knot started.
        const homeLeft = st.s ? st.s.p.x < b.w / 2 : false;
        x = homeLeft ? Math.max(lo, hi) : Math.min(lo, hi);
      } else {
        // A move is a real move: at least a quarter of the way across.
        x = st.hoop.baseX;
        for (let i = 0; i < 12; i++) { x = lo + rnd() * Math.max(0, hi - lo); if (Math.abs(x - st.hoop.baseX) >= Math.abs(hi - lo) * 0.25) break; }
      }
      const y = b.h * (H.minY + rnd() * (H.maxY - H.minY));
      // The board goes on the outside, so the open side faces the screen.
      const side = x > b.w / 2 ? 1 : -1;
      const prev = st.hoop;
      st.hoop = { x: Math.round(x), y: Math.round(y), baseX: Math.round(x), baseY: Math.round(y), r, side, phase: 0 };
      emit({ type: moving ? 'hoopMove' : 'hoopIn', from: prev ? { x: prev.x, y: prev.y } : null, hoop: Object.assign({}, st.hoop), level: st.level, drifts: !!(mo.drift || mo.bob) });
    }

    // ---- the host's handles ----------------------------------------------------------
    function start(at) {
      if (st.on) return;
      build();
      st.on = true; st.held = false; st.startedAt = st.touchedAt = now();
      st.s = { p: { x: at.x, y: at.y }, v: { x: 0, y: -260 }, onFloor: false, resting: false, spin: 0, rot: 0 };
      st.makes = 0; st.score = 0; st.streak = 0; st.level = 1; st.madeAt = -1e9; st.moveAt = 0; st.stopUntil = 0; st.shot = null;
      st.bestAtStart = best(); st.newBest = false; shownScore = -1;
      st.sqx = { x: 0, v: 0 }; st.sqy = { x: 0, v: 0 };
      st.hoop = null;
      emit({ type: 'start' });
      placeHoop(false);
      if (field) field.hidden = false;
      if (hud) hud.hidden = false;
      if (doc && doc.body) doc.body.classList.add('playing');
      paintScore();
      if (host.log) host.log('[play] start');
      wake();
    }
    function stop(reason) {
      if (!st.on) return null;
      const seconds = Math.round((now() - st.startedAt) / 1000);
      st.on = false; st.held = false;
      if (st.loop) { caf(st.loop); st.loop = 0; }
      if (st.idle) { clearTimeout(st.idle); st.idle = 0; }
      if (field) field.hidden = true;
      if (hud) hud.hidden = true;
      if (doc && doc.body) doc.body.classList.remove('playing');
      if (host.lean) host.lean(null);
      const at = st.s ? { x: st.s.p.x, y: st.s.p.y } : null;
      emit({ type: 'stop', reason: reason || 'user' });
      if (host.log) host.log('[play] end ' + seconds + 's score ' + st.score + ' makes ' + st.makes + ' ' + (reason || ''));
      st.hoop = null;
      if (host.onEnd) host.onEnd(reason || 'user', at);
      return at;
    }
    // A press on the Knot: the hand has it, mid-air or at rest. A shot in the air
    // that is caught again is no miss.
    function press(at) {
      if (!st.on) return;
      st.touchedAt = now(); st.held = true; st.shot = null; st.stopUntil = 0;
      if (at) st.s.p = { x: at.x, y: at.y };
      st.s.v = { x: 0, y: 0 }; st.s.resting = false; st.s.onFloor = false; st.s.spin = 0;
      emit({ type: 'catch', x: st.s.p.x, y: st.s.p.y });
      wake();
    }
    function dragTo(at) { if (st.on && st.held && at) { st.s.p = { x: at.x, y: at.y }; st.touchedAt = now(); } }
    // Let go. v: the hand's speed (px/s), msSinceMove: how long it had been still.
    function release(at, v, msSinceMove) {
      if (!st.on || !st.held) return;
      st.held = false; st.touchedAt = now();
      if (at) st.s.p = { x: at.x, y: at.y };
      const thrown = throwOf(v, msSinceMove, P);
      st.s.v = thrown; st.s.resting = false; st.s.onFloor = false;
      st.s.spin = thrown.x / P.radius * P.spin;
      const speed = Math.hypot(thrown.x, thrown.y);
      // Only a real throw is a shot; a let-go just drops.
      st.shot = speed > 0 ? { rim: false, board: false } : null;
      if (speed > 0) emit({ type: 'throw', speed, x: st.s.p.x, y: st.s.p.y });
      wake();
    }

    return {
      start, stop, press, dragTo, release,
      get active() { return st.on; },
      get held() { return st.held; },
      position() { return st.s ? { x: st.s.p.x, y: st.s.p.y } : null; },
      // For tests and the CDP checks.
      _state: st,
    };
  }

  const api = { create, stepBall, stepHoop, hoopParts, assistPull, throwOf, pointsFor, levelOf, motionFor, stepSpring };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NusPlay = api;
})(typeof window !== 'undefined' ? window : globalThis);
