'use strict';
// The Parakeet manager with a fake worker: the pin, the install, off means no
// worker, loading, idle unload. The real engine is run by scripts/bench/parakeet-clips.cjs.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createParakeet, PARAKEET_MODEL, PARAKEET_IDLE_UNLOAD_MS, MAX_LOAD_FAILURES } = require('../src/voice/parakeet');
const { pcm16ToFloat32 } = require('../src/wav');

const root = path.resolve(__dirname, '../..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn) => { for (let i = 0; i < 200 && !fn(); i++) await wait(5); assert.ok(fn(), 'never happened'); };

// The real names, tiny sizes: the suite does not write 650 MB.
const SMALL = { ...PARAKEET_MODEL, files: { 'encoder.int8.onnx': 3, 'decoder.int8.onnx': 3, 'joiner.int8.onnx': 3, 'tokens.txt': 3 } };

function fakeWorker({ answer = (m) => setImmediate(() => m.w.emit('message', { type: 'text', id: m.id, text: 'Open Notepad.', ms: 300, secs: 1 })), loadOk = true } = {}) {
  const w = new EventEmitter();
  w.sent = []; w.killed = false;
  w.send = (m) => {
    w.sent.push(m);
    if (m.type === 'load') setImmediate(() => { if (loadOk) w.emit('message', { type: 'ready', ms: 5 }); else w.emit('exit', 1); });
    if (m.type === 'decode') answer({ ...m, w });
  };
  w.kill = () => { w.killed = true; setImmediate(() => w.emit('exit', 0)); };
  setImmediate(() => w.emit('message', { type: 'hello' }));
  return w;
}

function writeModel(dir, model = SMALL, short = null) {
  const d = path.join(dir, 'speech', model.folder);
  fs.mkdirSync(d, { recursive: true });
  for (const [f, size] of Object.entries(model.files)) if (f !== short) fs.writeFileSync(path.join(d, f), 'x'.repeat(size));
}

function rig({ speechModel = 'parakeet', installed = true, worker, idleMs, hungMs, fetchFn, hashFn, unpackFn, spawnThrows = false } = {}) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nus-parakeet-'));
  if (installed) writeModel(userData);
  const spawned = [], states = [], settings = { speechModel };
  const p = createParakeet({
    userData, model: SMALL, settings: { get: () => settings }, executable: 'electron', log: () => {}, onState: (s) => states.push(s), idleMs, hungMs, fetchFn, hashFn, unpackFn,
    spawnFn: (exe, args, opts) => { if (spawnThrows) throw new Error('no'); const w = fakeWorker(worker); w.exe = exe; w.args = args; w.opts = opts; spawned.push(w); return w; },
  });
  return { p, spawned, states, settings, userData };
}

