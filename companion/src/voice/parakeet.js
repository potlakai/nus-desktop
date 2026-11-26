'use strict';
// NVIDIA Parakeet v3, the engine for finished sentences (the default from
// 0.1.31; Settings can turn it off). The
// model is a one-time download (pinned file, checked by hash), kept under
// userData, and until it is there, or if it is switched off, whisper answers
// exactly as before. Off or not installed there is no worker and no memory.
//
// The listener (reflex/listen.js) asks ready() and transcribe(); it holds the
// time budget and the fallback, so nothing here can leave a person without words.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { download, extract, sha256File } = require('./index');

// The sherpa-onnx packaging of nvidia/parakeet-tdt-0.6b-v3 (CC-BY-4.0, THIRD-PARTY.md).
// Check the pin against the release asset before every release (docs/release.md).
const PARAKEET_MODEL = {
  url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2',
  // Re-uploaded upstream 2026-11-07 (the 2026-11-04 pin was 5793d0fd..., 487,170,055 bytes):
  // re-pinned 2026-11-20 against GitHub's published digest and re-benched on the same clips.
  sha256: '1495e91b59d7fc53ddca91f3431758ec99f8fa253fdb0e1e851be0f72b14b0f9',
  bytes: 487211443,
  folder: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8',
  // Sizes as well as names: an install cut off while unpacking leaves a short
  // encoder behind, and that must read as not installed.
  files: { 'encoder.int8.onnx': 652282294, 'decoder.int8.onnx': 11845274, 'joiner.int8.onnx': 6355277, 'tokens.txt': 93939 },
};
// The worker goes away after 5 quiet minutes. It holds about 800 MB (730 loaded,
// 840 after a long sentence; measured 2026-11-04), against Fable's 300 MB at 30
// minutes, and a miss costs less: the next press reloads it (about 5 s) while
// whisper answers that ask, nobody waits. Five minutes keeps it for a run of asks
// and gives the memory back when the person has moved on.
const PARAKEET_IDLE_UNLOAD_MS = 5 * 60 * 1000;
// A decode this old is not slow, it is stuck. The listener gave up on it long
// ago; the worker is killed so the next press starts a fresh one.
const HUNG_DECODE_MS = 30 * 1000;
// A model that will not load (short on memory, a damaged file) is not retried on
// every press: whisper carries on until the setting changes or the app restarts.
const MAX_LOAD_FAILURES = 3;
const THREADS = 4;

