// The Knot's voice, run in a vm against a fake audio context: the notes are
// the spec's, every motif ends, mute and the mic gate keep it silent.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const dir = path.join(__dirname, '..', 'renderer');
const specSrc = fs.readFileSync(path.join(dir, 'knot-spec.js'), 'utf8');
const cuesSrc = fs.readFileSync(path.join(dir, 'cues.js'), 'utf8');
const surfaceSrc = fs.readFileSync(path.join(dir, 'surface.js'), 'utf8');
const js = fs.readFileSync(path.join(dir, 'renderer.js'), 'utf8');

function fixture() {
  let now = 0; const oscs = [], gains = [];
  const param = (v) => ({ value: v, events: [], setValueAtTime(x, t) { this.events.push(['set', x, t]); }, linearRampToValueAtTime(x, t) { this.events.push(['lin', x, t]); }, exponentialRampToValueAtTime(x, t) { this.events.push(['exp', x, t]); }, setTargetAtTime(x, t, c) { this.events.push(['target', x, t, c]); this.value = x; }, cancelScheduledValues() {} });
  const node = () => ({ connect() {}, disconnect() {} });
  class AudioContext {
    constructor() { this.state = 'running'; this.destination = node(); }
    get currentTime() { return now; }
    resume() {}
    createGain() { const g = Object.assign(node(), { gain: param(1) }); gains.push(g); return g; }
    createBiquadFilter() { return Object.assign(node(), { type: '', frequency: param(0) }); }
    createOscillator() { const o = Object.assign(node(), { type: '', frequency: param(0), startAt: null, stopAt: null, onended: null, start(t) { this.startAt = t; }, stop(t) { this.stopAt = t; } }); oscs.push(o); return o; }
  }
  const window = { AudioContext };
  const ctx = { window, Math, Object, Number };
  vm.runInNewContext(specSrc, ctx); vm.runInNewContext(cuesSrc, ctx);
  return { cues: window.NusCues, spec: window.NusKnotSpec, oscs, gains, advance(s) { now += s; for (const o of oscs) if (o.stopAt != null && o.stopAt <= now && o.onended) { const f = o.onended; o.onended = null; f(); } }, get now() { return now; } };
}
const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);

test('acknowledge is D5 then A5, a sine with a quiet octave above, 65 ms apart', () => {
  const f = fixture();
  assert.equal(f.cues.play('ack'), true);
  assert.equal(f.oscs.length, 4, 'two notes, each a fundamental and a harmonic');
  const [f1, h1, f2, h2] = f.oscs;
  assert.ok(Math.abs(f1.frequency.value - hz(74)) < 1e-9); assert.ok(Math.abs(h1.frequency.value - 2 * hz(74)) < 1e-9);
  assert.ok(Math.abs(f2.frequency.value - hz(81)) < 1e-9); assert.ok(Math.abs(h2.frequency.value - 2 * hz(81)) < 1e-9);
  assert.ok(Math.abs((f2.startAt - f1.startAt) - f.spec.sound.spacing) < 1e-9);
  assert.equal(f1.type, 'sine');
  const master = f.gains[0];
  assert.equal(master.gain.value, f.spec.sound.master, 'master gain 0.12');
});

test('every motif is finite: all notes stop, and the voice is at rest afterwards', () => {
  const f = fixture();
  for (const name of f.cues.names) {
    f.advance(1);
    const before = f.oscs.length;
    assert.equal(f.cues.play(name), true, name + ' plays');
    const mine = f.oscs.slice(before);
    assert.ok(mine.length >= 4 && mine.length <= 8, name + ': 2 to 4 notes');
    for (const o of mine) { assert.ok(Number.isFinite(o.stopAt) && o.stopAt > o.startAt, name + ' stops'); assert.ok(o.stopAt - f.now < 1.2, name + ' is short'); }
    assert.ok(f.cues.active() > 0);
    f.advance(1.5);
    assert.equal(f.cues.active(), 0, name + ': nothing left sounding');
  }
  assert.doesNotMatch(cuesSrc, /\.loop\s*=|setInterval\(|new Audio\(|fetch\(/, 'no looping source, no timers, no files');
});

test('mute is silent within 20 ms, the mic gate refuses, and quiet() silences a motif already on its way', () => {
  const f = fixture();
  f.cues.play('reach');                       // scheduled 0.36 s ahead
  const master = f.gains[0];
  f.cues.quiet();                             // the mic just opened
  const last = master.gain.events[master.gain.events.length - 1];
  assert.deepEqual(last.slice(0, 2), ['target', 0]); assert.ok(last[3] * 3 <= 0.0201, 'there within 20 ms');
  f.cues.setGate(() => true);
  const n = f.oscs.length;
  assert.equal(f.cues.play('ack'), false, 'refused while the mic is live'); assert.equal(f.oscs.length, n);
  f.cues.setGate(() => false);
  f.cues.setEnabled(false);
  assert.equal(f.cues.play('ack'), false, 'refused while muted'); assert.equal(f.cues.isEnabled(), false);
  f.cues.setEnabled(true); f.advance(1);
  assert.equal(f.cues.play('ack'), true);
  assert.equal(master.gain.value, f.spec.sound.master, 'a play brings the master back');
  assert.equal(f.cues.play('done'), false, 'a second motif inside the debounce waits its turn out');
});

test('the app gates sound on the live mic and on its own speech, and silences it when the mic opens', () => {
  assert.match(js, /cues\.setGate\(\(\) => pttHeld \|\| captureOn\(\) \|\| speakingNow\);/);
  assert.match(js, /if \(pttHeld && cues\.quiet\) cues\.quiet\(\);/);
  assert.match(js, /const finished = !!\(p && \(p\.summary \|\| p\.offerKeep\)\);\n\s+if \(finished\) \{ cues\.play\('done'\);/, '"done" only for a finished walkthrough');
});

test('surfaces: projected ones use the spec timings and can be interrupted; assignment mode is plain', () => {
  assert.match(surfaceSrc, /const PROJECTED = new Set\(\['guide-bubble', 'quick-ask', 'knot-hint', 'keep-chip'\]\);/);
  assert.match(surfaceSrc, /duration: T\.open \* 1000, easing: bez\(T\.openBezier\)/);
  assert.match(surfaceSrc, /duration: T\.close \* 1000, delay: textOut, easing: bez\(T\.closeBezier\)/);
  assert.match(surfaceSrc, /const from = proj && leaving \? current\(el\) : null;/, 'a re-show mid-close starts from where it is');
  assert.match(surfaceSrc, /const from = current\(el\);\n\s+clearAnims\(el\);/, 'a close mid-open starts from where it is');
  assert.match(surfaceSrc, /if \(opts\.plain \|\| reduced\(\)\) \{ clearAnims\(el\); return; \}/, 'reduced motion and assignment mode: no animation');
  assert.match(surfaceSrc, /el\.style\.cssText = '';/, 'inline placement and origin never survive a hide');
});
