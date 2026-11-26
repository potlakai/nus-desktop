'use strict';
// The Knot's own voice: Kokoro "Fable" (British, soft) run locally through
// sherpa-onnx in a child process. Opt in: the model is a one-time download
// (pinned file, checked by hash, resumable by re-running), kept under userData,
// and until it is there, or if it is switched off, the system voice speaks.
//
// Lines are synthesized one at a time in order; the renderer plays line N
// while line N+1 is being made, so a streamed reply sounds continuous. stop()
// drops everything queued and whatever the worker is in the middle of.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { spawn, execFile } = require('child_process');

// The sherpa-onnx packaging of hexgrad's Kokoro-82M v1.0 (Apache-2.0 weights).
// `fable` is speaker 25 (bm_fable) in its voice table.
const MODELS = {
  // Measured 2026-10-10 on the Ryzen 7 4700U: full precision at 4 threads makes a
  // 3 s line in 1.4 s (0.47x real time), "Done." in 0.6 s; the int8 file is
  // 3x slower than real time on this CPU, so it is not offered.
  'kokoro-v1_0': { url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_0.tar.bz2', sha256: '60703707bc05ccd48d60e1eb723f38b07d6e474795a0b6a588d7220400e0f7a4', folder: 'kokoro-multi-lang-v1_0', bytes: 349886476 },
  // The archive was re-uploaded upstream on 2026-10-26 (same maintainer, same
  // files byte for byte, verified 2026-11-03 against an installed copy); the pin
  // follows it. Check the pin against the release asset before every release:
  //   gh api repos/k2-fsa/sherpa-onnx/releases/tags/tts-models --jq '.assets[]|select(.name=="kokoro-multi-lang-v1_0.tar.bz2")|.size'
  // The int8 archive was re-uploaded the same minute (132,353,410 bytes); it is
  // not offered and its new hash is unverified.
  'kokoro-int8-v1_0': { url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-int8-multi-lang-v1_0.tar.bz2', sha256: '4c3052abaa60943a341f193888cf6abd68787dae6ab8ae5c925a706caa247e4e', folder: 'kokoro-int8-multi-lang-v1_0', bytes: 132303094 },
};
const VOICES = { fable: { model: 'kokoro-v1_0', speaker: 25, label: 'Fable', speed: 1.0 } };
const DEFAULT_VOICE = 'fable';
// The worker goes away after 30 quiet minutes (the model is ~300 MB in
// memory). At five, the first line after a short break paid the reload.
const IDLE_UNLOAD_MS = 30 * 60 * 1000;

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

function download(url, file, onProgress, redirects = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'nus-companion' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 5) { res.resume(); download(res.headers.location, file, onProgress, redirects + 1).then(resolve, reject); return; }
      if (res.statusCode !== 200) { res.resume(); reject(new Error('download failed: HTTP ' + res.statusCode)); return; }
      const total = Number(res.headers['content-length']) || 0;
      let got = 0;
      const out = fs.createWriteStream(file + '.part');
      res.on('data', (chunk) => { got += chunk.length; if (onProgress) onProgress(got, total); });
      res.pipe(out);
      out.on('finish', () => { fs.rename(file + '.part', file, (e) => (e ? reject(e) : resolve(file))); });
      out.on('error', reject);
      res.on('error', reject);
    });
    req.on('error', reject);
  });
}

// Unpacking the voice. Windows ships its own tar (System32, libarchive), which reads .tar.bz2
// and takes C:\ paths. A plain "tar" is whichever comes first on the PATH, and on a PC with Git
// or MSYS ahead of System32 that is GNU tar, which reads "C:" as the name of another computer:
// "Cannot connect to C: resolve failed", and the voice never installs (found 2026-11-11 on a
// first-run walk started from a Git shell; one user reported "voice would not download" with
// no cause found). So Windows' own tar is called by its full path; the PATH's tar is the
// fallback, first as it is, then told that C: is local.
function tarAttempts({ platform = process.platform, env = process.env, exists = fs.existsSync } = {}) {
  const tries = [];
  if (platform === 'win32') {
    const own = path.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', 'tar.exe');
    if (exists(own)) tries.push({ file: own, extra: [] });
  }
  tries.push({ file: 'tar', extra: [] });
  if (platform === 'win32') tries.push({ file: 'tar', extra: ['--force-local'] });
  return tries;
}
function extract(archive, into, { run = execFile, attempts = tarAttempts() } = {}) {
  fs.mkdirSync(into, { recursive: true });
  const one = (t) => new Promise((resolve, reject) => {
    run(t.file, [...t.extra, '-xjf', archive, '-C', into], { windowsHide: true, timeout: 600000 }, (e, _out, err) => (e ? reject(new Error('extract failed: ' + String(err || e.message).slice(0, 200))) : resolve()));
  });
  return attempts.reduce((before, t) => before.catch(() => one(t)), Promise.reject(new Error('extract failed: no tar')));
}

