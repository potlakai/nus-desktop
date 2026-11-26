// The Nūs Knot, rendered for real: a 3D glass trefoil that tumbles slowly and
// carries a band of light around its own curve. Vanilla canvas 2D, no
// libraries, CSP-safe.
//
// Material: the tube is a dense run of depth-sorted, sphere-shaded discs
// (pre-rendered sprites, one per lighting level). Overlapping discs make one
// smooth chrome strand with correct self-occlusion at the crossings and no
// joints. The same material draws the page thread (assets/thread.js), so the
// Knot and the thread are literally one strand.
//
// Look targets: glass-silver tube, calm directional light from the upper left,
// monochrome at rest, a whisper of accent that breathes through with state.
(() => {
  'use strict';

  const TWO_PI = Math.PI * 2;

  // Classic trefoil: one continuous loop, no beginning, no end.
  function trefoilPoint(t) {
    return {
      x: Math.sin(t) + 2 * Math.sin(2 * t),
      y: Math.cos(t) - 2 * Math.cos(2 * t),
      z: -Math.sin(3 * t),
    };
  }

  const smooth = (v) => { const x = Math.max(0, Math.min(1, v)); return x * x * (3 - 2 * x); };

  // Open only the final arc of the desktop trefoil. The previous site version
  // blended the whole loop into a standing wave, producing a star halfway
  // through the scroll. Keeping most of the curve untouched makes the mark
  // read as the Companion Knot while one real end is pulled into the page.
  function curvePoint(t, u) {
    if (u <= 0) return trefoilPoint(t);
    const a = trefoilPoint(t);
    const s = t / TWO_PI;
    const q = smooth((s - 0.68) / 0.32);
    const e = q * smooth(u);
    // The tail pulls away on the -y side of the seam: under the S pose that
    // projects downward and away from the camera, so the page strand can
    // carry it on as a thin, far line (the end Knot is rotated to receive it).
    const seam = trefoilPoint(TWO_PI);
    const b = {
      x: seam.x + Math.sin(q * Math.PI) * 0.3,
      y: seam.y - q * 6.4,
      z: seam.z + Math.sin(q * Math.PI) * 0.18,
    };
    return { x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e, z: a.z + (b.z - a.z) * e };
  }

  function parseColor(raw, fallback) {
    const value = String(raw || '').trim();
    let m = value.match(/^#([0-9a-f]{6})$/i);
    if (m) {
      const n = parseInt(m[1], 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
    m = value.match(/rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);
    if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
    return fallback;
  }

  // Per-state motion + tint. Rest is monochrome with a whisper of accent;
  // active states let the accent breathe through the glass.
  const STATES = {
    idle: { speed: 1, band: 1, tint: 0.12, glow: 0.35 },
    ready: { speed: 1.25, band: 1.3, tint: 0.3, glow: 0.5 },
    listening: { speed: 1.7, band: 1.9, tint: 0.62, glow: 0.75 },
    thinking: { speed: 2.4, band: 2.6, tint: 0.55, glow: 0.85 },
    spar: { speed: 1.7, band: 1.9, tint: 0.62, glow: 0.7 },
    speaking: { speed: 1.5, band: 2.4, tint: 0.5, glow: 0.8 },
    // Reading the user's screen (Companion only): the one moment the Knot
    // looks outward. The host paints --knot-accent amber for it; this row just
    // makes the tint strong enough that the amber actually shows.
    reading: { speed: 1.3, band: 2.2, tint: 0.92, glow: 1.1 },
    // 0.1.2 bodies. working: between listening and thinking (transcribing,
    // routing), a faster and straighter Knot. error: the host paints it red
    // for a beat. sleeping: settles, breathes slowly, then the loop stops.
    working: { speed: 2, band: 2.2, tint: 0.4, glow: 0.7 },
    error: { speed: 1.4, band: 1.6, tint: 0.7, glow: 0.8 },
    sleeping: { speed: 0.25, band: 0.4, tint: 0.05, glow: 0.15 },
  };

  // ---- pose and gestures (0.1.2) -------------------------------------
  // Continuous pose parameters, spring-eased toward targets, with one-shot
  // gestures layered on top. Everything here is additive: with no host call
  // the frame is the 0.1.1 frame. Each state may add a small pose of its own
  // (working straightens, thinking tightens, sleeping shrinks and slows).
  const POSE_KEYS = ['scale', 'squash', 'leanX', 'leanY', 'straighten', 'tempo', 'bright'];
  const POSE_REST = { scale: 1, squash: 0, leanX: 0, leanY: 0, straighten: 0, tempo: 1, bright: 0 };
  const SPRING_K = { scale: 140, squash: 160, leanX: 90, leanY: 90, straighten: 60, tempo: 40, bright: 80 };
  const STATE_POSE = {
    working: { straighten: 0.22, tempo: 0.1 },
    thinking: { scale: -0.05 },
    sleeping: { scale: -0.08, tempo: -0.75 },
  };
  // Gestures: name -> duration and the pose delta at progress p (0..1).
  // Placeholders until the motion design lands; the shapes are the contract.
  const GESTURES = {
    acknowledge: { ms: 220, at: (p) => ({ squash: 0.12 * Math.sin(Math.PI * p), tempo: 1.5 * (1 - p) }) },
    done: { ms: 520, at: (p) => ({ scale: 0.14 * Math.sin(Math.PI * p), bright: 0.6 * (1 - p) }) },
    error: { ms: 420, at: (p) => ({ leanX: 0.5 * Math.sin(6 * Math.PI * p) * (1 - p) }) },
    poke: { ms: 180, at: (p, o) => ({ squash: -0.16 * Math.sin(Math.PI * p), leanX: (o.dx || 0) * 0.4 * Math.sin(Math.PI * p), leanY: (o.dy || 0) * 0.4 * Math.sin(Math.PI * p) }) },
    wake: { ms: 600, at: (p) => ({ scale: -0.1 * (1 - p) + 0.06 * Math.sin(Math.PI * p), tempo: 1 - p }) },
    arrive: { ms: 360, at: (p) => ({ squash: 0.1 * Math.sin(Math.PI * p) * (1 - p), bright: 0.3 * (1 - p) }) },
    nudge: { ms: 500, at: (p) => ({ leanY: -0.35 * Math.sin(2 * Math.PI * p) * (1 - p) }) },
    gulp: { ms: 420, at: (p) => ({ squash: 0.2 * Math.sin(Math.PI * Math.min(1, p * 1.6)), scale: 0.08 * Math.sin(Math.PI * p) }) },
    settle: { ms: 380, at: (p) => ({ squash: 0.08 * Math.sin(2 * Math.PI * p) * (1 - p) }) },
    sleep: { ms: 400, at: (p) => ({ squash: 0.05 * Math.sin(Math.PI * p) }) },
  };

  // ---------------------------------------------------------------- material
  // The strand is drawn as short cylinder slices: a sprite shaded ACROSS the
  // tube (dark edge, silver wall, bright core, dark edge), rotated to the
  // local tangent and overlapped heavily. Sprites vary by depth (lit) and by
  // where the light falls on the cross-section (off), so the highlight slides
  // smoothly around the tube as it turns. One light, from the upper left.
  const D = [13, 15, 25];          // dark tube body
  const S = [201, 206, 220];       // silver glass wall
  const LEVELS = 12;               // depth lighting steps, far (0) to near (1)
  const OFFS = 9;                  // highlight positions across the tube
  const SL = 48;                   // sprite size in px
  const LX = -0.6, LY = -0.8;      // light direction (toward the upper left)
  const mix = (a, b, f) => Math.round(a + (b - a) * f);
  const rgb = (c) => 'rgb(' + c[0] + ', ' + c[1] + ', ' + c[2] + ')';
  const cache = new Map();

  function sprites(raw, tint) {
    const q = Math.round(Math.max(0, Math.min(1, tint)) * 12) / 12;
    // The accent now fades between colours, so quantise it: one sprite set
    // per 6 levels per channel, and a bounded cache (48 sets, oldest out).
    const acc = [0, 1, 2].map((i) => Math.round(raw[i] / 6) * 6);
    const key = acc[0] + ',' + acc[1] + ',' + acc[2] + '|' + q;
    if (cache.has(key)) return cache.get(key);
    if (cache.size >= 48) cache.delete(cache.keys().next().value);
    const set = new Array(LEVELS);
    for (let l = 0; l < LEVELS; l++) {
      const lit = l / (LEVELS - 1);
      const wall = [0, 1, 2].map((i) => mix(D[i], S[i], 0.14 + lit * 0.7));
      const core = [0, 1, 2].map((i) => mix(mix(S[i], 255, 0.3 + lit * 0.62), acc[i], q * 0.55));
      const row = new Array(OFFS);
      for (let o = 0; o < OFFS; o++) {
        const s = (o / (OFFS - 1)) * 2 - 1;        // -1: light from below, +1: from above
        const hy = 0.5 - 0.3 * s;                  // highlight position across the tube
        const c = document.createElement('canvas');
        c.width = c.height = SL;
        const g = c.getContext('2d');
        const grad = g.createLinearGradient(0, 0, 0, SL);
        const top = [0, 1, 2].map((i) => mix(wall[i], D[i], 0.5 - 0.3 * s));
        const bot = [0, 1, 2].map((i) => mix(wall[i], D[i], 0.5 + 0.3 * s));
        const stops = [
          [0, top], [Math.max(0.02, hy - 0.3), wall], [hy, core], [Math.min(0.98, hy + 0.3), wall], [1, bot],
        ];
        stops.sort((a, b) => a[0] - b[0]);
        let lastPos = -1;
        for (const [pos, col] of stops) {
          const p = Math.max(pos, lastPos + 0.001);
          grad.addColorStop(Math.min(1, p), rgb(col));
          lastPos = p;
        }
        g.fillStyle = grad;
        g.fillRect(0, 0, SL, SL);
        // Reflected rim on the shadow side, near slices only.
        if (lit > 0.45) {
          const ry = hy + 0.44;
          if (ry < 0.97) {
            g.fillStyle = 'rgba(255,255,255,' + (((lit - 0.45) / 0.55) * 0.3).toFixed(3) + ')';
            g.fillRect(0, ry * SL, SL, SL * 0.045);
          }
        }
        row[o] = c;
      }
      set[l] = row;
    }
    cache.set(key, set);
    return set;
  }

  // Tangent angle -> which side the light falls on. Callers store p.ang and
  // p.s (dot of the slice's top normal with the light) so this is per-sample.
  function lightSide(ang) {
    return Math.sin(ang) * LX - Math.cos(ang) * LY;
  }

  // Draw depth-sorted slices. Each sample: { sx, sy, z, persp, ang, s, len }.
  // tube is the strand radius in canvas px; far samples first.
  function drawTube(ctx, list, tube, set) {
    const topL = LEVELS - 1, topO = OFFS - 1;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      const lit = Math.max(0, Math.min(1, 0.5 + p.z * 0.5));
      const row = set[Math.round(lit * topL)];
      const sp = row[Math.round((p.s + 1) * 0.5 * topO)];
      const dia = (p.tube || tube) * 2 * p.persp;
      const cs = Math.cos(p.ang), sn = Math.sin(p.ang);
      ctx.setTransform(cs, sn, -sn, cs, p.sx, p.sy);
      ctx.drawImage(sp, -p.len / 2, -dia / 2, p.len, dia);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  // A brighter pass over a run of samples (under the travelling light).
  function drawBright(ctx, samples, tube, set, alphaAt) {
    const row = set[LEVELS - 1];
    const topO = OFFS - 1;
    for (let i = 0; i < samples.length; i++) {
      const p = samples[i];
      const a = alphaAt(i);
      if (a <= 0) continue;
      const sp = row[Math.round((p.s + 1) * 0.5 * topO)];
      const dia = (p.tube || tube) * 2 * p.persp * 0.92;
      const cs = Math.cos(p.ang), sn = Math.sin(p.ang);
      ctx.globalAlpha = a;
      ctx.setTransform(cs, sn, -sn, cs, p.sx, p.sy);
      ctx.drawImage(sp, -p.len / 2, -dia / 2, p.len, dia);
    }
    ctx.globalAlpha = 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  // The travelling light: an additive bloom on the strand.
  function drawLight(ctx, x, y, radius, acc, strength) {
    if (strength <= 0) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const g = ctx.createRadialGradient(x, y, 0, x, y, radius);
    g.addColorStop(0, 'rgba(255,255,255,' + (0.6 * strength).toFixed(3) + ')');
    g.addColorStop(0.3, 'rgba(' + mix(190, acc[0], .7) + ',' + mix(200, acc[1], .7) + ',' + mix(255, acc[2], .7) + ',' + (0.36 * strength).toFixed(3) + ')');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, TWO_PI);
    ctx.fill();
    ctx.restore();
  }

  const byZ = (a, b) => a.z - b.z;


  // Original desktop material, recovered from 209358f. Keep the reflective
  // wall/core/rim treatment from the user's reference without reverting v2.
  function drawReferenceTube(ctx, pts, tube, acc, tint, glowE, dpr) {
    const [ar, ag, ab] = acc;
    const runs = [];
    const runLen = Math.floor((pts.length - 1) / 18);
    for (let i = 0; i < 18; i++) {
      const from = i * runLen, to = i === 17 ? pts.length - 1 : from + runLen;
      let z = 0;
      for (let j = from; j <= to; j++) z += pts[j].z;
      runs.push({ from, to, z: z / (to - from + 1) });
    }
    runs.sort((a, b) => a.z - b.z);
      // One continuous path through a run's points. trimPx pulls both ends
      // inward along the curve: the wide dark body is trimmed so it can never
      // reach across a joint and bite into the neighbor run's silver, while
      // the silver passes run full length and bridge the joint seamlessly.
      const runPath = (run, trimPx = 0) => {
        let from = run.from, to = run.to;
        if (trimPx > 0) {
          let acc = 0;
          while (from < to && acc < trimPx) {
            acc += Math.hypot(pts[from + 1].sx - pts[from].sx, pts[from + 1].sy - pts[from].sy);
            from++;
          }
          acc = 0;
          while (to > from && acc < trimPx) {
            acc += Math.hypot(pts[to].sx - pts[to - 1].sx, pts[to].sy - pts[to - 1].sy);
            to--;
          }
        }
        ctx.beginPath();
        ctx.moveTo(pts[from].sx, pts[from].sy);
        for (let i = from + 1; i <= to; i++) ctx.lineTo(pts[i].sx, pts[i].sy);
      };
      // Depth-lit gradient along the run, so lighting ramps smoothly inside
      // one stroke instead of banding at chunk boundaries.
      const runGrad = (run, colorAt) => {
        const a = pts[run.from], b = pts[run.to];
        const grad = ctx.createLinearGradient(a.sx, a.sy, b.sx, b.sy);
        const litOf = (i) => 0.5 + pts[i].z * 0.5;
        grad.addColorStop(0, colorAt(litOf(run.from)));
        grad.addColorStop(0.5, colorAt(litOf(Math.floor((run.from + run.to) / 2))));
        grad.addColorStop(1, colorAt(litOf(run.to)));
        return grad;
      };

      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (const run of runs) {
        const midLit = 0.5 + run.z * 0.5;
        const w = tube * pts[Math.floor((run.from + run.to) / 2)].persp;

        // 1. occluding body (opaque, slightly depth-lit), end-trimmed
        runPath(run, w * 0.95);
        ctx.strokeStyle = runGrad(run, (lit) => `rgb(${D[0] + Math.round(lit * 9)}, ${D[1] + Math.round(lit * 10)}, ${D[2] + Math.round(lit * 13)})`);
        ctx.lineWidth = w * 1.72;
        ctx.stroke();

        // 2. glass wall: silver mixed up with nearness
        runPath(run);
        ctx.strokeStyle = runGrad(run, (lit) => {
          const f = 0.2 + lit * 0.62;
          return `rgb(${mix(D[0], S[0], f)}, ${mix(D[1], S[1], f)}, ${mix(D[2], S[2], f)})`;
        });
        ctx.lineWidth = w * 1.06;
        ctx.stroke();

        // 3. specular core, accent-tinted by state. Canvas shadow blur is the
        // slowest 2D op there is, so only near runs (where it reads) pay for it.
        runPath(run);
        if (midLit > 0.55) {
          ctx.shadowBlur = (7 + glowE * 16) * dpr * 0.7;
          ctx.shadowColor = `rgba(${Math.round(ar * 0.6 + 153)}, ${Math.round(ag * 0.6 + 153)}, 255, ${0.12 + glowE * 0.25})`;
        }
        ctx.strokeStyle = runGrad(run, (lit) => {
          const f = Math.min(1, 0.38 + lit * 0.55);
          const r = mix(mix(S[0], 255, f), ar, tint * 0.55);
          const g = mix(mix(S[1], 255, f), ag, tint * 0.55);
          const b2 = mix(mix(S[2], 255, f), ab, tint * 0.3);
          return `rgb(${r}, ${g}, ${b2})`;
        });
        ctx.lineWidth = w * 0.46;
        ctx.stroke();
        ctx.shadowBlur = 0;

        // 4. rim highlight on near runs
        if (midLit > 0.58) {
          runPath(run);
          const rim = (midLit - 0.58) / 0.42;
          ctx.strokeStyle = `rgba(255, 255, 255, ${0.25 + rim * 0.5})`;
          ctx.lineWidth = Math.max(1, w * 0.15);
          ctx.stroke();
        }
      }


  }

  // ------------------------------------------------------------------- knot
  function mount(canvas, opts = {}) {
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    // ground:false skips the dark radial backdrop so the mark floats directly
    // on whatever is behind it; scale sets the drawn radius as a fraction of
    // the canvas, letting a host give the glow extra canvas margin.
    const drawGround = opts.ground !== false;
    const RATIO = opts.scale || 0.33;
    const TUBE_RATIO = Math.max(0.008, Math.min(0.06, opts.tubeScale || 0.05));
    // rotate spins the projected mark (pi keeps the S readable but opens the
    // seam upward); anchorY places the centre as a fraction of the canvas
    // height so a host can give the open tail room to run off one side.
    let ROT = Number(opts.rotate) || 0;
    let ROT_C = Math.cos(ROT), ROT_S = Math.sin(ROT);
    // focusGate:false keeps full frame rate in a window that is never focused
    // (the Companion overlay is shown inactive by design).
    const focusGate = opts.focusGate !== false;
    // pauseWhenHidden:false leaves the Page Visibility API alone; a host whose
    // document never reports hidden (the overlay, with background throttling
    // off) drives pause()/resume() itself.
    const pauseWhenHidden = opts.pauseWhenHidden !== false;
    const ANCHOR_Y = opts.anchorY == null ? 0.5 : Math.max(0, Math.min(1, Number(opts.anchorY)));
    // bandDir -1 runs the travelling light backwards, so a Knot that receives
    // the page strand carries the light on in the direction it arrived.
    const BAND_DIR = Number(opts.bandDir) === -1 ? -1 : 1;
    // ?motion=reduce mirrors the OS setting so the static frame can be checked without changing it.
    let reduced = (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
      || /motion=reduce/.test(String(window.location && window.location.search));

    let state = 'idle';
    let running = false;
    let frame = null;
    const basePose = opts.startTime == null ? 2.35 : Number(opts.startTime);
    let time = basePose; // recognizable desktop S pose
    let last = performance.now();
    let speed = STATES.idle.speed, tint = STATES.idle.tint, glow = STATES.idle.glow, band = STATES.idle.band;
    let liveLevel = 0, level = 0;
    let bandTime = time;
    let unravel = 0, unravelTarget = 0, tumble = time;
    let tailPoint = null;
    let bandPos = 0;
    let pausePending = false;

    // Pose: host targets (setPose) plus the state's own pose, spring-eased;
    // gestures add on top for their duration. effv is what this frame draws.
    const hostPose = { ...POSE_REST }, poseTarget = { ...POSE_REST }, pose = { ...POSE_REST }, poseVel = {}, effv = { ...POSE_REST };
    for (const k of POSE_KEYS) poseVel[k] = 0;
    const gestures = [];
    let sleeping = false, asleep = false, lastDrawn = 0, sq = 0;
    function retarget() { const sp = STATE_POSE[state] || {}; for (const k of POSE_KEYS) poseTarget[k] = hostPose[k] + (sp[k] || 0); }
    function stepPose(dt) {
      for (const k of POSE_KEYS) {
        const kk = SPRING_K[k], c = 2 * Math.sqrt(kk); // critically damped
        const a = kk * (poseTarget[k] - pose[k]) - c * poseVel[k];
        poseVel[k] += a * dt;
        pose[k] += poseVel[k] * dt;
      }
    }
    function poseSettled() {
      for (const k of POSE_KEYS) if (Math.abs(pose[k] - poseTarget[k]) > 0.002 || Math.abs(poseVel[k]) > 0.01) return false;
      return true;
    }
    function evalGestures(now) {
      for (const k of POSE_KEYS) effv[k] = pose[k];
      for (let i = gestures.length - 1; i >= 0; i--) {
        const g = gestures[i];
        const p = (now - g.t0) / g.ms;
        if (p >= 1) { gestures.splice(i, 1); continue; }
        const d = g.at(Math.max(0, p), g.opts);
        for (const k in d) if (k in effv) effv[k] += d[k];
      }
    }
    // straighten blends the trefoil toward a gentle arc of the same extent,
    // parameter-aligned so the tube keeps its order and simply unbends.
    function straightPoint(t) { const s = t / TWO_PI - 0.5; return { x: s * 5.2, y: Math.sin(t) * 0.35, z: 0 }; }
    function poseCurve(t) {
      const a = curvePoint(t, unravel);
      const st = effv.straighten;
      if (st <= 0.002) return a;
      const b = straightPoint(t), e = smooth(Math.min(1, st));
      return { x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e, z: a.z + (b.z - a.z) * e };
    }

    // Projection state from the latest frame, shared with getTailAnchor().
    let cx = 0, cy = 0, R = 1, cosX = 1, sinX = 0, cosY = 1, sinY = 0, lastTube = 1, projected = false;
    const fov = 6.2;
    const tmpPt = { sx: 0, sy: 0, z: 0, persp: 1, t: 0, ang: 0, s: 0, len: 2 };
    function tubeAt(u) {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      return Math.max(0.9 * dpr, Math.min(canvas.width, canvas.height) * TUBE_RATIO * (1 - u * 0.45));
    }
    // Make the projection state valid before the first frame has drawn
    // (a paused or not-yet-visible Knot can still be asked where its tail is).
    function syncProjection() {
      resize();
      cx = canvas.width / 2; cy = canvas.height * ANCHOR_Y;
      R = Math.min(canvas.width, canvas.height) * RATIO * effv.scale;
      const rx = tumble * 0.26 + effv.leanY * 0.35, ry = tumble * 0.17 + effv.leanX * 0.35;
      cosX = Math.cos(rx); sinX = Math.sin(rx);
      cosY = Math.cos(ry); sinY = Math.sin(ry);
      lastTube = tubeAt(unravel);
      projected = true;
    }
    function project(p, pt) {
      const x = p.x / 3, y = p.y / 3, z = p.z / 1.2;
      const x1 = x * cosY + z * sinY;
      const z1 = -x * sinY + z * cosY;
      const y1 = y * cosX - z1 * sinX;
      const z2 = y * sinX + z1 * cosX;
      const xr = x1 * ROT_C - y1 * ROT_S;
      const yr = x1 * ROT_S + y1 * ROT_C;
      const persp = fov / (fov - z2 * 1.6);
      // squash: wider and shorter (positive) or taller and thinner (negative)
      pt.sx = cx + xr * R * persp * (1 + sq);
      pt.sy = cy + yr * R * persp * (1 - sq);
      pt.z = z2;
      pt.persp = persp;
      return pt;
    }

    function accent() {
      const raw = getComputedStyle(canvas.parentElement || canvas).getPropertyValue('--knot-accent');
      return parseColor(raw, [80, 108, 255]);
    }
    // The accent eases toward the CSS colour instead of snapping to it, so
    // silver -> amber -> violet is a fade in the halo, core and light.
    let acc = accent().slice();
    let accTarget = acc.slice();
    let accAt = 0;

    let rectW = canvas.clientWidth || 0, rectH = canvas.clientHeight || 0;
    function resize() {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.max(1, Math.round(rectW * dpr));
      const h = Math.max(1, Math.round(rectH * dpr));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      return dpr;
    }

    // Sample pool, grown on demand and reused every frame.
    const MAXN = 2200;
    const pool = new Array(MAXN);
    for (let i = 0; i < MAXN; i++) pool[i] = { sx: 0, sy: 0, z: 0, persp: 1, t: 0, ang: 0, s: 0, len: 2 };
    let list = [];
    let perim = 0; // projected curve length from the previous frame
    // The reference tube's 201 points, allocated once (they were 201 fresh
    // objects every frame).
    const refPool = [];
    for (let i = 0; i <= 200; i++) refPool.push({ sx: 0, sy: 0, z: 0, persp: 1 });

    let idleSkip = 0;
    function draw(now) {
      if (focusGate && typeof document !== 'undefined' && !document.hasFocus() && (idleSkip = (idleSkip + 1) % 3)) {
        if (running) frame = requestAnimationFrame(draw);
        return;
      }
      // At rest nothing changes fast: about 30 fps is plenty and halves the
      // idle cost. Any state, gesture, pose or unravel change lifts the cap.
      const calm = (state === 'idle' || state === 'sleeping') && !gestures.length && Math.abs(unravelTarget - unravel) < 0.005 && poseSettled();
      if (calm && now - lastDrawn < 28) { if (running) frame = requestAnimationFrame(draw); return; }
      lastDrawn = now;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const target = STATES[state] || STATES.idle;
      const k = 1 - Math.exp(-dt * 4.5);
      const unwindK = 1 - Math.exp(-dt * 2.75);
      speed += (target.speed - speed) * k;
      tint += (target.tint - tint) * k;
      glow += (target.glow - glow) * k;
      band += (target.band - band) * k;
      unravel += (unravelTarget - unravel) * unwindK;
      stepPose(dt);
      evalGestures(now);
      sq = Math.max(-0.4, Math.min(0.4, effv.squash));
      const tempo = Math.max(0.05, effv.tempo);
      time += dt * speed * tempo;
      // Keep the Companion's readable S silhouette. A small, breathing orbit gives
      // it depth without rotating into the rejected three-lobed presentation.
      tumble = basePose + Math.sin(time * 0.18) * 0.16 * (1 - unravel * 0.85);
      // speaking with no microphone: a synthetic voice level so the band pulses.
      const wantLevel = state === 'speaking' && liveLevel <= 0 ? 0.35 + 0.35 * Math.sin(time * 7) : liveLevel;
      if (wantLevel > level) level = wantLevel;
      else level += (wantLevel - level) * Math.min(1, dt * 5);
      bandTime += dt * band * (1 + level * 0.5) * BAND_DIR * tempo;
      const glowE = Math.min(1.4, glow * (1 + level * 0.6)) + Math.max(0, effv.bright);
      if (now - accAt > 500) { accTarget = accent(); accAt = now; }
      const ak = 1 - Math.exp(-dt * 6);
      for (let i = 0; i < 3; i++) acc[i] += (accTarget[i] - acc[i]) * ak;

      const dpr = resize();
      const W = canvas.width, H = canvas.height;
      cx = W / 2; cy = H * ANCHOR_Y;
      R = Math.min(W, H) * RATIO * Math.max(0.2, effv.scale);
      const tube = Math.max(0.9 * dpr, Math.min(W, H) * TUBE_RATIO * (1 - unravel * 0.45)); // strand radius
      lastTube = tube;

      ctx.clearRect(0, 0, W, H);

      const rx = tumble * 0.26 + effv.leanY * 0.35, ry = tumble * 0.17 + effv.leanX * 0.35;
      cosX = Math.cos(rx); sinX = Math.sin(rx);
      cosY = Math.cos(ry); sinY = Math.sin(ry);
      projected = true;

      if (drawGround) {
        const ground = ctx.createRadialGradient(cx, cy, R * 0.1, cx, cy, Math.min(W, H) * 0.5);
        ground.addColorStop(0, 'rgba(7, 9, 17, 0.78)');
        ground.addColorStop(0.72, 'rgba(7, 9, 17, 0.5)');
        ground.addColorStop(1, 'rgba(7, 9, 17, 0)');
        ctx.fillStyle = ground;
        ctx.fillRect(0, 0, W, H);
      }

      // Presence: a soft halo in the accent, stronger with state.
      const halo = ctx.createRadialGradient(cx, cy, R * 0.2, cx, cy, R * 1.5);
      halo.addColorStop(0, `rgba(${acc[0]},${acc[1]},${acc[2]},${(0.05 + glowE * 0.09) * (1 - unravel)})`);
      halo.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = halo;
      ctx.fillRect(0, 0, W, H);

      // Orbit ring behind the knot: a tilted ellipse + drifting particles.
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(-0.42);
      ctx.beginPath();
      ctx.ellipse(0, 0, R * 1.62, R * 0.58, 0, 0, TWO_PI);
      ctx.strokeStyle = `rgba(240, 237, 227, ${(0.05 + glowE * 0.05) * (1 - unravel)})`;
      ctx.lineWidth = 1 * dpr;
      ctx.stroke();
      for (let i = 0; i < 3; i++) {
        const a = time * 0.12 * (i % 2 ? 1 : -0.8) + i * 2.1;
        const px = Math.cos(a) * R * 1.62, py = Math.sin(a) * R * 0.58;
        const size = (1.1 + 0.5 * Math.sin(time * 0.8 + i * 2)) * dpr;
        ctx.beginPath();
        ctx.arc(px, py, size, 0, TWO_PI);
        ctx.fillStyle = `rgba(214, 220, 255, ${(0.28 + 0.18 * Math.sin(time + i * 3)) * (1 - unravel)})`;
        ctx.fill();
      }
      ctx.restore();

      // Sample density: enough discs that neighbours overlap by ~80%.
      const perimeter = perim > 0 ? perim : R * 14;
      const N = Math.max(300, Math.min(MAXN, Math.round(perimeter / (tube * 0.16))));
      list.length = 0;
      for (let i = 0; i < N; i++) {
        const t = (i / N) * TWO_PI;
        const pt = project(poseCurve(t), pool[i]);
        pt.t = i / N;
        list.push(pt);
      }
      tailPoint = pool[N - 1];
      // Tangents from neighbours (the curve is closed), slice length from spacing.
      let plen = 0;
      for (let i = 1; i < N; i++) plen += Math.hypot(pool[i].sx - pool[i - 1].sx, pool[i].sy - pool[i - 1].sy);
      perim = plen;
      const slen = Math.max(2 * dpr, (plen / N) * 3.2);
      const open = unravel > 0.002 || effv.straighten > 0.002;
      for (let i = 0; i < N; i++) {
        const a = pool[open ? Math.max(0, i - 1) : (i + N - 1) % N];
        const b = pool[open ? Math.min(N - 1, i + 1) : (i + 1) % N];
        const p = pool[i];
        p.ang = Math.atan2(b.sy - a.sy, b.sx - a.sx);
        p.s = lightSide(p.ang);
        p.len = slen;
      }
      list.sort(byZ);

      const set = sprites(acc, tint);
      // Use the reference material on the Knot. The strand retains the shared
      // slice material and tail anchor, so unwinding remains fully compatible.
      for (let i = 0; i <= 200; i++) project(poseCurve(i / 200 * TWO_PI), refPool[i]);
      drawReferenceTube(ctx, refPool, tube, acc, tint, glowE, dpr);

      // The travelling light: runs the curve, faster with voice.
      bandPos = ((bandTime * 0.11) % 1 + 1) % 1;
      const bi = Math.floor(bandPos * N) % N;
      const bp = pool[bi];
      // brighten the strand under the light
      const half = Math.max(2, Math.floor(N * 0.02));
      const run = [];
      for (let o = -half; o <= half; o++) run.push(pool[((bi + o) % N + N) % N]);
      drawBright(ctx, run, tube, set, (i) => 0.55 * (1 - Math.abs(i - half) / (half + 1)) * (0.5 + bp.z * 0.5 + 0.35));
      drawLight(ctx, bp.sx, bp.sy, tube * (2.6 + glowE * 1.6) * bp.persp, acc, 0.35 + glowE * 0.45);

      // A host may ask to pause while the strand is still opening or tying;
      // finish that motion first so the page strand never freezes mid-join.
      if (pausePending && Math.abs(unravelTarget - unravel) < 0.005) {
        pausePending = false;
        stop();
        return;
      }
      // Asleep: once the sleep pose has settled, this frame is the last one
      // until wake(). No timer, no rAF, no CPU.
      if (sleeping && !asleep && !gestures.length && poseSettled() && Math.abs(unravelTarget - unravel) < 0.005) {
        asleep = true;
        canvas.classList.add('knot-asleep');
        stop();
        return;
      }
      if (running) frame = requestAnimationFrame(draw);
    }

    function gesture(name, opts) {
      const g = GESTURES[name];
      if (!g || reduced) return false;
      if (sleeping) wake();
      gestures.push({ t0: performance.now(), ms: g.ms, at: g.at, opts: opts || {} });
      start();
      return true;
    }
    function wake() {
      const was = sleeping || asleep;
      sleeping = false; asleep = false;
      canvas.classList.remove('knot-asleep');
      if (state === 'sleeping') state = 'idle';
      retarget();
      if (!reduced) start(); else draw(performance.now());
      if (was) gesture('wake');
      return was;
    }

    function start() {
      if (running) return;
      running = true;
      last = performance.now();
      frame = requestAnimationFrame(draw);
    }
    function stop() {
      running = false;
      if (frame) cancelAnimationFrame(frame);
      frame = null;
    }

    const onVisibility = () => { if (document.hidden) stop(); else start(); };
    if (reduced) {
      time = basePose; tumble = basePose;
      draw(performance.now());
      canvas.classList.add('knot-static');
    } else {
      start();
      if (pauseWhenHidden) document.addEventListener('visibilitychange', onVisibility);
    }

    const remeasure = () => {
      const rect = canvas.getBoundingClientRect();
      rectW = rect.width; rectH = rect.height;
      if (!running) draw(performance.now());
    };
    let ro = null;
    if (window.ResizeObserver) {
      ro = new ResizeObserver((entries) => {
        const box = entries[entries.length - 1].contentRect;
        rectW = box.width; rectH = box.height;
        if (!running) draw(performance.now());
      });
      ro.observe(canvas);
    }
    window.addEventListener('resize', remeasure);

    return {
      setState(next) {
        if (!STATES[next]) next = 'idle';
        // Asleep stays asleep through the host's idle ticks; anything else wakes.
        if (sleeping && next === 'idle') return;
        if (sleeping && next !== 'sleeping') wake();
        state = next;
        retarget();
        // The host recolours --knot-accent with the state (amber = reading);
        // pick it up this frame rather than on the next 500ms poll.
        accAt = 0;
        if (reduced) draw(performance.now());
        else if (opts.quietIdle) {
          if (['idle', 'ready'].includes(state)) { pausePending = true; draw(performance.now()); }
          else { pausePending = false; start(); }
        }
      },
      setReducedMotion(value) {
        reduced = !!value;
        if (reduced) { stop(); unravel = unravelTarget; draw(performance.now()); }
        else if (!opts.quietIdle || !['idle', 'ready'].includes(state)) start();
      },
      setLevel(value) {
        if (reduced) return;
        liveLevel = Math.max(0, Math.min(1, Number(value) || 0));
        if (sleeping && liveLevel > 0) wake();
      },
      // Pose targets from the host (travel, lean toward what it reads, drag).
      // Partial: unnamed keys keep their value. Values are deltas from rest
      // except scale and tempo, which are the values themselves.
      setPose(partial) {
        if (!partial) return;
        for (const k of POSE_KEYS) if (partial[k] != null && Number.isFinite(Number(partial[k]))) hostPose[k] = Number(partial[k]);
        if (sleeping) wake(); else { retarget(); if (!reduced) start(); }
      },
      getPose() { return { ...effv }; },
      gesture,
      // Sleep: the sleeping body, then the loop stops once it has settled.
      sleep() {
        if (sleeping || reduced) return;
        sleeping = true; asleep = false;
        state = 'sleeping'; retarget(); accAt = 0;
        gestures.length = 0;
        // Pushed directly: gesture() would wake a sleeping Knot.
        const g = GESTURES.sleep;
        gestures.push({ t0: performance.now(), ms: g.ms, at: g.at, opts: {} });
        start();
      },
      wake,
      isAsleep() { return asleep; },
      isSleeping() { return sleeping; },
      setUnravel(value) {
        unravelTarget = Math.max(0, Math.min(1, Number(value) || 0));
        if (sleeping && unravelTarget > 0.005) wake();
        if (reduced) { unravel = unravelTarget; draw(performance.now()); return; }
        if (opts.quietIdle && Math.abs(unravelTarget - unravel) >= 0.005) { pausePending = ['idle', 'ready'].includes(state); start(); }
      },
      getUnravel() { return unravel; },
      // Spin the projected mark so its open tail points where the host needs
      // it (the Companion aims the tail at the screen centre from any corner).
      setRotate(rad) {
        ROT = Number(rad) || 0;
        ROT_C = Math.cos(ROT); ROT_S = Math.sin(ROT);
        if (reduced || !running) draw(performance.now());
      },
      getRotate() { return ROT; },
      getBandPhase() { return bandPos; },
      setBandPhase(p) {
        const phase = Math.max(0, Math.min(1, Number(p) || 0));
        bandTime = (Math.floor(bandTime * 0.11) + phase) / 0.11;
      },
      // Viewport position of the open end. With no argument this is the live
      // tail from the last frame; with u it is where the tail sits at that
      // unravel level under the current pose, so a page can lay its path
      // against the fully open mark and only drag toward the live one.
      // Also reports z (depth, for lighting) and r (tube radius, CSS px).
      getTailAnchor(u) {
        let pt;
        if (u == null) {
          if (!tailPoint) return null;
          pt = tailPoint;
        } else {
          if (!projected) syncProjection();
          pt = project(curvePoint(TWO_PI, Math.max(0, Math.min(1, Number(u) || 0))), tmpPt);
        }
        const r = canvas.getBoundingClientRect();
        const sx = canvas.width && r.width ? r.width / canvas.width : 1;
        const sy = canvas.height && r.height ? r.height / canvas.height : 1;
        const tube = u == null ? lastTube : tubeAt(Math.max(0, Math.min(1, Number(u) || 0)));
        return { x: r.left + pt.sx * sx, y: r.top + pt.sy * sy, z: pt.z, r: tube * pt.persp * sx };
      },
      pause() {
        if (!running || Math.abs(unravelTarget - unravel) < 0.005) { pausePending = false; stop(); }
        else pausePending = true;
      },
      resume() { pausePending = false; if (!reduced && (!opts.quietIdle || !['idle', 'ready'].includes(state))) start(); else draw(performance.now()); },
      destroy() {
        stop();
        document.removeEventListener('visibilitychange', onVisibility);
        window.removeEventListener('resize', remeasure);
        if (ro) ro.disconnect();
      },
    };
  }

  window.NusKnot3D = { mount, material: { sprites, drawTube, drawBright, drawLight, lightSide, parseColor, LEVELS, OFFS } };
})();
