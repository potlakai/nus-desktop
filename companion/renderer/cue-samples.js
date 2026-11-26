// The six cue sounds, rendered from numbers (knot-spec.js character.cues):
// struck wood, family A of renders-0115-2026-11-02. Each note is a few
// decaying partials with a short pitch bend at the strike, plus a filtered
// click; two-note cues are laid in sequence. Pure arithmetic, no audio API,
// so the renderer and the whisper test (companion/test/cue-whisper.test.js)
// render the very same samples. Deterministic: the click noise is seeded.
(function (root) {
  'use strict';

  // xorshift32: the same click every time, on every machine.
  function prng(seed) {
    let x = seed >>> 0 || 1;
    return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296 * 2 - 1; };
  }
  // Second order Butterworth low pass, bilinear transform, run in place.
  function lowpass(y, rate, cutoff) {
    const k = Math.tan(Math.PI * cutoff / rate), k2 = k * k, norm = 1 / (1 + Math.SQRT2 * k + k2);
    const b0 = k2 * norm, b1 = 2 * b0, b2 = b0, a1 = 2 * (k2 - 1) * norm, a2 = (1 - Math.SQRT2 * k + k2) * norm;
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < y.length; i++) {
      const x0 = y[i], out = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = x0; y2 = y1; y1 = out; y[i] = out;
    }
    return y;
  }
  // One struck note: partials at the given ratios, each decaying on its own
  // clock; the pitch bends down over the first 12 ms; a 1.5 ms attack and a
  // 6 ms tail so it never clicks at either end.
  function modal(rate, hz, ratios, amps, decays, dur, glide) {
    const n = Math.round(dur * rate), y = new Float32Array(n), attack = .0015;
    let phase = 0;
    for (let i = 0; i < n; i++) {
      const t = i / rate;
      phase += 2 * Math.PI * hz * (1 + glide * Math.exp(-t / .012)) / rate;
      let v = 0;
      for (let k = 0; k < ratios.length; k++) v += amps[k] * Math.sin(phase * ratios[k]) * Math.exp(-t / decays[k]);
      y[i] = v * Math.min(t / attack, 1) * Math.min((dur - t) / .006, 1);
    }
    return y;
  }
  function click(rate, dur, cutoff, level, decay, seed) {
    const n = Math.round(dur * rate), y = new Float32Array(n), r = prng(seed);
    for (let i = 0; i < n; i++) y[i] = r();
    lowpass(y, rate, cutoff);
    for (let i = 0; i < n; i++) y[i] *= level * Math.exp(-(i / rate) / decay);
    return y;
  }

  // -> Float32Array at `rate`, peak at the cue's peakDb.
  function render(cues, name, rate) {
    const c = cues[name];
    if (!c || !c.notes) throw new Error('no such cue: ' + name);
    rate = rate || cues.rate;
    const parts = c.partials || cues.wood;
    let total = 0;
    for (const [start, , , dur] of c.notes) total = Math.max(total, start + dur);
    if (c.click) total = Math.max(total, c.notes[0][3]);
    const y = new Float32Array(Math.round(total * rate));
    const lay = (at, s) => { const i0 = Math.round(at * rate); for (let i = 0; i < s.length && i0 + i < y.length; i++) y[i0 + i] += s[i]; };
    for (const [start, hz, decays, dur, glide] of c.notes) lay(start, modal(rate, hz, parts.ratios, parts.amps, decays, dur, glide || 0));
    if (c.click) lay(0, click(rate, c.notes[0][3], c.click[0], c.click[1], c.click[2] || .002, cues.seed));
    let peak = 0;
    for (let i = 0; i < y.length; i++) peak = Math.max(peak, Math.abs(y[i]));
    const want = Math.pow(10, c.peakDb / 20), g = peak > 0 ? want / peak : 0;
    for (let i = 0; i < y.length; i++) y[i] *= g;
    return y;
  }
  const names = (cues) => Object.keys(cues).filter((k) => cues[k] && cues[k].notes);

  const api = { render, names, modal, click, lowpass };
  root.NusCueSamples = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
