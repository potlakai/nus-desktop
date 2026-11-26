// What the hoops game looks like (play.js has the rules). Two canvases, made when
// a game starts and thrown away when it ends, so nothing is left drawing or
// holding memory when nobody is playing:
//   back   under the Knot: its shadow, its trail, the backboard, the rim's far half
//   front  over the Knot:  the net, the rim's near half, sparks, confetti, words
// so the Knot really drops through the hoop. The Knot's own look throughout:
// white with an ink outline, colour only for something happening (the palette
// in knot-spec.js). The rim is the error coral, the one warm red the Knot owns.
//
// draw(dt, view) is called once a frame by play.js and says whether anything is
// still moving, so the game's loop can sleep when the court is still.
(function (root) {
  'use strict';

  const TAU = Math.PI * 2;
  const MAX_PARTICLES = 220;
  const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
  const easeOut = (t) => 1 - Math.pow(1 - clamp(t), 3);
  function easeOutBack(t) { t = clamp(t); const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); }
  function spring(s, dt, k, d) { s.v += (-k * s.x - d * s.v) * dt; s.x += s.v * dt; if (Math.abs(s.x) < 1e-3 && Math.abs(s.v) < 1e-2) { s.x = 0; s.v = 0; return false; } return true; }

  function create({ doc, view, spec, palette, font }) {
    const P = spec;
    const R = P.radius;
    const C = {
      ink: 'rgb(13,15,25)', inkSoft: 'rgba(13,15,25,.55)', white: palette.idle,
      rim: palette.error, amber: palette.thinking, violet: palette.listening, blue: palette.speaking, green: palette.done,
    };
    const CONFETTI = [C.rim, C.amber, C.violet, C.blue, C.green, C.white];
    const FONT = font || 'system-ui, sans-serif';
    let back = null, front = null, bx = null, fx = null, dpr = 1, W = 0, H = 0;
    let parts = [], words = [], trail = [], clock = 0;
    const net = { stretch: { x: 0, v: 0 }, sway: { x: 0, v: 0 } };
    const rimDy = { x: 0, v: 0 }, boardDx = { x: 0, v: 0 };
    const pop = { x: 1, v: 0 };          // the hoop's scale: 0 when it appears, springs to 1
    let ghost = null;                    // the old hoop shrinking away after a move
    let lastHoop = null, emberAt = 0;

    function canvas(id, z) {
      const c = doc.createElement('canvas');
      c.id = id;
      c.setAttribute('aria-hidden', 'true');
      c.style.cssText = 'position:fixed;left:0;top:0;pointer-events:none;z-index:' + z;
      doc.body.appendChild(c);
      return c;
    }
    function size() {
      if (!back) return;
      W = view.innerWidth; H = view.innerHeight;
      // Sharp on a high-density screen, never more than twice the CSS pixels.
      dpr = Math.min(2, Math.max(1, view.devicePixelRatio || 1));
      for (const c of [back, front]) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); c.style.width = W + 'px'; c.style.height = H + 'px'; }
    }
    function start() {
      if (back) return;
      back = canvas('play-back', 1); front = canvas('play-front', 3);
      bx = back.getContext('2d'); fx = front.getContext('2d');
      size();
      view.addEventListener('resize', size);
      parts = []; words = []; trail = []; ghost = null; lastHoop = null;
      net.stretch.x = net.stretch.v = net.sway.x = net.sway.v = 0;
      rimDy.x = rimDy.v = boardDx.x = boardDx.v = 0;
      pop.x = 0; pop.v = 0;
    }
    // Gone, not hidden: the canvases are removed and their memory freed.
    function stop() {
      if (!back) return;
      view.removeEventListener('resize', size);
      for (const c of [back, front]) { c.width = 0; c.height = 0; c.remove(); }
      back = front = bx = fx = null;
      parts = []; words = []; trail = []; ghost = null; lastHoop = null;
    }

    // ---- what happens -------------------------------------------------------------
    function rnd(a, b) { return a + Math.random() * (b - a); }
    function add(p) { if (parts.length < MAX_PARTICLES) parts.push(p); }
    function sparks(x, y, n, speed, colors, dir) {
      for (let i = 0; i < n; i++) {
        const a = dir == null ? rnd(0, TAU) : dir + rnd(-1.1, 1.1), sp = speed * rnd(0.45, 1.1);
        add({ k: 'spark', x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0, max: rnd(0.32, 0.55), c: colors[i % colors.length], w: rnd(2.2, 3.4) });
      }
    }
    function confetti(x, y, n, spread) {
      for (let i = 0; i < n; i++) {
        add({ k: 'conf', x: x + rnd(-spread, spread), y: y + rnd(-20, 10), vx: rnd(-320, 320), vy: rnd(-760, -260), life: 0, max: rnd(1.3, 2), c: CONFETTI[i % CONFETTI.length], rot: rnd(0, TAU), vr: rnd(-12, 12), w: rnd(7, 11), h: rnd(4, 6) });
      }
    }
    function dust(x, y, normal, impact) {
      const n = impact > 1600 ? 6 : 4;
      for (let i = 0; i < n; i++) {
        const along = (i / (n - 1) - 0.5) * 2;
        const vx = normal === 'y' ? along * rnd(90, 200) : (x < W / 2 ? 1 : -1) * rnd(30, 90);
        const vy = normal === 'y' ? -rnd(30, 90) : along * rnd(90, 200);
        add({ k: 'dust', x, y: normal === 'y' ? y + R * 0.8 : y, vx, vy, life: 0, max: rnd(0.3, 0.45), r: rnd(3, 6) });
      }
    }
    function word(text, x, y, opts = {}) {
      // Always on screen, with room for its rise, clear of the score line at the top.
      const size = opts.size || 30, rise = opts.rise == null ? 54 : opts.rise;
      y = Math.max(y, 64 + rise + size * 0.6);
      x = Math.max(size * text.length * 0.36 + 8, Math.min(W - size * text.length * 0.36 - 8, x));
      words.push({ text, x, y, life: 0, max: opts.max || 1.05, size: opts.size || 30, color: opts.color || C.white, sub: opts.sub || '', subColor: opts.subColor || C.white, rise: opts.rise == null ? 54 : opts.rise });
      if (words.length > 6) words.shift();
    }

    function event(e) {
      if (!back) return;
      switch (e.type) {
        case 'hoopIn': pop.x = 0; pop.v = 0; lastHoop = e.hoop; break;
        case 'hoopMove':
          if (e.from && lastHoop) ghost = { hoop: Object.assign({}, lastHoop, { x: e.from.x, y: e.from.y }), life: 0 };
          pop.x = 0; pop.v = 0; lastHoop = e.hoop;
          if (e.drifts && e.level === 3) word('It moves now', e.hoop.x, e.hoop.y - e.hoop.r * 1.9, { size: 22, color: C.amber, max: 1.4 });
          else word('Level ' + e.level, e.hoop.x, e.hoop.y - e.hoop.r * 1.9, { size: 20, max: 1.1 });
          break;
        case 'floor': case 'wall':
          if (e.impact > 700) dust(e.x, e.y, e.normal, e.impact);
          break;
        case 'rim':
          rimDy.v += clamp(e.impact / 1800, 0.15, 1) * 90;
          net.sway.v += (Math.random() < 0.5 ? -1 : 1) * clamp(e.impact / 1500, 0.2, 1) * 4;
          sparks(e.x, e.y, 3, 260, [C.rim, C.white]);
          break;
        case 'board':
          boardDx.v += clamp(e.impact / 1800, 0.15, 1) * 70 * (lastHoop ? lastHoop.side : 1);
          sparks(e.x, e.y, 2, 200, [C.white]);
          break;
        case 'catch':
          add({ k: 'ring', x: e.x, y: e.y, life: 0, max: 0.28 });
          break;
        case 'make': {
          const swish = e.kind === 'swish';
          net.stretch.v += swish ? 9 : 6;
          net.sway.v += (Math.random() - 0.5) * 3;
          const colors = e.fire ? [C.amber, C.rim, C.white] : swish ? [C.white, C.green, C.blue] : [C.white, C.violet];
          sparks(e.x, e.y + 10, e.fire ? 22 : swish ? 16 : 10, e.fire ? 620 : 520, colors);
          const label = e.kind === 'swish' ? 'SWISH' : e.kind === 'bank' ? 'BANK SHOT' : '';
          const pts = '+' + e.points;
          if (label) word(label, e.x, e.y - 34, { size: swish ? 34 : 28, color: e.fire ? C.amber : C.white, sub: pts, subColor: e.fire ? C.amber : C.green });
          else word(pts, e.x, e.y - 30, { size: 30, color: e.fire ? C.amber : C.green });
          if (e.fireStart) { word('ON FIRE', e.x, e.y - 96, { size: 38, color: C.amber, max: 1.5, rise: 70 }); confetti(e.x, e.y - 20, 36, 30); }
          else if (e.streak >= 2 && !e.fire) word(e.streak + ' in a row', e.x, e.y + (lastHoop ? lastHoop.r * 1.9 : 110), { size: 18, max: 0.9, rise: 26 });
          break;
        }
        case 'record':
          confetti(e.x, e.y - 40, 60, 160);
          word('NEW BEST', e.x, e.y - 150, { size: 40, color: C.green, max: 1.8, rise: 80 });
          break;
        case 'miss':
          if (e.streak >= 3) word('Streak over', e.x, e.y - 50, { size: 18, color: C.white, max: 0.9, rise: 30 });
          break;
        default: break;
      }
    }

    // ---- drawing ------------------------------------------------------------------
    function outlined(ctx, path, ink, core, color) {
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.strokeStyle = C.ink; ctx.lineWidth = ink; path(); ctx.stroke();
      ctx.strokeStyle = color; ctx.lineWidth = core; path(); ctx.stroke();
    }
    function withHoop(ctx, h, scale, fn) {
      ctx.save();
      ctx.translate(h.x, h.y); ctx.scale(scale, scale); ctx.translate(-h.x, -h.y);
      fn();
      ctx.restore();
    }
    function hoopGeo(h) {
      const r = h.r, ry = r * 0.24, side = h.side;
      const H2 = P.hoop, bX = h.x + side * (r + H2.boardGap * r) + boardDx.x * 0.05;
      return { r, ry, side, rimY: h.y + rimDy.x * 0.05, bX, bTop: h.y - H2.boardUp * r, bBot: h.y + H2.boardDown * r };
    }
    function drawBoard(ctx, h) {
      const g = hoopGeo(h), side = g.side, depth = g.r * 0.36, lift = g.r * 0.1;
      // A panel seen a little from the side: its face is the plank the ball hits.
      const x0 = g.bX, x1 = g.bX + side * depth;
      ctx.beginPath();
      ctx.moveTo(x0, g.bTop); ctx.lineTo(x1, g.bTop - lift); ctx.lineTo(x1, g.bBot - lift); ctx.lineTo(x0, g.bBot); ctx.closePath();
      ctx.fillStyle = 'rgba(245,245,247,.94)'; ctx.fill();
      ctx.lineJoin = 'round'; ctx.strokeStyle = C.ink; ctx.lineWidth = 3.2; ctx.stroke();
      // The shooter's square, in the rim's colour.
      const sx0 = x0 + side * depth * 0.22, sx1 = x0 + side * depth * 0.78, sy0 = g.rimY - g.r * 0.62, sy1 = g.rimY - g.r * 0.05;
      ctx.beginPath();
      ctx.moveTo(sx0, sy0 - lift * 0.22); ctx.lineTo(sx1, sy0 - lift * 0.78); ctx.lineTo(sx1, sy1 - lift * 0.78); ctx.lineTo(sx0, sy1 - lift * 0.22); ctx.closePath();
      ctx.strokeStyle = C.rim; ctx.lineWidth = 2.4; ctx.stroke();
      // The bracket from the rim to the board.
      outlined(ctx, () => { ctx.beginPath(); ctx.moveTo(h.x + side * g.r, g.rimY); ctx.lineTo(x0, g.rimY - g.r * 0.08); }, 6, 2.6, C.white);
    }
    function rimArc(ctx, h, from, to) {
      const g = hoopGeo(h);
      outlined(ctx, () => { ctx.beginPath(); ctx.ellipse(h.x, g.rimY, g.r, g.ry, 0, from, to); }, 7.5, 3.8, C.rim);
    }
    function drawNet(ctx, h) {
      const g = hoopGeo(h), n = 8, len = g.r * 1.12 * (1 + clamp(net.stretch.x * 0.06, -0.15, 0.6));
      const rows = [0, 0.5, 1].map((f, ri) => {
        const w = g.r * (1 - 0.42 * f), y = g.rimY + len * f + g.ry * (1 - f) * 0, sway = net.sway.x * g.r * 0.06 * Math.pow(f, 1.2);
        const pts = [];
        for (let i = 0; i < n; i++) {
          const th = Math.PI * i / (n - 1);
          pts.push({ x: h.x + sway + Math.cos(th) * w, y: y + Math.sin(th) * g.ry * (1 - 0.4 * f) + (ri === 0 ? 0 : 2) });
        }
        return pts;
      });
      const path = () => {
        ctx.beginPath();
        for (let r = 0; r < rows.length - 1; r++) {
          const a = rows[r], b = rows[r + 1];
          for (let i = 0; i < n; i++) {
            if (i + 1 < n) { ctx.moveTo(a[i].x, a[i].y); ctx.lineTo(b[i + 1].x, b[i + 1].y); }
            if (i - 1 >= 0) { ctx.moveTo(a[i].x, a[i].y); ctx.lineTo(b[i - 1].x, b[i - 1].y); }
          }
        }
        const last = rows[rows.length - 1];
        ctx.moveTo(last[0].x, last[0].y);
        for (let i = 1; i < n; i++) ctx.lineTo(last[i].x, last[i].y);
      };
      outlined(ctx, path, 3.6, 1.7, C.white);
    }
    function drawShadow(ctx, ball, b) {
      const floor = H - b.m + R * 0.78, up = clamp((floor - ball.y) / (H * 0.7));
      const k = 1 - up;
      ctx.beginPath();
      ctx.ellipse(ball.x, floor, R * (0.45 + 0.55 * k), R * (0.1 + 0.1 * k), 0, 0, TAU);
      ctx.fillStyle = 'rgba(13,15,25,' + (0.06 + 0.16 * k).toFixed(3) + ')';
      ctx.fill();
    }
    function drawTrail(ctx, fire) {
      if (trail.length < 2) return;
      const newest = trail[trail.length - 1].t;
      for (const pass of [0, 1]) {
        for (let i = 1; i < trail.length; i++) {
          const a = trail[i - 1], b = trail[i];
          const f = 1 - (newest - b.t) / 0.14, w = R * 1.05 * f * f;
          if (w < 0.6) continue;
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
          ctx.lineCap = 'round';
          if (pass === 0) { ctx.strokeStyle = 'rgba(13,15,25,' + (0.32 * f).toFixed(3) + ')'; ctx.lineWidth = w + 4; }
          else { ctx.strokeStyle = fire ? (i / trail.length > 0.5 ? C.amber : C.rim) : 'rgba(245,245,247,' + (0.85 * f).toFixed(3) + ')'; ctx.globalAlpha = fire ? 0.85 * f : 1; ctx.lineWidth = w; }
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }
    }
    function drawFireGlow(ctx, ball) {
      const g = ctx.createRadialGradient(ball.x, ball.y, R * 0.3, ball.x, ball.y, R * 2.3);
      g.addColorStop(0, 'rgba(255,199,106,.42)'); g.addColorStop(0.55, 'rgba(255,112,107,.16)'); g.addColorStop(1, 'rgba(255,112,107,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(ball.x, ball.y, R * 2.3, 0, TAU); ctx.fill();
    }
    function drawParticles(ctx, dt) {
      const keep = [];
      for (const p of parts) {
        p.life += dt;
        if (p.life >= p.max) continue;
        const f = 1 - p.life / p.max;
        if (p.k === 'spark') {
          p.vx *= 1 - 3 * dt; p.vy = p.vy * (1 - 3 * dt) + 700 * dt;
          p.x += p.vx * dt; p.y += p.vy * dt;
          const tx = p.x - p.vx * 0.035, ty = p.y - p.vy * 0.035;
          ctx.lineCap = 'round';
          ctx.strokeStyle = 'rgba(13,15,25,' + (0.8 * f).toFixed(3) + ')'; ctx.lineWidth = p.w + 2.4;
          ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(p.x, p.y); ctx.stroke();
          ctx.globalAlpha = f; ctx.strokeStyle = p.c; ctx.lineWidth = p.w;
          ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(p.x, p.y); ctx.stroke(); ctx.globalAlpha = 1;
        } else if (p.k === 'conf') {
          p.vx *= 1 - 1.6 * dt; p.vy = p.vy * (1 - 1.6 * dt) + 900 * dt;
          p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.vr * dt;
          ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.scale(1, Math.cos(p.rot * 1.7));
          ctx.globalAlpha = Math.min(1, f * 2.5);
          ctx.fillStyle = p.c; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
          ctx.strokeStyle = C.ink; ctx.lineWidth = 1.2; ctx.strokeRect(-p.w / 2, -p.h / 2, p.w, p.h);
          ctx.restore(); ctx.globalAlpha = 1;
        } else if (p.k === 'dust') {
          p.vx *= 1 - 4 * dt; p.vy *= 1 - 4 * dt;
          p.x += p.vx * dt; p.y += p.vy * dt;
          ctx.beginPath(); ctx.arc(p.x, p.y, p.r * (1.4 - 0.6 * f), 0, TAU);
          ctx.fillStyle = 'rgba(13,15,25,' + (0.18 * f).toFixed(3) + ')'; ctx.fill();
        } else if (p.k === 'ring') {
          const rr = R * (1 + 0.9 * easeOut(1 - f));
          ctx.beginPath(); ctx.arc(p.x, p.y, rr, 0, TAU);
          ctx.strokeStyle = 'rgba(13,15,25,' + (0.5 * f).toFixed(3) + ')'; ctx.lineWidth = 5; ctx.stroke();
          ctx.strokeStyle = 'rgba(245,245,247,' + (0.9 * f).toFixed(3) + ')'; ctx.lineWidth = 2.4; ctx.stroke();
        } else if (p.k === 'ember') {
          p.vy -= 160 * dt; p.x += p.vx * dt; p.y += p.vy * dt;
          ctx.beginPath(); ctx.arc(p.x, p.y, p.r * f, 0, TAU);
          ctx.fillStyle = p.c; ctx.globalAlpha = f; ctx.fill(); ctx.globalAlpha = 1;
        }
        keep.push(p);
      }
      parts = keep;
    }
    function drawWords(ctx, dt) {
      const keep = [];
      for (const w of words) {
        w.life += dt;
        if (w.life >= w.max) continue;
        const t = w.life / w.max, s = easeOutBack(w.life / 0.22), a = t > 0.7 ? 1 - (t - 0.7) / 0.3 : 1;
        const y = w.y - w.rise * easeOut(t);
        ctx.save(); ctx.translate(w.x, y); ctx.scale(s, s); ctx.globalAlpha = a;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
        ctx.font = '800 ' + w.size + 'px ' + FONT;
        ctx.strokeStyle = C.ink; ctx.lineWidth = Math.max(5, w.size * 0.2); ctx.strokeText(w.text, 0, 0);
        ctx.fillStyle = w.color; ctx.fillText(w.text, 0, 0);
        if (w.sub) {
          const ss = Math.round(w.size * 0.72);
          ctx.font = '800 ' + ss + 'px ' + FONT;
          ctx.lineWidth = Math.max(4, ss * 0.2); ctx.strokeText(w.sub, 0, w.size * 0.95);
          ctx.fillStyle = w.subColor; ctx.fillText(w.sub, 0, w.size * 0.95);
        }
        ctx.restore();
        keep.push(w);
      }
      words = keep;
    }

    function draw(dt, v, b) {
      if (!back) return false;
      clock += dt;
      const ball = v.ball, h = v.hoop;
      let busy = false;
      busy = spring(net.stretch, dt, 140, 7) || busy;
      busy = spring(net.sway, dt, 120, 5) || busy;
      busy = spring(rimDy, dt, 900, 14) || busy;
      busy = spring(boardDx, dt, 700, 14) || busy;
      // The hoop pops in: a spring from 0 to 1 with a little overshoot.
      pop.v += (260 * (1 - pop.x) - 15 * pop.v) * dt; pop.x += pop.v * dt;
      if (Math.abs(1 - pop.x) < 1e-3 && Math.abs(pop.v) < 1e-2) { pop.x = 1; pop.v = 0; } else busy = true;
      if (ghost) { ghost.life += dt; if (ghost.life > 0.22) ghost = null; else busy = true; }

      // The trail: only behind a fast, free Knot.
      const speed = Math.hypot(ball.vx, ball.vy);
      if (!ball.held && !v.frozen && speed > 420) {
        const last = trail[trail.length - 1];
        if (!last || Math.hypot(ball.x - last.x, ball.y - last.y) > 3) trail.push({ x: ball.x, y: ball.y, t: clock });
      }
      while (trail.length && clock - trail[0].t > 0.14) trail.shift();
      if (trail.length) busy = true;
      // Embers off a Knot on fire.
      if (v.fire && !ball.resting && clock - emberAt > 0.03) {
        emberAt = clock;
        add({ k: 'ember', x: ball.x + rnd(-R * 0.6, R * 0.6), y: ball.y + rnd(-R * 0.4, R * 0.5), vx: rnd(-40, 40), vy: rnd(-60, -10), life: 0, max: rnd(0.35, 0.6), r: rnd(2.5, 4.5), c: Math.random() < 0.5 ? C.amber : C.rim });
      }

      // ---- back canvas
      bx.setTransform(dpr, 0, 0, dpr, 0, 0);
      bx.clearRect(0, 0, W, H);
      drawShadow(bx, ball, b);
      if (v.fire) drawFireGlow(bx, ball);
      drawTrail(bx, v.fire);
      if (ghost) withHoop(bx, ghost.hoop, 1 - easeOut(ghost.life / 0.22), () => { drawBoard(bx, ghost.hoop); rimArc(bx, ghost.hoop, Math.PI, TAU); });
      if (h) withHoop(bx, h, Math.max(0, pop.x), () => { drawBoard(bx, h); rimArc(bx, h, Math.PI, TAU); });

      // ---- front canvas
      fx.setTransform(dpr, 0, 0, dpr, 0, 0);
      fx.clearRect(0, 0, W, H);
      if (ghost) withHoop(fx, ghost.hoop, 1 - easeOut(ghost.life / 0.22), () => { drawNet(fx, ghost.hoop); rimArc(fx, ghost.hoop, 0, Math.PI); });
      if (h) withHoop(fx, h, Math.max(0, pop.x), () => { drawNet(fx, h); rimArc(fx, h, 0, Math.PI); });
      drawParticles(fx, dt);
      drawWords(fx, dt);
      if (parts.length || words.length) busy = true;
      return busy;
    }

    return { start, stop, event, draw, get on() { return !!back; } };
  }

  const api = { create };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NusPlayFx = api;
})(typeof window !== 'undefined' ? window : globalThis);
