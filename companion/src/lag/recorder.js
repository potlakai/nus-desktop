'use strict';
// The lag recorder's core: what gets written, and when. No Electron in here, so
// it runs in tests; companion/src/lag/index.js wires it to the app.
//
// One JSON object per line. Every line carries the time (t), a kind (k) and the
// app's state at that moment (s), so a freeze can be read as "it was speaking,
// the dashboard was open, on battery" instead of "it lagged".
//
//   start   the run: version, cores, how often it samples
//   sample  every sampleMs: main-thread delay, CPU per process, each window's
//           frames and long tasks, whether the overlay was holding the mouse
//   stall   the main thread did not run for stallMs or more (written as soon as
//           it runs again), with what was in flight and whether the overlay was
//           holding the mouse, which is the case that eats clicks everywhere
//   slow    one named piece of main-thread work took slowMs or more
//   spawn   a child process: its name, how long starting it held the main
//           thread, how long it lived
//   mouse   the overlay let go of the mouse after holding it for heldMs
//   state   the state changed
//   hung    a window stopped answering, or answered again
//
// Never words from the screen, never what was said or typed: names of our own
// files and functions, and numbers.

const STATES = ['idle', 'tour', 'download', 'listening', 'transcribing', 'thinking', 'speaking', 'hands'];

function round(n, d = 1) { const f = Math.pow(10, d); return Math.round(Number(n) * f) / f; }