// Spawned like the voice's engine-worker: process.execPath with
// ELECTRON_RUN_AS_NODE, outside the asar (electron-builder.companion.config.js).
function createParakeet({ userData, root, settings, log = () => {}, spawnFn = spawn, executable = process.execPath, onState = () => {},
  idleMs = PARAKEET_IDLE_UNLOAD_MS, hungMs = HUNG_DECODE_MS, model = PARAKEET_MODEL, fetchFn = download, unpackFn = extract, hashFn = sha256File, now = () => Date.now() }) {
  const home = root || path.join(userData, 'speech');
  const dir = path.join(home, model.folder);
  let worker = null, loaded = false, loading = null, idleTimer = null, seq = 0, decoding = null, downloading = null, loadFailures = 0;

  // The default from 0.1.31 (Pranav 2026-11-20, "just switch to parakeet"): unset
  // means Parakeet; only an explicit 'whisper' (the Settings switch off) or
  // NUS_PARAKEET=0 keeps Whisper writing down finished sentences.
  function chosen() { const s = settings.get(); return process.env.NUS_PARAKEET !== '0' && !(s && s.speechModel === 'whisper'); }
  function installed() {
    return Object.entries(model.files).every(([name, size]) => {
      try { return fs.statSync(path.join(dir, name)).size === size; } catch (_) { return false; }
    });
  }
  function wanted() { return chosen() && installed(); }
  function ready() { return Boolean(wanted() && worker && loaded); }

  function status() {
    const on = chosen(), have = installed();
    return {
      on, label: 'Parakeet', installed: have, ready: Boolean(on && have && worker && loaded), loading: Boolean(worker && !loaded),
      failed: loadFailures >= MAX_LOAD_FAILURES, downloading: downloading ? { got: downloading.got, total: downloading.total } : null,
      modelBytes: model.bytes, idleMinutes: Math.round(idleMs / 60000),
    };
  }
  function announce() { try { onState(status()); } catch (_) { /* a listener, never a failure */ } }

  // The download without a click, now that Parakeet is the default: once per
  // start, in the background, only while it is chosen and not yet there. Whisper
  // answers everything until it lands. Never throws; a dropped connection waits
  // for the next start. A file that fails its hash is not fetched again by
  // itself for the same pin: upstream re-uploaded this model on 2026-11-07, and
  // every start would otherwise pull 465 MB and throw it away. The Settings
  // switch (install) still tries; a new pin in a new version clears the note.
  const hashNote = () => path.join(home, 'auto-install-hash-failed.json');
  function hashFailedBefore() {
    try { return JSON.parse(fs.readFileSync(hashNote(), 'utf8')).sha256 === model.sha256; } catch (_) { return false; }
  }
  async function autoInstall() {
    if (!chosen() || installed() || downloading) return status();
    if (hashFailedBefore()) { log('not downloading by itself: this pin failed its hash before (Settings can retry)'); return status(); }
    log('downloading in the background (' + Math.round(model.bytes / 1048576) + ' MB, once)');
    try { return await install(); } catch (e) {
      log('background download failed: ' + e.message);
      if (/expected hash/.test(e.message)) { try { fs.mkdirSync(home, { recursive: true }); fs.writeFileSync(hashNote(), JSON.stringify({ sha256: model.sha256, at: new Date(now()).toISOString() })); } catch (_) { /* best effort */ } }
      return status();
    }
  }

  // The one-time download: the Settings switch, and autoInstall above.
  // Resolves to status().
  async function install() {
    if (installed()) return status();
    if (downloading) return status();
    fs.mkdirSync(home, { recursive: true });
    const archive = path.join(home, path.basename(model.url));
    downloading = { got: 0, total: model.bytes };
    announce();
    try {
      if (!fs.existsSync(archive)) {
        let last = 0;
        await fetchFn(model.url, archive, (got, total) => { downloading.got = got; if (total) downloading.total = total; if (now() - last > 500) { last = now(); announce(); } });
      }
      const sum = await hashFn(archive);
      if (sum !== model.sha256) { fs.unlinkSync(archive); throw new Error('the downloaded speech model did not match its expected hash; try again'); }
      await unpackFn(archive, home);
      if (!installed()) throw new Error('the speech model files are incomplete after extracting');
      try { fs.unlinkSync(archive); } catch (_) { /* keep going */ }
      loadFailures = 0;
      log('installed');
    } finally { downloading = null; announce(); }
    return status();
  }

  function finishDecode() { const d = decoding; decoding = null; if (d) clearTimeout(d.hung); return d; }

  function touch() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!worker) return;
      if (decoding) { touch(); return; }
      log('idle, unloading');
      close();
    }, idleMs);
    if (idleTimer.unref) idleTimer.unref();
  }

  // Load the model ahead of the words. The talk key calls this on every press;
  // the same press's final goes to whisper if the load is not done by then.
  function warm() {
    if (!wanted() || loadFailures >= MAX_LOAD_FAILURES) return Promise.resolve(false);
    touch();
    if (worker) return loading || Promise.resolve(true);
    let w;
    try {
      w = spawnFn(executable, [path.join(__dirname, 'parakeet-worker.js')], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'advanced' });
    } catch (e) { loadFailures++; log('could not start: ' + e.message); return Promise.resolve(false); }
    worker = w; loaded = false;
    const t0 = now();
    loading = new Promise((resolve) => {
      const fail = (e) => {
        resolve(false);
        if (worker !== w) return;
        const wasLoading = !loaded;
        worker = null; loaded = false; loading = null;
        clearTimeout(idleTimer);
        if (wasLoading) loadFailures++;
        const d = finishDecode();
        if (d) d.reject(e);
        log(e.message);
        announce();
      };
      w.on('error', fail);
      w.on('exit', () => fail(new Error('worker exited')));
      w.on('message', (m) => {
        if (worker !== w || !m) return;
        if (m.type === 'hello') { try { w.send({ type: 'load', dir, threads: THREADS }); } catch (e) { fail(e); } return; }
        if (m.type === 'ready') { loaded = true; loading = null; loadFailures = 0; log('ready in ' + (now() - t0) + 'ms'); announce(); touch(); resolve(true); return; }
        if (m.type === 'text') { if (decoding && decoding.id === m.id) { const d = finishDecode(); log('decoded ' + Number(m.secs || 0).toFixed(1) + 's of audio in ' + m.ms + 'ms'); d.resolve(m.text); } touch(); return; }
        if (m.type === 'error') {
          if (m.id != null && decoding && decoding.id === m.id) { finishDecode().reject(new Error(m.message)); touch(); return; }
          if (!loaded) { fail(new Error(m.message)); try { w.kill(); } catch (_) { /* gone */ } return; }
          log(m.message);
        }
      });
    });
    announce();
    return loading;
  }

  // Int16 LE 16 kHz bytes in, the words out. Rejects when it cannot answer now.
  // One at a time: the listener sends one final at a time, so a decode still
  // running means an earlier one went over budget, and the next must not queue
  // behind it.
  function transcribe(pcm) {
    if (!ready()) return Promise.reject(new Error('not loaded'));
    if (decoding) return Promise.reject(new Error('still on the last one'));
    const id = ++seq;
    const w = worker;
    touch();
    return new Promise((resolve, reject) => {
      const hung = setTimeout(() => { log('decode stuck, restarting'); close(); }, hungMs);
      if (hung.unref) hung.unref();
      decoding = { id, resolve, reject, hung };
      try { w.send({ type: 'decode', id, pcm }); } catch (e) { finishDecode(); reject(e); }
    });
  }

  function close() {
    clearTimeout(idleTimer);
    const d = finishDecode();
    if (d) d.reject(new Error('unloaded'));
    if (worker) { const w = worker; worker = null; loaded = false; loading = null; try { w.kill(); } catch (_) { /* gone */ } announce(); }
  }

  // The switch moved: off lets the memory go at once; a fresh yes clears a load
  // that gave up. Turning it on loads nothing until the talk key is pressed.
  function settingChanged() { loadFailures = 0; if (!wanted()) close(); announce(); }

  return { name: 'parakeet', status, install, autoInstall, warm, wanted, ready, transcribe, close, settingChanged };
}

module.exports = { createParakeet, PARAKEET_MODEL, PARAKEET_IDLE_UNLOAD_MS, HUNG_DECODE_MS, MAX_LOAD_FAILURES };
