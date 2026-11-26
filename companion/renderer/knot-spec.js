// The Knot's numbers, in one place.
//
// Everything the Knot does is tuned here: states, springs, gestures, sound,
// thread moves, surfaces. The tables in SPEC are copied verbatim from the
// approved motion playground (docs/knot-playground.html) and a test compares
// them against that file, so porting stays "copying numbers".
//
// Four blocks:
//   SPEC       the playground's executable SPEC object, unchanged.
//   inline     numbers the playground wrote as literals inside its code.
//   host       numbers only the real app needs (the playground has no mic, no
//              guide session, no light desktops).
//   character  the Knot's look and its shapes (decided 2026-11-02). Where it
//              names a state's shape or the geometry, it replaces the SPEC table.
//              character.accent is the one source for the state colours; the
//              accents in SPEC are the playground's and nothing paints them.
//
// Units: seconds, CSS pixels, radians. Springs use mass 1: [stiffness, damping].
(function (root) {
  'use strict';

  const PARAMS = ['scale', 'squash', 'leanX', 'leanY', 'unravel', 'straighten', 'tempo', 'bright'];
  const pose = (...v) => Object.fromEntries(PARAMS.map((k, i) => [k, v[i]]));

  const SPEC = {
    springs: { scale: [260, 28], squash: [220, 25], leanX: [180, 24], leanY: [180, 24], unravel: [200, 27], straighten: [190, 26], tempo: [100, 20], bright: [160, 23] },
    ranges: { scale: [.7, 1.3], squash: [-.3, .3], leanX: [-.35, .35], leanY: [-.35, .35], unravel: [0, 1], straighten: [0, 1], tempo: [.2, 2], bright: [.3, 1.8] },
    // motion = [tumble speed, band speed, accent tint, glow]
    states: {
      idle: { motion: [1, 1, .12, .35], pose: pose(1, 0, 0, 0, 0, 0, 1, 1), accent: '#d6dbea' },
      ready: { motion: [1.25, 1.3, .3, .5], pose: pose(1.04, -.04, .06, -.05, 0, .03, 1.1, 1.08), accent: '#d6dbea' },
      listening: { motion: [1.7, 1.9, .62, .75], pose: pose(1.05, -.09, .1, -.1, 0, .06, 1.2, 1.12), accent: '#EF5350' },
      working: { motion: [2, 2.2, .4, .7], pose: pose(.98, -.1, .03, -.08, 0, .22, 1.35, 1.06), accent: '#8c96ff' },
      reading: { motion: [1.3, 2.2, .92, 1.1], pose: pose(1.02, -.03, .18, -.13, 0, .06, 1, 1.12), accent: '#E0B663' },
      thinking: { motion: [2.4, 2.6, .55, .85], pose: pose(.92, -.035, 0, -.06, 0, .04, 1.4, 1.18), accent: '#8c96ff' },
      speaking: { motion: [1.5, 2.4, .5, .8], pose: pose(1.01, .015, -.06, -.03, 0, .08, 1.12, 1.1), accent: '#d6dbea' },
      error: { motion: [1.1, 1.5, .85, .65], pose: pose(.97, .1, -.14, .05, 0, .02, .9, 1.08), accent: '#E06A5A' },
      sleeping: { motion: [.25, .4, .05, .15], pose: pose(.94, .12, 0, .09, 0, 0, .25, .55), accent: '#d6dbea' }
    },
    // breathing per state: [scale amplitude, rate]
    loops: { idle: [.008, .75], ready: [.009, 1], listening: [.010, 1.3], working: [.008, 1.5], reading: [.008, .8], thinking: [.006, 1.8], speaking: [.018, 1.2], error: [.004, .9], sleeping: [.012, .5] },
    // keys: [normalised time, parameter deltas]; every gesture returns to 0.
    // notes are MIDI: D4=62 E4=64 F#4=66 A4=69 D5=74 E5=76 F#5=78 A5=81.
    gestures: {
      acknowledge: { duration: .28, notes: [74, 81], keys: [[0, {}], [.08, { scale: .055, bright: .28 }], [.24, { scale: .08, squash: -.055, leanY: -.08 }], [1, {}]], linearFirst: true },
      done: { duration: .56, notes: [74, 78, 81], keys: [[0, {}], [.22, { scale: .06, squash: -.06 }], [.48, { squash: .055, leanY: .07 }], [1, {}]] },
      error: { duration: .46, notes: [76, 74], keys: [[0, {}], [.16, { leanX: -.16, scale: -.025 }], [.38, { leanX: .12 }], [.63, { leanX: -.05 }], [1, {}]] },
      poke: { duration: .38, notes: [81, 78], keys: [[0, {}], [.12, { scale: -.06, squash: .075, leanX: .18, leanY: .18 }], [.40, { scale: .045 }], [1, {}]] },
      nudge: { duration: .68, notes: [69, 74], keys: [[0, {}], [.18, { leanY: -.12, scale: .035 }], [.4, { leanY: .035 }], [.61, { leanY: -.06 }], [1, {}]] },
      wake: { duration: .82, notes: [62, 69, 74], keys: [[0, { scale: -.05, bright: -.2 }], [.28, { scale: .075, squash: -.07 }], [.52, { squash: .035 }], [1, {}]] },
      sleep: { duration: 1.5, notes: [69, 66, 62], keys: [[0, {}], [.18, { squash: .08 }], [.42, { leanY: .08, scale: -.04 }], [.72, { squash: .025 }], [1, {}]] },
      arrive: { duration: .3, notes: [81, 74], keys: [[0, {}], [.18, { squash: .04, leanY: .045 }], [.44, { squash: -.02 }], [1, {}]] },
      gulp: { duration: .62, notes: [69, 76, 78], keys: [[0, {}], [.15, { scale: .10, squash: .08 }], [.36, { scale: -.1, squash: -.06 }], [.65, { scale: .03 }], [1, {}]] },
      settle: { duration: .52, notes: [66, 62], keys: [[0, {}], [.18, { squash: .085, leanX: .06 }], [.4, { squash: -.04, leanX: -.035 }], [.65, { squash: .02 }], [1, {}]] }
    },
    sound: { master: .12, harmonic: .16, filter: 2400, attack: .012, decay: .045, sustain: .45, release: .16, length: .11, spacing: .065, debounce: .09 },
    motifs: { reach: [62, 69], rewind: [69, 62], skate: [62, 64, 69, 74], perch: [66, 69, 74], bubble: [69, 74], intro: [62, 66, 69, 74] },
    moves: { reach: .740, rewind: .520, tap: .180, tapPixels: 3, perchReach: .800, curl: .400, curlRadius: 18, uncoil: .420, recoil: .520, cruiseSpeed: 180, cruiseMin: 1.10, cruiseMax: 3.60, pulseInterval: 2.6, pulseSpeed: 260, tipLightLag: 12 },
    surfaces: { open: .320, close: .130, textIn: .180, textOut: .090, burst: .160, trace: 1.10, openBezier: [.22, 1.12, .36, 1], closeBezier: [.4, 0, 1, 1] },
    geometry: { size: 116, radius: 26, tube: 5.8, fov: 6.2, samples: 120, runs: 24, tailFrom: .79, tailLength: 40 },
    ease: { unwind: [.45, 0, .20, 1], rewind: [.16, 1, .30, 1] }, stateEase: 4.5, sleepStop: 1.8
  };

  // Numbers the playground kept as literals in its code. Same values, named.
  const inline = {
    sound: {
      peak: .30,            // voice envelope peak, before the master gain
      stopTail: .015,
      // per-motif overrides of sound.spacing / sound.length, and start delays.
      // Note: skate (0.69 s) and intro (0.60 s) run past the header's "max
      // motif .50s"; the numbers are the playground's, the header was wrong.
      motif: {
        reach: { delay: .36 },
        skate: { spacing: .12, length: .17, delay: .36 },
        bubble: { spacing: .075 },
        intro: { spacing: .11 }
      }
    },
    lean: {
      reading: .18,          // toward the screen centre
      pointing: .14,         // toward what the thread points at
      listening: .035,       // toward the cursor, added to the state lean
      listeningMinDistance: 10,
      fileHover: .15,        // toward a file dragged over the window
      drag: { perSpeed: 1400, max: .22 }
    },
    fileHover: { scale: .035, squash: .09 },
    speaking: { rateA: 8.2, rateB: 3.1, gain: .7, scale: .035, squash: -.025, bright: .1 },
    sleepBreathFade: 1.5,
    body: {
      tumbleBase: 2.35, tumbleRate: .18, tumbleAmp: .16, rotX: .26, rotY: .17,
      depth: 1.6, leanYShift: 14, antennaLength: 78, antennaLean: 20,
      tailReach: [10, 30], restToward: [.3, -.8],
      dprMax: 2
    },
    draw: {
      dark: [13, 15, 25], silver: [201, 206, 220],
      widths: { body: 1.72, wall: 1.06, core: .46, rim: .15 },
      wall: [.20, .62], core: [.38, .55], tintMix: .55,
      coreOffset: [-.4, -.45], rimOffset: [-.5, -.7], rimFrom: .58, rimAlpha: [.25, .5], rimMin: .6,
      light: [-.6, -.8],
      band: { half: .055, width: .55, alpha: .65, glowRadius: 10, glowStrength: .28 },
      halo: { inner: 5, outer: 48, alpha: .055 },
      particles: { count: 3, rx: 42, ry: 17, rate: .25, size: .9, alpha: .28, m: [.94, -.34, .34, .94] },
      glow: { white: .42, accent: .22, mid: .3 }
    },
    thread: {
      samples: 96,            // the path has 97 points, uniform in t
      bow: { c1: .28, c2: .72, weight: .20, max: 100, perDistance: .25 },
      seamBlend: 12,
      strokes: [7, 5, 2, .65], coreOffset: [-.3, -.5], rimOffset: [-.5, -1], rimAlpha: .42, coreMix: .5,
      tipGlow: [13, .6], pulseGlow: [10, .45],
      pad: 24, dprMax: 1.5
    },
    acrobat: { segments: 24, sweep: 1.5, offset: 18 },
    burst: { lines: 3, angle: -.85, step: .35, from: 6, grow: 4, length: 6, width: 1 },
    ribbon: { length: 90, amplitude: 10, waves: 1.2, phaseRate: 2, depth: .2, tube: 5 },
    cruise: { ramp: .2 },
    surface: {
      // where a surface sits by the Knot: its near corner is the thread's tip
      offsetX: 44, offsetY: 56, anchorInset: 16, margin: 16,
      outlineRadius: 16, outlineArc: 12,
      openFrom: .05, closeTo: .93, textRise: 3
    },
    drag: { moved: 3, minDt: .008 },
    frame: { active: 1000 / 60, rest: 1000 / 30, slack: .7, maxDt: .05 },
    errorAccent: '#E06A5A'
  };

  // Numbers only the app needs.
  const host = {
    sleepAfterMs: 90000,       // idle this long with nothing open, then sleep
    pointerLoopMs: 30000,      // a settled pointer stops animating after this
    tipGap: 9,                 // the tip stops this far short of a target box
    retargetMs: 300,           // step to step: the tip swings from A to B
    springSnap: { x: 1e-4, v: 1e-3 },  // below this a spring is at rest (stops the underflow crash)
    gestureHandoffMs: 70,      // a replaced gesture fades its leftover offset over this
    clampMargin: 40,           // the Knot's centre stays this far inside the screen
    mic: { bright: .1, band: .5 },     // how much the live mic level lifts the glow and the band while listening
    skater: { minDistance: 80 },
    // Play (renderer/play.js): hoops, started on purpose from the Knot's menu or
    // the tray, never during a task. px, px/s, px/s^2, seconds.
    play: {
      radius: 28,                // the Knot as a ball: what bounces and what scores
      throwMin: 240,             // a release slower than this just drops
      throwMax: 3400,
      releaseStaleMs: 90,        // the hand stopped this long before letting go: no throw
      throwWindowMs: 80,         // the throw is the hand's average speed over this last stretch
      gravity: 2000,
      air: .22,                  // speed lost per second in the air (fraction)
      wall: .62, floor: .5,      // how much speed a bounce keeps
      floorFriction: 4,          // rolling on the floor slows this fast
      restSpeed: 36,             // slower than this on the floor: it has stopped
      spin: .55,                 // spin on release, as a share of rolling speed
      spinMax: 5,                // rad/s, the fastest it is seen to turn (under one turn a second)
      idleEndMs: 40000,          // nothing touched this long and the game ends
      hitstopMs: 75,             // the beat of stillness after a swish or bank shot
      // Impacts squash the Knot along their direction and it springs back.
      squash: { per: 1 / 4200, max: .26, k: 520, damp: 20 },
      // board: up/down from the rim and its gap from the rim's back end, all times r.
      // motion per level (1, 2, 3...): drift (share of width), speed (rad/s), bob (share of height).
      hoop: {
        r: 56, rimR: 5, rimBounce: .55, boardBounce: .72, boardUp: 1.35, boardDown: .3, boardGap: .14,
        makesPerLevel: 3, minY: .2, maxY: .42, margin: .1,
        motion: [{ drift: 0, speed: 0, bob: 0 }, { drift: 0, speed: 0, bob: 0 }, { drift: .1, speed: .9, bob: 0 }, { drift: .13, speed: 1.2, bob: 0 }, { drift: .14, speed: 1.4, bob: .04 }, { drift: .16, speed: 1.7, bob: .06 }],
      },
      // A ball already coming down near the rim is pulled gently toward it.
      assist: { reach: 1.5, above: 2.6, pull: 900 },
      score: { make: 1, swish: 2, bank: 2, fireAt: 3, fireMul: 2 },
    },
    acrobat: { minWidth: 320, minHeight: 200 },
    // A project resuming: how long the thread rests on each of its open windows.
    projectWindows: { holdMs: 1100 },
    // Speed first: the typing box is live at once and the answer's reach starts
    // while the model is still working. false = the playground's exact
    // Reach, tap, Open order for every surface.
    speedFirst: true,
    preReachDelayMs: 350,      // thinking must last this long before the thread goes out to wait
    quietWalkthrough: false,   // true = no reach / rewind motif between steps of one walkthrough
    ackGapMs: 300,             // an ask with no acknowledgement in this window gets one
    // Light desktops. backdrop 0 = dark behind the Knot, 1 = white.
    light: {
      sampleMs: 1500, ease: 3, box: 96,
      // Which look it takes on a light desktop (docs/knot-light-lab.html shows all three):
      //   'outline'  one continuous, slightly thinner edge, a soft feather and a contact shadow
      //   'graphite' the tube wall deepens to steel under a crisp continuous edge
      //   'pool'     it carries a soft dark ground with it
      //   'none'     no adaptation
      treatment: 'outline',
      from: .45, to: .8,       // brightness range over which the treatment fades in
      graphite: { wall: [.14, .52], core: [.37, .55], outline: 1.6, outlineAlpha: 1 },
      pool: { alpha: .42, inner: 8, outer: 56 },
      outline: { width: 1.5, feather: 2.4, featherAlpha: .16, shadowAlpha: .14, shadowRadius: 46 }
    }
  };

  // One colour per meaning (Pranav's palette, 2026-11-03). The Knot, the pill and
  // the CSS all take these; tests hold the CSS to them.
  const palette = { idle: '#F5F5F7', listening: '#C58AFF', thinking: '#FFC76A', speaking: '#59B9FF', done: '#72DDA8', error: '#FF706B' };
  const hexRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

  // The character as decided 2026-11-02: one curve in three poses, white with
  // an ink outline at rest. Shapes are weights on one set of points, so
  // every change between them is the same strand moving, never a cut.
  const shaped = (flat, face, loose, spin, hover, scale, tempo) => ({
    shape: { flat, face, loose }, spin, hover,
    pose: pose(scale, 0, 0, 0, 0, 0, tempo, 1),
  });
  const character = {
    geometry: { size: 180, radius: 32, tube: 6.6, samples: 180 },
    look: { ink: [13, 15, 25], white: hexRgb(palette.idle), wall: 1.06, outline: 2.8, run: 8, overlapInk: .4, overlapWhite: 1.2, thread: 3.2, thickThin: .09, supersample: 2 },
    // What the Knot says while it is doing something (2026-11-03). At rest and
    // asleep it is only ink and white. On a change one lap of colour runs round
    // the strand from the tail, laying a thin core down behind it, while a soft
    // copy of the strand behind it (the glow, blurred to the shape, never an orb)
    // reaches its colour. Seconds; canvas px, so all of it scales with the Knot.
    accent: {
      palette,
      // The colour each state wears. A state not named here stays white.
      states: { listening: 'listening', thinking: 'thinking', working: 'thinking', speaking: 'speaking', reading: 'speaking', error: 'error' },
      // A gesture that says something for a moment, outranking the state.
      beats: { done: { colour: 'done', hold: .8 }, error: { colour: 'error', hold: .8 } },
      lap: .5, head: .1, headWidth: .78, core: .46,   // core and head as parts of the white's width
      // Inside 100 ms and 300 ms whichever way the frames fall (the real app measured 115 at .1).
      arrive: .08, leave: .28,
      mic: { floor: .78, width: .3, glow: .2, ease: 14 },
      // spread is how far it shows past the line; low and high the breath, period its cycle.
      glow: { spread: 13, strength: .85, low: .6, high: 1, period: 2.6 },
    },
    // [stiffness, damping], mass 1, like every other spring.
    springs: { flat: [120, 21], face: [120, 20], loose: [130, 22], tail: [140, 21], mirror: [60, 13], aim: [120, 17], slack: [70, 15], stretch: [220, 24], lagX: [85, 8.5], lagY: [85, 8.5], ripple: [70, 13] },
    flat: { tilt: 1.15, squash: .1, thin: .6 },
    // The tail is one whole lobe drawn out into a narrow closed stem.
    loose: { lobe: 1, toward: [.8, -.6], stem: 2.6, width: .58, tipWidth: .457, edge: .12, rest: 40, reach: 56, flight: 50, micPulse: .05, threadSpeed: 300, threadMin: .2 },
    spin: { ease: 3.5, stiff: 90, damp: 17, lead: .2, waitFor: .55, waitEase: 9 },
    hoverEase: 4, hoverStep: .25, asleepFps: 20, dragSmooth: .3,
    // Moving, it is a strand with weight, not a picture sliding across the screen.
    motion: { smooth: 16, jump: 240, lagPer: .03, lagMax: 18, lagReach: 44, rippleFull: 800, ripple: 1.8, rippleWaves: 5, waveRate: 13, whip: 5, whipWaves: .9, dragTailAt: 480 },
    // shaped(flat, face, loose, spin rad/s, hover [px, rate, breath], scale, tempo)
    states: {
      idle: shaped(1, 0, 0, 0, [2.6, 1.35, .012], .86, 1),
      ready: shaped(0, 0, 1, 0, [1.2, 1.6, .006], 1, 1.1),
      listening: shaped(0, 0, 1, 0, [.8, 2, .004], 1.02, 1.2),
      working: shaped(0, 1, 0, 1.1, [.8, 1.8, .004], .96, 1.2),
      reading: shaped(0, 1, 0, 0, [.8, 1.6, .004], .96, 1),
      thinking: shaped(0, 1, 0, 1.6, [.8, 1.8, .004], .96, 1.4),
      speaking: shaped(0, 0, 1, 0, [.8, 1.6, .004], 1, 1.12),
      error: shaped(0, 0, 1, 0, [.8, 1.6, .004], 1, .9),
      sleeping: shaped(1, 0, 0, 0, [2, .85, .012], .84, .25),
    },
    // Whole-Knot flight. speed px/s, seconds clamped, bow toward the screen centre.
    flight: { speed: 900, min: .5, max: 1.1, ease: [.45, 0, .2, 1], bow: .18, bowMax: 90, stretchPer: .00016, stretchMax: .16, trailMin: 40 },
    // The lasso: thrown a little wide, then pulled snug. gap and power set the hug;
    // power 2 is an oval, higher follows the control's corners.
    lasso: { gap: 9, power: 3.4, sweep: 1.06, points: 96, startAt: .6, draw: .62, ease: [.35, 0, .15, 1], rewind: .28, thrown: 7, cinch: .5, ripple: 1.4, rippleWaves: 3, landing: 86, leadPoints: 14 },
    // How far the Knot loosens while the lasso is out (slack 1 = fully paid out).
    unravel: { hold: .5, depth: .55, shrink: .04 },
    // The region mark (O4, option C, the small pen, Pranav's pick 2026-11-02):
    // a rounded rectangle pad px outside the area, drawn by the Knot at 55
    // percent riding ahead px past the pen and out px outside the line, slowing
    // to cornerSpeed over slowOver px into each corner. Time from the perimeter
    // at speed px/s, clamped. rewind is how long it takes to reel in.
    region: { scale: .55, pad: 6, radius: 18, step: 12, overrun: 5, wobble: 1.3, wobbleRate: .045, ahead: 26, out: 8, cornerSpeed: .34, slowOver: 170, slowEnds: 60, speed: 1500, min: 1.4, max: 2.6, leadPoints: 10, rewind: .28 },
    // The pill (island mode), decided 2026-11-02 from Clicky's measured notch:
    // the state word at the left, the Knot riding the right end. Idle is the
    // Knot alone, 48 by 40. Open: one frame past the target, settled by 70 ms.
    // Close: under idle at 150 ms, a small bounce at 250, settled by 480.
    island: {
      top: 8, h: 40, pad: 4, idle: 48, scale: .41, drop: 10,
      // Unfolded into the task list (O6), as wide as the render.
      panel: 460,
      open: { over: 1.07, snap: .017, settle: .07 },
      close: { low: .77, high: 1.4, at: [.15, .25, .48] },
      // The dot and ring per tone, the same colours as the Knot. Hands is work,
      // so it wears thinking's colour.
      accents: { idle: palette.idle, listening: palette.listening, thinking: palette.thinking, hands: palette.thinking, reading: palette.speaking, speaking: palette.speaking, done: palette.done, error: palette.error },
    },
    // The Hands edge glow (O3 A): one cool blue on four edge strips, breathing
    // from JS at a low rate, because a full screen layer composited at 60 fps
    // cost 19 percent of a core on the 4700U. Seconds, CSS pixels, 0 to 1.
    glow: { color: [104, 150, 255], edge: 130, period: 3.2, low: .72, high: 1, half: .5, fps: 12 },
    // The six cue sounds (O5, family A, woody and soft), rendered by
    // cue-samples.js from these numbers. A note is [start s, Hz, decay s per
    // partial, length s, pitch bend]; a click is [low pass Hz, level, decay s].
    // Pitches as the renders measured them: press A3, release A4 (an octave
    // up), tick B5, done-notes A4 then D5 (the motif named done stays for
    // answers; these mark the tour's end and a long Hands run), Hands start
    // D4 then A4, Hands stop A4
    // then D4. peakDb is the sample's peak; level is its gain into the voice;
    // a Hands run longer than longRunMs also gets the done notes at its end.
    cues: {
      rate: 48000, level: .7, seed: 115, longRunMs: 20000,
      wood: { ratios: [1, 2.76, 5.4], amps: [1, .2, .04] },
      press: { notes: [[0, 220, [.045, .016, .007], .12, .05]], click: [1400, .1, .002], peakDb: -20 },
      release: { notes: [[0, 440, [.03, .011, .005], .085, .04]], click: [2200, .08, .002], peakDb: -16 },
      tick: { partials: { ratios: [1, 3.1], amps: [1, .18] }, notes: [[0, 987.77, [.011, .004], .045, 0]], click: [3500, .06, .001], peakDb: -24 },
      'done-notes': { notes: [[0, 440, [.2, .05, .015], .5, 0], [.17, 587.33, [.26, .06, .015], .62, 0]], peakDb: -18 },
      'hands-start': { notes: [[0, 293.66, [.16, .04, .012], .34, 0], [.12, 440, [.2, .05, .012], .4, 0]], peakDb: -18 },
      'hands-stop': { notes: [[0, 440, [.09, .03, .01], .22, 0], [.09, 293.66, [.14, .04, .01], .3, 0]], peakDb: -20 },
    },
  };

  // ---- pure helpers, shared by the engine, the surfaces and the tests -----
  const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
  const smooth = (u) => { u = clamp(u); return u * u * (3 - 2 * u); };
  // CSS cubic-bezier evaluated in JS, so canvas and CSS share one time curve.
  function bezierEase(u, v) {
    const curve = (t, a, b) => 3 * (1 - t) * (1 - t) * t * a + 3 * (1 - t) * t * t * b + t * t * t;
    let lo = 0, hi = 1, t = u;
    for (let i = 0; i < 16; i++) { t = (lo + hi) / 2; if (curve(t, v[0], v[2]) < u) lo = t; else hi = t; }
    return curve(t, v[1], v[3]);
  }
  // Trapezoid velocity: accelerate over the first fifth, cruise, decelerate.
  function cruiseEase(u) { return u < .2 ? u * u / .32 : u > .8 ? 1 - (1 - u) * (1 - u) / .32 : (u - .1) / .8; }
  const cssBezier = (v) => 'cubic-bezier(' + v.join(',') + ')';
  const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

  const api = Object.assign({ PARAMS, SPEC, inline, host, character, hexRgb, clamp, smooth, bezierEase, cruiseEase, cssBezier, midiHz }, SPEC);
  root.NusKnotSpec = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
