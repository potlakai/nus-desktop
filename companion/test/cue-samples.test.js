// The six cue sounds (renders-0115-2026-11-02, O5 family A): rendered from the
// spec's numbers, at the measured pitches and levels, finite; played through
// cues.js under its rules, with the press pop as the one allowed exception
// while the mic is live.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const dir = path.join(__dirname, '..', 'renderer');
const spec = require(path.join(dir, 'knot-spec.js'));
const sampler = require(path.join(dir, 'cue-samples.js'));
const CUES = spec.character.cues;

// Power at one frequency (Goertzel), for a crude "which pitch leads" check.
function power(y, rate, hz) {
  const w = 2 * Math.PI * hz / rate, c = 2 * Math.cos(w);
  let s0 = 0, s1 = 0, s2 = 0;
  for (let i = 0; i < y.length; i++) { s0 = y[i] + c * s1 - s2; s2 = s1; s1 = s0; }
  return s1 * s1 + s2 * s2 - c * s1 * s2;
}
const CANDIDATES = [165, 220, 293.66, 330, 440, 587.33, 880, 987.77];
function leadingPitch(y, rate) {
  let best = 0, at = 0;
  for (const hz of CANDIDATES) { const p = power(y, rate, hz); if (p > best) { best = p; at = hz; } }
  return at;
}

test('six cues, each at its measured pitch and peak, each finite and short', () => {
  const names = sampler.names(CUES);
  assert.deepEqual(names, ['press', 'release', 'tick', 'done-notes', 'hands-start', 'hands-stop']);
  const want = { press: [220, .12], release: [440, .085], tick: [987.77, .045], 'done-notes': [587.33, .79], 'hands-start': [440, .52], 'hands-stop': [293.66, .39] };
  for (const name of names) {
    const y = sampler.render(CUES, name, CUES.rate);
    let peak = 0;
    for (const v of y) { assert.ok(Number.isFinite(v), name + ' is finite'); peak = Math.max(peak, Math.abs(v)); }
    assert.ok(Math.abs(20 * Math.log10(peak) - CUES[name].peakDb) < .01, name + ' peaks at ' + CUES[name].peakDb + ' dB');
    assert.equal(leadingPitch(y, CUES.rate), want[name][0], name + ' leads at ' + want[name][0] + ' Hz');
    assert.ok(y.length / CUES.rate <= want[name][1] + .05 && y.length / CUES.rate >= want[name][1] - .05, name + ' is about ' + want[name][1] + ' s');
    assert.ok(Math.abs(y[y.length - 1]) < .01, name + ' ends in silence');
  }
  assert.equal(leadingPitch(sampler.render(CUES, 'release'), CUES.rate) / leadingPitch(sampler.render(CUES, 'press'), CUES.rate), 2, 'the release pop is an octave above the press pop');
});

test('the same numbers render the same samples at any rate, deterministically', () => {
  const a = sampler.render(CUES, 'press', 48000), b = sampler.render(CUES, 'press', 48000), c = sampler.render(CUES, 'press', 16000);
  assert.deepEqual(Array.from(a), Array.from(b));
  assert.equal(c.length, Math.round(.12 * 16000));
  assert.equal(leadingPitch(c, 16000), 220);
});

