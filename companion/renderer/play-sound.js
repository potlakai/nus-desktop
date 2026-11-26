// What the hoops game sounds like (play.js has the rules). Synthesised in place
// like the Knot's own cues (cues.js), no audio files. Made notes are in the
// Knot's key, D major pentatonic, and climb one step for every make in a row.
//
// Rules it keeps, the same as cues.js:
//   - Silent when Sound cues is off, while the mic is live or the Knot speaks
//     (the host's enabled() says so on every sound).
//   - Finite: every sound is a handful of short notes that end.
//   - Nothing running between games: suspend() parks the audio thread when a
//     game ends; resume() wakes it for the next one.
(function (root) {
  'use strict';

  const PENT = [62, 64, 66, 69, 71, 74, 76, 78, 81, 83, 86, 88];   // D E F# A B, climbing
  const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);
  const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));

  function create({ enabled, level }) {
    let ctx = null, out = null, noise = null;
    const MASTER = level == null ? 0.2 : level;

    function ensure() {
      if (ctx) return ctx;
      const AC = root.AudioContext || root.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14; comp.ratio.value = 4;
      out = ctx.createGain(); out.gain.value = MASTER;
      out.connect(comp); comp.connect(ctx.destination);
      // One second of noise, shared by every swish, thud and whoosh.
      noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const d = noise.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      return ctx;
    }
    function ok() { return !!(ctx && ctx.state !== 'closed' && (!enabled || enabled())); }

    function env(g, t, peak, attack, decay) {
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    }
    function tone(type, f0, f1, t, peak, attack, decay, dest) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type; o.frequency.setValueAtTime(f0, t);
      if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + attack + decay);
      env(g, t, peak, attack, decay);
      o.connect(g); g.connect(dest || out);
      o.start(t); o.stop(t + attack + decay + 0.02);
    }
    function hiss(t, peak, attack, decay, filter, f0, f1, q) {
      const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
      s.buffer = noise; s.loop = true;
      f.type = filter; f.Q.value = q || 1; f.frequency.setValueAtTime(f0, t);
      if (f1 && f1 !== f0) f.frequency.exponentialRampToValueAtTime(f1, t + attack + decay);
      env(g, t, peak, attack, decay);
      s.connect(f); f.connect(g); g.connect(out);
      s.start(t, Math.random() * 0.5); s.stop(t + attack + decay + 0.02);
    }
    function note(m, t, peak, decay) {
      tone('sine', hz(m), 0, t, peak, 0.004, decay);
      tone('sine', hz(m + 12), 0, t, peak * 0.22, 0.004, decay * 0.6);
      tone('triangle', hz(m), 0, t, peak * 0.12, 0.006, decay * 0.8);
    }

    // ---- the sounds ------------------------------------------------------------------
    const S = {
      floor(i) { const k = clamp(i / 2600, 0.08, 1), t = ctx.currentTime; tone('sine', 150, 52, t, 0.75 * Math.pow(k, 0.8), 0.003, 0.17); hiss(t, 0.14 * k, 0.002, 0.04, 'lowpass', 900, 600); },
      wall(i) { S.floor(i * 0.8); },
      rim(i) {
        const k = clamp(i / 1800, 0.12, 1), t = ctx.currentTime, d = 1 + (Math.random() - 0.5) * 0.02;
        [[523, 1, 0.34], [1290, 0.5, 0.26], [2240, 0.28, 0.2], [3170, 0.14, 0.14]].forEach(([f, a, dec]) => tone('sine', f * d, 0, t, 0.3 * k * a, 0.002, dec));
      },
      board(i) { const k = clamp(i / 1800, 0.12, 1), t = ctx.currentTime; tone('sine', 220, 120, t, 0.45 * k, 0.003, 0.09); hiss(t, 0.22 * k, 0.002, 0.06, 'bandpass', 700, 500, 3); },
      swish() { const t = ctx.currentTime; hiss(t, 0.42, 0.025, 0.24, 'bandpass', 3200, 900, 1.1); hiss(t + 0.03, 0.12, 0.02, 0.16, 'highpass', 5000, 3000, 0.7); },
      chime(streak) {
        const t = ctx.currentTime + 0.04, m = PENT[clamp(streak - 1, 0, PENT.length - 1)];
        note(m, t, 0.26, 0.55);
        note(m + 7, t + 0.075, 0.12, 0.45);
      },
      fire() { const t = ctx.currentTime + 0.1; [5, 7, 9].forEach((i, n) => note(PENT[i], t + n * 0.06, 0.16, 0.35)); hiss(t, 0.18, 0.12, 0.25, 'bandpass', 500, 2600, 1.4); },
      record() { const t = ctx.currentTime + 0.18; [4, 6, 8, 9, 11].forEach((i, n) => note(PENT[i], t + n * 0.085, 0.2, n === 4 ? 0.8 : 0.32)); },
      catch() { const t = ctx.currentTime; tone('sine', 520, 900, t, 0.12, 0.004, 0.05); },
      throw(speed) { const k = clamp(speed / 3000, 0.15, 1), t = ctx.currentTime; hiss(t, 0.13 * k, 0.03, 0.16, 'bandpass', 380, 1900, 1.6); },
      hoop() { const t = ctx.currentTime; tone('sine', 330, 700, t, 0.12, 0.01, 0.12); tone('sine', 660, 990, t + 0.06, 0.07, 0.01, 0.1); },
      miss() { const t = ctx.currentTime; note(69, t, 0.08, 0.18); note(66, t + 0.12, 0.08, 0.3); },
    };

    function event(e) {
      if (e.type === 'start') { resume(); return; }
      if (e.type === 'stop') { suspend(); return; }
      if (!ok()) return;
      try {
        switch (e.type) {
          case 'floor': if (e.impact > 160) S.floor(e.impact); break;
          case 'wall': if (e.impact > 160) S.wall(e.impact); break;
          case 'rim': S.rim(e.impact); break;
          case 'board': S.board(e.impact); break;
          case 'catch': S.catch(); break;
          case 'throw': S.throw(e.speed); break;
          case 'make': S.swish(); S.chime(e.streak); if (e.fireStart) S.fire(); break;
          case 'record': S.record(); break;
          case 'hoopIn': case 'hoopMove': S.hoop(); break;
          case 'miss': if (e.streak >= 3) S.miss(); break;
          default: break;
        }
      } catch (_) { /* a sound never breaks the game */ }
    }
    function resume() { if (ensure() && ctx.state !== 'running') ctx.resume().catch(() => {}); }
    function suspend() { if (ctx && ctx.state === 'running') ctx.suspend().catch(() => {}); }
    function close() { if (ctx) { ctx.close().catch(() => {}); ctx = null; } }

    return { event, resume, suspend, close, get state() { return ctx ? ctx.state : 'none'; } };
  }

  const api = { create, PENT };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NusPlaySound = api;
})(typeof window !== 'undefined' ? window : globalThis);