function createRecorder({ write, now = () => Date.now(), hr = () => performance.now(), sampleMs = 5000, tickMs = 50, stallMs = 100, slowMs = 30, heldNoteMs = 1500 } = {}) {
  if (typeof write !== 'function') throw new Error('lag recorder needs write(line)');
  let lines = 0, self = 0;                    // self: ms spent inside the recorder itself
  const flags = { tour: false, download: false, listening: false, transcribing: false, thinking: false, hands: false, speakingUntil: 0 };
  const facts = { dashboard: false, signin: false, battery: false };
  let lastState = '';
  // The overlay and the touch pad: true while the window takes the mouse.
  const mouse = {};
  const inflight = new Map();                 // spawn id -> name
  let spawnSeq = 0;
  let lastSlow = null;
  const win = { stalls: 0, stallMs: 0, stallMax: 0, heldStallMs: 0, slow: 0, spawns: 0, spawnSyncMs: 0 };
  let lastTick = 0;

  function activity() {
    if (flags.hands) return 'hands';
    if (flags.listening) return 'listening';
    if (flags.transcribing) return 'transcribing';
    if (flags.thinking) return 'thinking';
    if (flags.speakingUntil > now()) return 'speaking';
    if (flags.download) return 'download';
    if (flags.tour) return 'tour';
    return 'idle';
  }
  function stateString() {
    return activity() + (flags.tour && activity() !== 'tour' ? '+tour' : '') + (flags.download && activity() !== 'download' ? '+download' : '') +
      (facts.dashboard ? '+dash' : '') + (facts.signin ? '+signin' : '') + (facts.battery ? '+batt' : '');
  }
  function emit(k, body) {
    const t0 = hr();
    const rec = Object.assign({ t: now(), k, s: stateString() }, body);
    try { write(JSON.stringify(rec)); lines++; } catch (_) { /* a full disk must not take the app down */ }
    self += hr() - t0;
    return rec;
  }
  function stateChanged() {
    const s = stateString();
    if (s === lastState) return;
    lastState = s;
    emit('state', {});
  }

  // ---- state, from the app ------------------------------------------------
  function set(patch) {
    for (const [k, v] of Object.entries(patch || {})) {
      if (k in facts) facts[k] = !!v;
      else if (k === 'speakingMs') flags.speakingUntil = v > 0 ? now() + Number(v) : 0;
      else if (k in flags) flags[k] = !!v;
    }
    stateChanged();
  }
  // The overlay's own channels already say what the Knot is doing; read the
  // state off them instead of adding calls all over the app.
  function channel(name, data) {
    const d = data || {};
    switch (name) {
      case 'ptt:state': set({ listening: !!d.held }); break;
      case 'guide:state': {
        const st = d.state || null;
        set({ listening: st === 'listening', transcribing: st === 'transcribing', thinking: st === 'thinking' || st === 'reading' || st === 'explaining' || st === 'pointing' });
        break;
      }
      case 'llm:start': set({ thinking: true }); break;
      case 'llm:done': case 'llm:error': case 'guide:done': set({ thinking: false, transcribing: false }); break;
      case 'guide:say': if (d.text) set({ speakingMs: 900 + String(d.text).length * 70 }); break;
      case 'voice:hush': set({ speakingMs: 0 }); break;
      case 'hands:state': set({ hands: !!d.active }); break;
      case 'tour:card': set({ tour: true }); break;
      case 'tour:end': set({ tour: false }); break;
      case 'voice:state': set({ download: !!(d.downloading || d.installing || d.phase === 'downloading' || d.phase === 'extracting') }); break;
      default: break;
    }
  }

  // ---- the mouse ----------------------------------------------------------
  // taking: the window takes the mouse (not click-through).
  function mouseSet(name, taking) {
    const m = mouse[name] || (mouse[name] = { taking: false, since: 0, heldMs: 0, flips: 0 });
    taking = !!taking;
    if (m.taking === taking) return;
    const t = now();
    if (m.taking) {
      const held = t - m.since;
      m.heldMs += held;
      if (held >= heldNoteMs) emit('mouse', { w: name, heldMs: held });
    }
    m.taking = taking; m.since = t; m.flips++;
  }
  function mouseHeld() { return Object.keys(mouse).filter((k) => mouse[k].taking); }

  // ---- named main-thread work ---------------------------------------------
  function slow(label, ms) {
    if (!(ms >= slowMs)) return;
    win.slow++;
    lastSlow = { label: String(label).slice(0, 120), ms: round(ms), at: now() };
    emit('slow', { label: lastSlow.label, ms: lastSlow.ms });
  }
  // Wraps a function so its synchronous part is timed. Costs two clock reads.
  function timed(label, fn) {
    if (typeof fn !== 'function') return fn;
    const wrapped = function () {
      const t0 = hr();
      try { return fn.apply(this, arguments); }
      finally { const d = hr() - t0; if (d >= slowMs) slow(typeof label === 'function' ? label(arguments) : label, d); }
    };
    return wrapped;
  }
  function spawnBegin(name, syncMs) {
    const id = ++spawnSeq, t0 = hr();
    inflight.set(id, String(name).slice(0, 80));
    win.spawns++; win.spawnSyncMs += syncMs || 0;
    return function end(code) {
      if (!inflight.delete(id)) return;
      emit('spawn', { name: String(name).slice(0, 80), syncMs: round(syncMs || 0), ms: Math.round(hr() - t0), code: code == null ? null : code });
    };
  }

  // ---- the main thread's own clock ----------------------------------------
  // Called every tickMs by a timer. A late call means nothing on the main
  // thread ran in between: no timers, no IPC, no window messages.
  function tick() {
    const t = hr();
    if (lastTick) {
      const late = t - lastTick - tickMs;
      if (late >= stallMs) {
        const held = mouseHeld();
        win.stalls++; win.stallMs += late; if (late > win.stallMax) win.stallMax = late;
        if (held.includes('overlay')) win.heldStallMs += late;   // the touch window is cut to the controls, so only the overlay can eat clicks
        emit('stall', { ms: Math.round(late), held, inflight: [...new Set(inflight.values())].slice(0, 6), last: lastSlow && now() - lastSlow.at < late + 250 ? lastSlow.label : null });
      }
    }
    lastTick = t;
  }

  // ---- the periodic sample --------------------------------------------------
  // extra: { loop, procs, windows } gathered by the Electron side.
  function sample(extra) {
    const t = now(), m = {};
    for (const [name, v] of Object.entries(mouse)) {
      const held = v.heldMs + (v.taking ? t - v.since : 0);
      m[name] = { taking: v.taking, heldMs: Math.round(held), flips: v.flips };
      v.heldMs = 0; v.flips = 0; if (v.taking) v.since = t;
    }
    const rec = emit('sample', Object.assign({ mouse: m, stalls: { n: win.stalls, ms: Math.round(win.stallMs), max: Math.round(win.stallMax), heldMs: Math.round(win.heldStallMs) },
      slow: win.slow, spawns: { n: win.spawns, syncMs: round(win.spawnSyncMs) }, selfMs: round(self, 2) }, extra || {}));
    win.stalls = 0; win.stallMs = 0; win.stallMax = 0; win.heldStallMs = 0; win.slow = 0; win.spawns = 0; win.spawnSyncMs = 0;
    return rec;
  }

  return { set, channel, mouseSet, mouseHeld, slow, timed, spawnBegin, tick, sample, emit, state: stateString, activity,
    stats: () => ({ lines, selfMs: self }), config: { sampleMs, tickMs, stallMs, slowMs } };
}

// A recorder that does nothing, for when it is off: the app calls the same
// functions either way and pays one property read.
function createNoop() {
  const nothing = () => {};
  return { set: nothing, channel: nothing, mouseSet: nothing, mouseHeld: () => [], slow: nothing, timed: (_l, fn) => fn, spawnBegin: () => nothing, tick: nothing, sample: nothing, emit: nothing,
    state: () => '', activity: () => 'idle', stats: () => ({ lines: 0, selfMs: 0 }), config: null };
}

module.exports = { createRecorder, createNoop, STATES, round };