// cues.js in a vm against a fake audio context that also has buffers.
function fixture() {
  let now = 0; const sources = [], gains = [];
  const param = (v) => ({ value: v, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {}, setTargetAtTime(x) { this.value = x; }, cancelScheduledValues() {} });
  const node = () => ({ connect() {}, disconnect() {} });
  class AudioContext {
    constructor() { this.state = 'running'; this.destination = node(); }
    get currentTime() { return now; }
    resume() {}
    createGain() { const g = Object.assign(node(), { gain: param(1) }); gains.push(g); return g; }
    createBiquadFilter() { return Object.assign(node(), { type: '', frequency: param(0) }); }
    createOscillator() { return Object.assign(node(), { type: '', frequency: param(0), start() {}, stop() {}, onended: null }); }
    createBuffer(ch, n, rate) { return { length: n, rate, data: new Float32Array(n), copyToChannel(d) { this.data.set(d); } }; }
    createBufferSource() { const s = Object.assign(node(), { buffer: null, startAt: null, onended: null, start(t) { this.startAt = t; } }); sources.push(s); return s; }
  }
  const window = { AudioContext };
  const ctx = { window, Math, Object, Number, Float32Array, Error };
  for (const f of ['knot-spec.js', 'cue-samples.js', 'cues.js']) vm.runInNewContext(fs.readFileSync(path.join(dir, f), 'utf8'), ctx);
  return { cues: window.NusCues, sources, gains, advance(s) { now += s; } };
}

test('cues.js plays the six as buffers through their own gain, never over the mic, except the forced press pop', () => {
  const f = fixture();
  assert.deepEqual(f.cues.samples, ['press', 'release', 'tick', 'done-notes', 'hands-start', 'hands-stop']);
  for (const s of f.cues.samples) assert.ok(!f.cues.names.includes(s), s + ' is not a motif');
  let live = false;
  f.cues.setGate(() => live);
  assert.equal(f.cues.play('press'), true);
  assert.equal(f.sources.length, 1);
  assert.equal(f.sources[0].buffer.length, Math.round(.12 * CUES.rate), 'the press buffer is the rendered sample');
  assert.equal(f.gains[1].gain.value, CUES.level, 'samples have their own gain, at the spec level');
  live = true;
  assert.equal(f.cues.play('press'), false, 'refused while the mic is live');
  assert.equal(f.cues.play('press', { force: true }), true, 'unless forced: the one exception');
  assert.equal(f.cues.play('release', { force: true }), false, 'force means nothing for any other cue');
  assert.equal(f.cues.play('tick', { force: true }), false);
  assert.equal(f.cues.play('ack', { force: true }), false);
  live = false;
  assert.equal(f.cues.play('release'), true);
  assert.equal(f.cues.play('hands-start'), true);
  f.cues.quiet();
  assert.equal(f.gains[0].gain.value, 0, 'quiet silences the motifs');
  assert.equal(f.gains[1].gain.value, CUES.level, 'and leaves the samples alone, so the press pop can mark the moment');
  f.cues.setEnabled(false);
  assert.equal(f.cues.play('press', { force: true }), false, 'sounds off means off, even forced');
  assert.equal(f.gains[1].gain.value, 0);
  f.cues.setEnabled(true);
  assert.equal(f.gains[1].gain.value, CUES.level);
});

test('the renderer puts each cue at its moment', () => {
  const r = fs.readFileSync(path.join(dir, 'renderer.js'), 'utf8');
  assert.match(r, /if \(pttHeld\) cues\.play\('press', \{ force: true \}\);/, 'press as the mic opens, after quiet()');
  assert.ok(r.indexOf("cues.quiet();\n    if (pttHeld) cues.play('press'") > 0, 'quiet first, then the pop');
  assert.match(r, /ack\(\{ silent: true \}\);\s*cues\.play\('release'\);/, 'release at key up, the ack motif silent there');
  assert.match(r, /if \(handsState\.active && !was\) \{ handsSince = Date\.now\(\); cues\.play\('hands-start'\); \}/);
  assert.match(r, /cues\.play\('hands-stop'\);\s*if \(Date\.now\(\) - handsSince > KSPEC\.character\.cues\.longRunMs\) setTimeout\(\(\) => cues\.play\('done-notes'\), 450\);/);
  assert.equal(CUES.longRunMs, 20000);
  assert.match(fs.readFileSync(path.join(dir, 'index.html'), 'utf8'), /cue-samples\.js[^\n]*\n\s*<script src="cues\.js/, 'the sampler loads before cues.js');
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'cues.js'), 'utf8'), /\.loop\s*=|setInterval\(|new Audio\(|fetch\(/, 'still no file, no loop');
});
