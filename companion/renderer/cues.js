// The Knot's voice: short tonal motifs, synthesised in place, no audio files.
// One key (D major pentatonic) and one timbre (a sine with a quiet octave
// above it), so every cue sounds like the same small voice. Notes, envelope
// and spacing all come from knot-spec.js; nothing here is tuned by hand.
//
// Since 0.1.15 there are also six struck-wood cue sounds (renders-0115, O5
// family A): press, release, tick, done, hands-start, hands-stop. They are
// rendered once from the numbers in knot-spec.js (cue-samples.js) into a
// buffer each, still no audio file, and played through their own gain.
//
// Rules it keeps:
//   - Finite. Every motif is a handful of notes that end; nothing repeats.
//   - Never while the mic is live or while it is speaking: play() refuses,
//     and quiet() silences a motif that was already on its way. One
//     exception, by design: the press pop marks the mic opening, so it may
//     be forced through (play('press', { force: true })) and only it. The
//     whisper test proves the transcript stays clean under it.
//   - Mute means silent within 20 ms.
(() => {
  'use strict';
  const S = window.NusKnotSpec;
  if (!S) { window.NusCues = { play() { return false; }, setEnabled() {}, isEnabled() { return false; }, setGate() {}, quiet() {}, active() { return 0; }, names: [], samples: [] }; return; }
  const SND = S.sound, IN = S.inline.sound, CUES = S.character.cues, SAMPLER = window.NusCueSamples;
  let ctx = null, master = null, sampleGain = null, enabled = true, lastStart = -10, live = 0;
  let gate = () => false;   // host says true while the mic is live or it is speaking

  // name -> { notes (MIDI), spacing, length, delay }. Gestures carry their own
  // notes; the moves and surfaces have theirs.
  const MOTIFS = {};
  for (const [name, g] of Object.entries(S.gestures)) MOTIFS[name] = { notes: g.notes };
  for (const [name, notes] of Object.entries(S.motifs)) MOTIFS[name] = Object.assign({ notes }, IN.motif[name] || {});
  // The names the app already used for two of them.
  const ALIAS = { ack: 'acknowledge', drop: 'gulp' };
  const SAMPLES = SAMPLER ? SAMPLER.names(CUES) : [];
  const buffers = {};

  function ensure() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = enabled ? SND.master : 0;
    master.connect(ctx.destination);
    sampleGain = ctx.createGain();
    sampleGain.gain.value = enabled ? CUES.level : 0;
    sampleGain.connect(ctx.destination);
    return ctx;
  }
  function level(to) {
    if (!ctx) return;
    master.gain.cancelScheduledValues(ctx.currentTime);
    master.gain.setTargetAtTime(to, ctx.currentTime, .02 / 3);   // there within about 20 ms
  }
  function sampleLevel(to) {
    if (!ctx) return;
    sampleGain.gain.cancelScheduledValues(ctx.currentTime);
    sampleGain.gain.setTargetAtTime(to, ctx.currentTime, .02 / 3);
  }
  function buffer(c, name) {
    if (buffers[name]) return buffers[name];
    const data = SAMPLER.render(CUES, name, CUES.rate);
    const b = c.createBuffer(1, data.length, CUES.rate);
    b.copyToChannel ? b.copyToChannel(data, 0) : b.getChannelData(0).set(data);
    buffers[name] = b;
    return b;
  }
  function playSample(name, c) {
    const src = c.createBufferSource();
    src.buffer = buffer(c, name);
    src.connect(sampleGain);
    src.start(c.currentTime);
    live++;
    src.onended = () => { live--; src.disconnect(); };
    return true;
  }

  function play(name, opts) {
    if (!enabled) return false;
    const forced = !!(opts && opts.force) && name === 'press';
    if (gate() && !forced) return false;
    const c = ensure();
    if (!c) return false;
    if (c.state === 'suspended') { try { c.resume(); } catch (_) { /* no user gesture yet */ } }
    if (SAMPLES.includes(name)) return playSample(name, c);
    const m = MOTIFS[ALIAS[name] || name];
    if (!m) return false;
    const now = c.currentTime, delay = m.delay || 0;
    // Two motifs started together would smear into noise; the later one waits its turn out.
    if (!delay && now - lastStart < SND.debounce) return false;
    lastStart = now;
    level(SND.master);
    const spacing = m.spacing || SND.spacing, length = m.length || SND.length;
    m.notes.forEach((midi, i) => {
      const t = now + delay + i * spacing, f = S.midiHz(midi);
      const env = c.createGain(), filter = c.createBiquadFilter();
      filter.type = 'lowpass'; filter.frequency.value = SND.filter;
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(IN.peak, t + SND.attack);
      env.gain.exponentialRampToValueAtTime(IN.peak * SND.sustain, t + SND.attack + SND.decay);
      env.gain.setValueAtTime(IN.peak * SND.sustain, t + length);
      env.gain.exponentialRampToValueAtTime(.0001, t + length + SND.release);
      env.connect(filter); filter.connect(master);
      const fund = c.createOscillator(), harm = c.createOscillator(), hg = c.createGain();
      fund.type = harm.type = 'sine'; fund.frequency.value = f; harm.frequency.value = f * 2; hg.gain.value = SND.harmonic;
      fund.connect(env); harm.connect(hg); hg.connect(env);
      const end = t + length + SND.release + IN.stopTail;
      fund.start(t); harm.start(t); fund.stop(end); harm.stop(end);
      live++;
      fund.onended = () => { live--; fund.disconnect(); harm.disconnect(); hg.disconnect(); env.disconnect(); filter.disconnect(); };
    });
    return true;
  }

  window.NusCues = {
    play,
    setEnabled(v) { enabled = v !== false; level(enabled ? SND.master : 0); sampleLevel(enabled ? CUES.level : 0); },
    isEnabled() { return enabled; },
    // The host installs the gate: a function that is true while the mic is live.
    setGate(fn) { gate = typeof fn === 'function' ? fn : () => false; },
    // The mic just opened: whatever motif is sounding or scheduled goes silent
    // now. The sample gain is left alone, so the press pop can mark the moment.
    quiet() { level(0); },
    // Notes still sounding or scheduled (0 when the voice is at rest).
    active() { return live; },
    names: Object.keys(MOTIFS).concat(Object.keys(ALIAS)),
    samples: SAMPLES.slice(),
  };
})();
