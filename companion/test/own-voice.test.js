'use strict';
// The Knot's own voice manager with a fake worker: status, warm, ordered
// synthesis, stop, and the settings switch. The real engine is benched by hand.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createVoice, VOICES, MODELS, IDLE_UNLOAD_MS } = require('../src/voice');

function fakeWorker() {
  const w = new EventEmitter();
  w.sent = []; w.killed = false;
  w.send = (m) => { w.sent.push(m); if (m.type === 'load') setImmediate(() => w.emit('message', { type: 'ready', sampleRate: 24000, speakers: 54, model: 'model.onnx', ms: 5 })); if (m.type === 'say') setImmediate(() => { if (!w.stopped) w.emit('message', { type: 'audio', id: m.id, sampleRate: 24000, pcm: Buffer.from([1, 0, 2, 0]), ms: 7, secs: 0.1 }); }); if (m.type === 'stop') w.stopped = true; };
  w.kill = () => { w.killed = true; w.emit('exit', 0); };
  setImmediate(() => w.emit('message', { type: 'hello' }));
  return w;
}

function rig({ voice = 'fable', installed = true } = {}) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nus-voice-'));
  if (installed) {
    const dir = path.join(userData, 'voice', MODELS[VOICES.fable.model].folder);
    fs.mkdirSync(dir, { recursive: true });
    for (const f of ['voices.bin', 'model.onnx', 'tokens.txt']) fs.writeFileSync(path.join(dir, f), 'x');
  }
  const spawned = [];
  const states = [];
  const settings = { voice };
  const v = createVoice({ userData, settings: { get: () => settings }, spawnFn: () => { const w = fakeWorker(); spawned.push(w); return w; }, executable: 'electron', log: () => {}, onState: (s) => states.push(s), bundled: [] });
  return { v, spawned, states, settings };
}

test('status says which voice, whether it is installed and loaded; the system voice never starts a worker', async () => {
  const sys = rig({ voice: 'system' });
  assert.equal(sys.v.status().voice, 'system'); assert.equal(sys.v.status().ready, false);
  await assert.rejects(sys.v.synth('hi'), /system voice/);
  assert.equal(sys.spawned.length, 0);
  const off = rig({ installed: false });
  assert.equal(off.v.status().installed, false);
  await assert.rejects(off.v.synth('hi'), /not installed/);
});

test('warm loads the model once; lines come back in order with samples; stop drops the rest', async () => {
  const r = rig();
  await r.v.warm();
  assert.equal(r.spawned.length, 1);
  assert.equal(r.v.status().ready, true);
  assert.ok(r.states.some((s) => s.ready), 'the renderer is told when it is ready');
  const a = await r.v.synth('Click the Insert tab.');
  assert.equal(a.sampleRate, 24000); assert.equal(a.pcm.length, 4); assert.equal(a.secs, 0.1);
  const [b, c] = await Promise.all([r.v.synth('one'), r.v.synth('two')]);
  assert.ok(b && c);
  assert.equal(r.spawned.length, 1, 'the same worker serves every line');
  assert.equal(r.spawned[0].sent.filter((m) => m.type === 'say').length, 3);
  assert.equal(r.spawned[0].sent.find((m) => m.type === 'load').speaker, 25, 'Fable is speaker 25');
  r.spawned[0].stopped = true;
  const late = r.v.synth('three');
  r.v.stop();
  await assert.rejects(late, /stopped/);
  r.v.close();
  assert.equal(r.spawned[0].killed, true);
  assert.equal(r.v.status().ready, false);
});

test('a worker that dies fails what was pending and is started again on the next line', async () => {
  const r = rig();
  await r.v.warm();
  r.spawned[0].kill();
  assert.equal(r.v.status().ready, false);
  const a = await r.v.synth('again');
  assert.ok(a.pcm.length);
  assert.equal(r.spawned.length, 2);
});

test('install is skipped when the files are already there, and the model table is pinned', async () => {
  const r = rig();
  const s = await r.v.install('fable');
  assert.equal(s.installed, true);
  assert.match(MODELS['kokoro-v1_0'].sha256, /^[0-9a-f]{64}$/);
  assert.match(MODELS['kokoro-v1_0'].url, /^https:\/\/github\.com\/k2-fsa\/sherpa-onnx\/releases\/download\//);
  await assert.rejects(r.v.install('nope'), /unknown voice/);
});

test('the voice stays loaded through a 30 minute break, not five', () => {
  assert.equal(IDLE_UNLOAD_MS, 30 * 60 * 1000);
});

// Unpacking the voice (2026-11-11): a plain "tar" on a PC with Git or MSYS first on the PATH is
// GNU tar, which reads "C:" as another computer and fails, so the voice never installed there.
// The live check is scripts/lag/unpack-check.cjs.
test('the voice is unpacked with Windows\' own tar first, and the PATH\'s tar only as a fallback', async () => {
  const { extract, tarAttempts } = require('../src/voice');
  const own = path.join('C:\Windows', 'System32', 'tar.exe');
  const win = tarAttempts({ platform: 'win32', env: { SystemRoot: 'C:\Windows' }, exists: (p) => p === own });
  assert.deepEqual(win, [{ file: own, extra: [] }, { file: 'tar', extra: [] }, { file: 'tar', extra: ['--force-local'] }]);
  assert.deepEqual(tarAttempts({ platform: 'win32', env: {}, exists: () => false }), [{ file: 'tar', extra: [] }, { file: 'tar', extra: ['--force-local'] }], 'no tar in System32: the PATH, then told C: is local');
  assert.deepEqual(tarAttempts({ platform: 'darwin', env: {}, exists: () => true }), [{ file: 'tar', extra: [] }]);
  // It stops at the first that works, and says why when none does.
  const into = fs.mkdtempSync(path.join(os.tmpdir(), 'nus-unpack-'));
  const calls = [];
  const gnuFirst = (file, args, _o, cb) => { calls.push([file, args[0]]); cb(args[0] === '--force-local' ? null : new Error('x'), '', args[0] === '--force-local' ? '' : 'tar (child): Cannot connect to C: resolve failed'); };
  await extract('C:\v\voice.tar.bz2', into, { run: gnuFirst, attempts: tarAttempts({ platform: 'win32', env: {}, exists: () => false }) });
  assert.deepEqual(calls, [['tar', '-xjf'], ['tar', '--force-local']]);
  calls.length = 0;
  await extract('C:\v\voice.tar.bz2', into, { run: (file, args, _o, cb) => { calls.push(file); cb(null, '', ''); }, attempts: win });
  assert.deepEqual(calls, [own], 'the first one worked: nothing else is tried');
  await assert.rejects(() => extract('C:\v\voice.tar.bz2', into, { run: (_f, _a, _o, cb) => cb(new Error('x'), '', 'no such archive'), attempts: win }), /extract failed: no such archive/);
});