// electron: process.execPath runs the worker with ELECTRON_RUN_AS_NODE (the
// native addon is N-API, so it loads in Electron's Node as it does in Node).
// Fable ships inside the installer (Pranav, 2026-11-11: "the first word it says should already have
// the fable voice ... it doesn't need the step of downloading the voice anymore"): electron-builder
// copies vendor/voice/<folder> to resources/voice/<folder>. A dev run reads vendor/voice. The
// download in install() stays only as a repair path for an install whose bundled copy is missing.
function bundledRoots() {
  const out = [];
  if (process.resourcesPath) out.push(path.join(process.resourcesPath, 'voice'));
  out.push(path.join(__dirname, '..', '..', '..', 'vendor', 'voice'));
  return out;
}
function hasModel(d) { return fs.existsSync(path.join(d, 'voices.bin')) && (fs.existsSync(path.join(d, 'model.onnx')) || fs.existsSync(path.join(d, 'model.int8.onnx'))); }

function createVoice({ userData, settings, log = () => {}, spawnFn = spawn, executable = process.execPath, now = () => Date.now(), onState = () => {}, bundled = bundledRoots() }) {
  const root = path.join(userData, 'voice');
  let worker = null, ready = null, seq = 0, idleTimer = null, loading = null;
  const pending = new Map();      // id -> { resolve, reject, at }
  let downloading = null;         // { got, total, voice }

  // No choice made yet: Fable once its model is on this computer (Pranav,
  // 2026-11-03: the Windows voice is not the Knot's), the system voice before.
  function voiceName() { const s = settings.get(); if (s && s.voice) return String(s.voice); return installed(VOICES[DEFAULT_VOICE]) ? DEFAULT_VOICE : 'system'; }
  function wanted() { return VOICES[voiceName()] || null; }
  // The bundled copy when it is there, else a downloaded one in the profile.
  function modelDir(v) {
    const folder = MODELS[v.model].folder;
    for (const r of bundled || []) { const d = path.join(r, folder); if (hasModel(d)) return d; }
    return path.join(root, folder);
  }
  function installed(v) { return hasModel(modelDir(v)); }

  function status() {
    const v = wanted();
    return {
      voice: voiceName(), label: v ? v.label : 'System voice', available: Object.keys(VOICES),
      installed: v ? installed(v) : false, ready: Boolean(v && installed(v) && worker && ready && ready.ok),
      downloading: downloading ? { got: downloading.got, total: downloading.total } : null,
      modelBytes: v ? MODELS[v.model].bytes : 0,
    };
  }
  function announce() { try { onState(status()); } catch (_) { /* a listener, never a failure */ } }

  // The one-time download for the chosen voice. Resolves to status().
  async function install(name) {
    const v = VOICES[name || DEFAULT_VOICE];
    if (!v) throw new Error('unknown voice');
    if (installed(v)) return status();
    if (downloading) return status();
    const m = MODELS[v.model];
    fs.mkdirSync(root, { recursive: true });
    const archive = path.join(root, path.basename(m.url));
    downloading = { got: 0, total: m.bytes, voice: name };
    announce();
    try {
      if (!fs.existsSync(archive)) {
        let last = 0;
        await download(m.url, archive, (got, total) => { downloading.got = got; if (total) downloading.total = total; if (now() - last > 500) { last = now(); announce(); } });
      }
      if (m.sha256) {
        const sum = await sha256File(archive);
        if (sum !== m.sha256) { fs.unlinkSync(archive); throw new Error('the downloaded voice did not match its expected hash; try again'); }
      }
      await extract(archive, root);
      if (!installed(v)) throw new Error('the voice files are incomplete after extracting');
      try { fs.unlinkSync(archive); } catch (_) { /* keep going */ }
      log('voice installed: ' + v.label);
    } finally { downloading = null; announce(); }
    return status();
  }

  function ensureWorker() {
    const v = wanted();
    if (!v || !installed(v)) return null;
    if (worker) return loading || Promise.resolve(worker);
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
    const w = spawnFn(executable, [path.join(__dirname, 'engine-worker.js')], { env, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'advanced' });
    worker = w; ready = null;
    loading = new Promise((resolve, reject) => {
      const t0 = now();
      const fail = (e) => { if (worker === w) { worker = null; ready = null; loading = null; } for (const p of pending.values()) p.reject(e); pending.clear(); announce(); reject(e); };
      w.on('error', (e) => fail(e));
      w.on('exit', () => fail(new Error('voice worker exited')));
      w.on('message', (m) => {
        if (!m) return;
        if (m.type === 'hello') { w.send({ type: 'load', dir: modelDir(v), speaker: v.speaker, threads: 4 }); return; }
        if (m.type === 'ready') { ready = { ok: true, sampleRate: m.sampleRate, ms: m.ms }; loading = null; log('voice ready in ' + (now() - t0) + 'ms (' + m.model + ')'); announce(); resolve(w); return; }
        if (m.type === 'audio') { const p = pending.get(m.id); if (p) { pending.delete(m.id); p.resolve({ sampleRate: m.sampleRate, pcm: Buffer.from(m.pcm), ms: m.ms, secs: m.secs }); } touch(); return; }
        if (m.type === 'error') { const p = m.id != null ? pending.get(m.id) : null; if (p) { pending.delete(m.id); p.reject(new Error(m.message)); } else if (!ready) fail(new Error(m.message)); else log('voice: ' + m.message); }
      });
    });
    return loading;
  }

  function touch() { clearTimeout(idleTimer); idleTimer = setTimeout(() => { if (worker && !pending.size) { log('voice idle, unloading'); close(); } }, IDLE_UNLOAD_MS); if (idleTimer.unref) idleTimer.unref(); }

  // Warm the voice (load the model) ahead of the first line.
  async function warm() { try { await ensureWorker(); } catch (e) { log('voice warm failed: ' + e.message); } }

  // One line -> { sampleRate, pcm (Int16 LE bytes), ms, secs }. Rejects when the
  // voice is off, not installed, or the line was cut off by stop().
  let stopSeq = 0;
  async function synth(text) {
    const v = wanted();
    if (!v) throw new Error('system voice');
    const gen = stopSeq;
    const w = await ensureWorker();
    if (!w) throw new Error('voice not installed');
    if (gen !== stopSeq) throw new Error('stopped');       // a stop() landed while the model was loading
    const id = ++seq;
    touch();
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, at: now() });
      try { w.send({ type: 'say', id, text: String(text || ''), speed: v.speed }); } catch (e) { pending.delete(id); reject(e); }
    });
  }

  function stop() {
    stopSeq++;
    for (const p of pending.values()) p.reject(new Error('stopped'));
    pending.clear();
    if (worker) { try { worker.send({ type: 'stop' }); } catch (_) { /* gone */ } }
  }

  function close() { stop(); clearTimeout(idleTimer); if (worker) { try { worker.kill(); } catch (_) { /* gone */ } worker = null; ready = null; loading = null; } }

  // One instance is made before the sign-in window (to load Fable while the person signs in) and
  // handed to the companion, which sets its own listener here.
  function setOnState(fn) { onState = typeof fn === 'function' ? fn : () => {}; announce(); }
  return { status, install, warm, synth, stop, close, setOnState, modelDir: () => { const v = wanted(); return v ? modelDir(v) : ''; }, idle: () => !pending.size, VOICES, MODELS };
}

module.exports = { createVoice, bundledRoots, VOICES, MODELS, DEFAULT_VOICE, IDLE_UNLOAD_MS, sha256File, extract, tarAttempts, download };