test('the pin is the one Pranav approved, and the model is not fetched from anywhere else', () => {
  assert.equal(PARAKEET_MODEL.url, 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2');
  // The 2026-11-07 re-upload, re-pinned 2026-11-20 (see parakeet.js).
  assert.equal(PARAKEET_MODEL.bytes, 487211443);
  assert.equal(PARAKEET_MODEL.sha256, '1495e91b59d7fc53ddca91f3431758ec99f8fa253fdb0e1e851be0f72b14b0f9');
  assert.equal(PARAKEET_MODEL.folder, 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8');
  assert.deepEqual(Object.keys(PARAKEET_MODEL.files).sort(), ['decoder.int8.onnx', 'encoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt']);
});

test('the idle unload is five minutes', () => {
  assert.equal(PARAKEET_IDLE_UNLOAD_MS, 5 * 60 * 1000);
});

test('unset means Parakeet now; only "whisper" or NUS_PARAKEET=0 keeps Whisper, and none of them download on a press', async () => {
  let fetched = 0;
  const fetchFn = async () => { fetched++; };
  // Unset and installed: Parakeet loads (the default from 0.1.31).
  const unset = rig({ speechModel: null, fetchFn });
  assert.equal(await unset.p.warm(), true);
  assert.equal(unset.p.ready(), true);
  unset.p.close();
  // Off, not installed, or the env switch: no worker.
  const old = process.env.NUS_PARAKEET;
  try {
    for (const r of [rig({ speechModel: 'whisper', fetchFn }), rig({ installed: false, fetchFn }), (() => { process.env.NUS_PARAKEET = '0'; return rig({ speechModel: null, fetchFn }); })()]) {
      assert.equal(await r.p.warm(), false);
      assert.equal(r.p.ready(), false);
      await assert.rejects(r.p.transcribe(Buffer.alloc(4)), /not loaded/);
      assert.equal(r.spawned.length, 0, 'no worker');
      r.p.settingChanged();
      assert.equal(r.spawned.length, 0, 'the switch alone starts nothing');
    }
  } finally { if (old === undefined) delete process.env.NUS_PARAKEET; else process.env.NUS_PARAKEET = old; }
  assert.equal(fetched, 0, 'a press never downloads');
});

test('autoInstall: fetches once in the background when chosen and missing; never when off, present, or already fetching; never throws', async () => {
  const okHash = async () => PARAKEET_MODEL.sha256;
  let fetched = 0;
  const r2 = rig({ speechModel: null, installed: false, fetchFn: async (url, file) => { fetched++; fs.writeFileSync(file, 'archive'); }, hashFn: okHash, unpackFn: async () => writeModel(r2.userData) });
  await Promise.all([r2.p.autoInstall(), r2.p.autoInstall()]);
  assert.equal(fetched, 1, 'two calls, one download');
  assert.equal((await r2.p.autoInstall()).installed, true);
  assert.equal(fetched, 1, 'present: nothing more');
  const off = rig({ speechModel: 'whisper', installed: false, fetchFn: async () => { fetched++; } });
  await off.p.autoInstall();
  assert.equal(fetched, 1, 'off: no download');
  const broken = rig({ speechModel: null, installed: false, fetchFn: async () => { throw new Error('offline'); } });
  const st = await broken.p.autoInstall();
  assert.equal(st.installed, false, 'a failed download is a status, not a throw');
  const main = read('companion/index.js');
  assert.match(main, /setTimeout\(\(\) => \{ getParakeet\(\)\.autoInstall\(\)\.catch\(\(\) => \{\}\); \}, PARAKEET_AUTO_INSTALL_MS\)/);
  assert.match(main, /const PARAKEET_AUTO_INSTALL_MS = 45000;/);
});

test('a short file left by a cut-off install does not count as installed', () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nus-parakeet-'));
  writeModel(userData, SMALL, 'encoder.int8.onnx');
  fs.writeFileSync(path.join(userData, 'speech', SMALL.folder, 'encoder.int8.onnx'), 'x');
  const p = createParakeet({ userData, model: SMALL, settings: { get: () => ({ speechModel: 'parakeet' }) } });
  assert.equal(p.status().installed, false);
});

test('install: a bad hash deletes the archive, says so, and leaves nothing installed', async () => {
  const r = rig({ installed: false, fetchFn: async (url, file) => { fs.writeFileSync(file, 'not the model'); }, unpackFn: async () => assert.fail('must not unpack') });
  await assert.rejects(r.p.install(), /did not match its expected hash/);
  const archive = path.join(r.userData, 'speech', path.basename(SMALL.url));
  assert.equal(fs.existsSync(archive), false, 'the bad archive is gone');
  const st = r.p.status();
  assert.equal(st.installed, false); assert.equal(st.downloading, null);
  assert.ok(r.states.some((s) => s.downloading), 'progress was announced');
  assert.equal(r.spawned.length, 0);
});

test('install: a good hash unpacks, deletes the archive, and is skipped the second time', async () => {
  let fetched = 0;
  const r = rig({
    installed: false,
    fetchFn: async (url, file, onProgress) => { fetched++; assert.equal(url, SMALL.url); onProgress(5, 10); fs.writeFileSync(file, 'archive'); },
    hashFn: async () => SMALL.sha256,
    unpackFn: async (archive, into) => { assert.equal(into, path.join(r.userData, 'speech')); writeModel(r.userData); },
  });
  const st = await r.p.install();
  assert.equal(st.installed, true);
  assert.equal(fs.existsSync(path.join(r.userData, 'speech', path.basename(SMALL.url))), false, 'the archive is deleted after extract');
  await r.p.install();
  assert.equal(fetched, 1);
  assert.equal(r.spawned.length, 0, 'installing loads nothing');
});

test('install: files missing after extract is an error, not an installed model', async () => {
  const r = rig({ installed: false, fetchFn: async (url, file) => fs.writeFileSync(file, 'a'), hashFn: async () => SMALL.sha256, unpackFn: async () => {} });
  await assert.rejects(r.p.install(), /incomplete/);
  assert.equal(r.p.status().installed, false);
});

test('warm spawns one worker the same way as the voice, and every press after reuses it', async () => {
  const r = rig();
  assert.equal(await r.p.warm(), true);
  await r.p.warm(); await r.p.warm();
  assert.equal(r.spawned.length, 1);
  const w = r.spawned[0];
  assert.equal(w.exe, 'electron');
  assert.equal(path.basename(w.args[0]), 'parakeet-worker.js');
  assert.equal(w.opts.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(w.opts.serialization, 'advanced');
  assert.equal(w.opts.windowsHide, true);
  const load = w.sent.find((m) => m.type === 'load');
  assert.equal(load.threads, 4);
  assert.equal(load.dir, path.join(r.userData, 'speech', SMALL.folder));
  assert.equal(r.p.ready(), true);
  assert.ok(r.states.some((s) => s.loading), 'loading is announced');
  assert.ok(r.states.some((s) => s.ready), 'ready is announced');
  r.p.close();
});

test('not ready until the worker says so; the words come back from the worker', async () => {
  const r = rig();
  const loading = r.p.warm();
  assert.equal(r.p.ready(), false);
  await assert.rejects(r.p.transcribe(Buffer.alloc(4)), /not loaded/);
  await loading;
  const pcm = Buffer.from([1, 0, 2, 0]);
  assert.equal(await r.p.transcribe(pcm), 'Open Notepad.');
  assert.deepEqual(r.spawned[0].sent.find((m) => m.type === 'decode').pcm, pcm);
  r.p.close();
});

test('a decode still running refuses the next one at once instead of queuing it', async () => {
  let hold;
  const r = rig({ worker: { answer: (m) => { hold = () => m.w.emit('message', { type: 'text', id: m.id, text: 'late', ms: 9000, secs: 1 }); } } });
  await r.p.warm();
  const first = r.p.transcribe(Buffer.alloc(4));
  await assert.rejects(r.p.transcribe(Buffer.alloc(4)), /still on the last one/);
  assert.equal(r.spawned[0].sent.filter((m) => m.type === 'decode').length, 1);
  hold();
  assert.equal(await first, 'late');
  r.p.close();
});

test('idle: the worker is gone after the quiet period, and a decode pushes it back', async () => {
  const r = rig({ idleMs: 60 });
  await r.p.warm();
  const w = r.spawned[0];
  await wait(30);
  await r.p.transcribe(Buffer.alloc(4));
  await wait(40);
  assert.equal(w.killed, false, 'the decode restarted the clock');
  await until(() => w.killed);
  assert.equal(r.p.ready(), false);
  assert.equal(r.p.status().ready, false);
  await r.p.warm();
  assert.equal(r.spawned.length, 2, 'the next press loads it again');
  r.p.close();
});

test('idle: never unloads under a running decode', async () => {
  let hold;
  const r = rig({ idleMs: 20, worker: { answer: (m) => { hold = () => m.w.emit('message', { type: 'text', id: m.id, text: 'done', ms: 1, secs: 1 }); } } });
  await r.p.warm();
  const pending = r.p.transcribe(Buffer.alloc(4));
  await wait(60);
  assert.equal(r.spawned[0].killed, false);
  hold();
  assert.equal(await pending, 'done');
  r.p.close();
});

test('a stuck decode gets the worker killed, and the next press starts a fresh one', async () => {
  const r = rig({ hungMs: 20, worker: { answer: () => {} } });
  await r.p.warm();
  await assert.rejects(r.p.transcribe(Buffer.alloc(4)), /unloaded/);
  assert.equal(r.spawned[0].killed, true);
  assert.equal(r.p.ready(), false);
  await r.p.warm();
  assert.equal(r.spawned.length, 2);
  r.p.close();
});

test('a worker that dies mid-decode rejects it and comes back on the next press', async () => {
  const r = rig({ worker: { answer: (m) => setImmediate(() => m.w.emit('exit', 1)) } });
  await r.p.warm();
  await assert.rejects(r.p.transcribe(Buffer.alloc(4)), /worker exited/);
  assert.equal(r.p.ready(), false);
  assert.equal(await r.p.warm(), true);
  assert.equal(r.spawned.length, 2);
  r.p.close();
});

test('a model that will not load stops being tried until the switch moves', async () => {
  const r = rig({ worker: { loadOk: false } });
  for (let i = 0; i < MAX_LOAD_FAILURES + 2; i++) assert.equal(await r.p.warm(), false);
  assert.equal(r.spawned.length, MAX_LOAD_FAILURES);
  assert.equal(r.p.status().failed, true);
  r.p.settingChanged();
  assert.equal(r.p.status().failed, false);
  await r.p.warm();
  assert.equal(r.spawned.length, MAX_LOAD_FAILURES + 1);
});

test('a worker that cannot start at all is a failed load, not a thrown press', async () => {
  const r = rig({ spawnThrows: true });
  assert.equal(await r.p.warm(), false);
  assert.equal(r.p.ready(), false);
});

test('switching off lets the memory go at once; switching on loads nothing until the talk key', async () => {
  const r = rig();
  await r.p.warm();
  const w = r.spawned[0];
  r.settings.speechModel = 'whisper';
  assert.equal(r.p.ready(), false, 'off is off the moment the setting says so');
  r.p.settingChanged();
  assert.equal(w.killed, true);
  r.settings.speechModel = 'parakeet';
  r.p.settingChanged();
  assert.equal(r.spawned.length, 1);
});

test('a close while the model loads still settles the press that started it', async () => {
  const r = rig();
  const loading = r.p.warm();
  r.p.close();
  assert.equal(await loading, false);
});

test('Int16 bytes become -1..1 floats from any offset, as they arrive over IPC', () => {
  const bytes = new Uint8Array(7);
  Buffer.from(bytes.buffer).writeInt16LE(-32768, 1);
  Buffer.from(bytes.buffer).writeInt16LE(16384, 3);
  Buffer.from(bytes.buffer).writeInt16LE(0, 5);
  assert.deepEqual([...pcm16ToFloat32(bytes.subarray(1))], [-1, 0.5, 0]);
  assert.deepEqual([...pcm16ToFloat32(Buffer.from([0, 64]))], [0.5]);
});

test('the worker ships outside the asar like the voice engine, and the release check knows the pin', () => {
  const c = require('../../electron-builder.companion.config');
  assert.ok(c.asarUnpack.includes('companion/src/voice/parakeet-worker.js'));
  assert.ok(c.asarUnpack.includes('companion/src/voice/engine-worker.js'));
  assert.ok(c.files.includes('companion/**/*'));
  const release = read('docs/release.md');
  assert.ok(release.includes(path.basename(PARAKEET_MODEL.url)));
  assert.ok(release.includes(String(PARAKEET_MODEL.bytes)) || /`bytes`/.test(release));
  assert.match(read('THIRD-PARTY.md'), /parakeet-tdt-0\.6b-v3/);
  assert.match(read('THIRD-PARTY.md'), /CC-BY-4\.0/);
});

test('the setting, the Settings row and the talk key are wired through', () => {
  const main = read('src/main-companion.js');
  assert.match(main, /patch\.speechModel === 'whisper' \|\| patch\.speechModel === 'parakeet'/);
  assert.match(main, /handle\('home:speech:status'/);
  assert.match(main, /handle\('home:speech:install'/);
  assert.match(main, /onSpeechState: s => send\('home:speech', s\)/);
  const preload = read('companion/home/preload.js');
  assert.match(preload, /speechInstall/);
  assert.match(preload, /'home:speech'/);
  const html = read('companion/home/index.html');
  assert.match(html, /id="speech-model"/);
  assert.match(html, /about 465 MB/);
  assert.equal(Math.round(PARAKEET_MODEL.bytes / 1048576), 465);
  assert.match(html, /about 800 MB of memory/);
  assert.match(html, /5 quiet minutes/);
  const companion = read('companion/index.js');
  const press = companion.indexOf("require('../src/stt-local').warm()");
  assert.ok(press > 0 && companion.indexOf('getParakeet().warm()', press) - press < 200, 'warmed on the talk key, beside whisper');
  assert.match(companion, /finalEngine: getParakeet\(\)/);
  assert.match(companion, /'speechModel'\)\) \{ try \{ getParakeet\(\)\.settingChanged\(\)/);
});

test('autoInstall: a file that fails its hash is not fetched again by itself for the same pin; the switch still can, and a new pin clears it', async () => {
  let fetched = 0;
  const badHash = async () => 'f'.repeat(64);
  const r = rig({ speechModel: null, installed: false, fetchFn: async (url, file) => { fetched++; fs.writeFileSync(file, 'archive'); }, hashFn: badHash });
  await r.p.autoInstall();
  assert.equal(fetched, 1);
  await r.p.autoInstall();
  assert.equal(fetched, 1, 'the next start does not pull it again');
  await assert.rejects(r.p.install(), /expected hash/);
  assert.equal(fetched, 2, 'the Settings switch still tries');
  // A dropped connection is not a hash failure: the next start tries again.
  let tries = 0;
  const off = rig({ speechModel: null, installed: false, fetchFn: async () => { tries++; throw new Error('offline'); } });
  await off.p.autoInstall(); await off.p.autoInstall();
  assert.equal(tries, 2);
  // A different pin (a new version) is not held back by the old note.
  const note = path.join(r.userData, 'speech', 'auto-install-hash-failed.json');
  fs.writeFileSync(note, JSON.stringify({ sha256: 'old' }));
  await r.p.autoInstall();
  assert.equal(fetched, 3);
});
