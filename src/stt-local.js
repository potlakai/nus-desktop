// Local speech-to-text via a bundled whisper.cpp binary. No cloud keys, no native modules:
// we spawn whisper-cli against a temp WAV and read the transcript from stdout.
//
// Only the Windows build bundles the binary (vendor/whisper, see
// electron-builder.config.js). On macOS nothing ships yet; a user who has
// whisper.cpp installed (brew install whisper-cpp) can point NUS_WHISPER_DIR at
// its bin directory and this finds `whisper-cli` there.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { pcmToWav, rms16 } = require('../companion/src/wav');

const MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en-q5_1.bin';
const MODEL_NAMES = ['ggml-small.en-q5_1.bin', 'ggml-base.en-q5_1.bin'];
const EXE_NAMES = process.platform === 'win32' ? ['whisper-cli.exe', 'main.exe'] : ['whisper-cli', 'main'];
const WHISPER_TIMEOUT_MS = 30_000;
const MIN_BYTES = 16000 * 2 * 0.4; // 0.4 s of 16 kHz Int16
const RMS_GATE = 200;

let cachedExe;      // undefined = not probed, null = missing
let userDataDir = null;

function init({ userData }) { userDataDir = userData; }

function binaryDirs() {
  const dirs = [];
  if (process.env.NUS_WHISPER_DIR) dirs.push(process.env.NUS_WHISPER_DIR);
  if (process.resourcesPath) dirs.push(path.join(process.resourcesPath, 'whisper'));
  dirs.push(path.join(__dirname, '..', 'vendor', 'whisper'));
  return dirs;
}

function findBinary() {
  if (cachedExe !== undefined) return cachedExe;
  cachedExe = null;
  for (const dir of binaryDirs()) {
    for (const name of EXE_NAMES) {
      const full = path.join(dir, name);
      try { if (fs.existsSync(full)) { cachedExe = full; return cachedExe; } } catch {}
    }
  }
  return cachedExe;
}

function modelDirs() {
  const dirs = [];
  if (userDataDir) dirs.push(path.join(userDataDir, 'whisper-models'));
  dirs.push(path.join(__dirname, '..', 'vendor', 'whisper-models'));
  return dirs;
}

function findModel() {
  for (const name of MODEL_NAMES) {
    for (const dir of modelDirs()) {
      const full = path.join(dir, name);
      try { if (fs.existsSync(full)) return full; } catch {}
    }
  }
  return null;
}

function status() {
  return { binary: !!findBinary(), model: !!findModel(), available: !!findBinary() && !!findModel() };
}

// Download the base model to userData on first use (renderer asks for consent first).
async function ensureModel(onProgress) {
  const existing = findModel();
  if (existing) return existing;
  if (!userDataDir) throw new Error('stt_not_initialized');
  const dir = path.join(userDataDir, 'whisper-models');
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, path.basename(new URL(MODEL_URL).pathname));
  const tmp = dest + '.part';
  const res = await fetch(MODEL_URL, { redirect: 'follow' });
  if (!res.ok) throw new Error(`model_download_failed_${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const out = fs.createWriteStream(tmp);
  let got = 0;
  for await (const chunk of res.body) {
    out.write(Buffer.from(chunk));
    got += chunk.length;
    if (total && onProgress) onProgress(Math.round((got / total) * 100));
  }
  await new Promise((resolve, reject) => out.end((err) => err ? reject(err) : resolve()));
  fs.renameSync(tmp, dest);
  return dest;
}

function runWhisper(exe, model, wavPath, signal) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) return resolve({ cancelled: true });
    const args = ['-m', model, '-f', wavPath, '-l', 'en', '-t', String(Math.max(1, Math.min(4, os.cpus().length - 1))), '-nt', '-np'];
    let child;
    try {
      child = spawn(exe, args, { windowsHide: true });
    } catch (err) {
      return resolve({ error: 'whisper_spawn_failed', detail: String(err && err.message) });
    }
    let out = '';
    let done = false;
    let timer;
    const abort = () => {
      try { child.kill(); } catch {}
      finish({ cancelled: true });
    };
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', abort);
      resolve(result);
    };
    timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish({ error: 'whisper_timeout' });
    }, WHISPER_TIMEOUT_MS);
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', () => {});
    child.on('error', (err) => { clearTimeout(timer); finish({ error: 'whisper_failed', detail: String(err && err.message) }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return finish({ error: 'whisper_failed', detail: `exit ${code}` });
      finish({ text: out.replace(/\s+/g, ' ').trim() });
    });
    if (signal) {
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    }
  });
}

const { createTranscriptionQueue } = require('./transcription-queue');
const transcriptionQueue = createTranscriptionQueue();

async function transcribePcm(pcm, options = {}) {
  if (!Buffer.isBuffer(pcm)) pcm = Buffer.from(pcm);
  if (pcm.length < MIN_BYTES) return { text: '' };
  if (rms16(pcm) < RMS_GATE) return { text: '' };
  const exe = findBinary();
  const model = findModel();
  if (!exe || !model) return { error: 'stt_not_installed' };
  return transcriptionQueue.enqueue(async () => {
    if (options.signal && options.signal.aborted) return { cancelled: true };
    const dir = path.join(userDataDir || os.tmpdir(), 'voice-tmp');
    fs.mkdirSync(dir, { recursive: true });
    const wavPath = path.join(dir, `utt-${Date.now()}-${Math.floor(Math.random() * 1e6)}.wav`);
    fs.writeFileSync(wavPath, pcmToWav(pcm, 16000, 1));
    try {
      return await runWhisper(exe, model, wavPath, options.signal);
    } finally {
      try { fs.unlinkSync(wavPath); } catch {}
    }
  }, options);
}

module.exports = { init, status, ensureModel, transcribePcm, cancel: (sessionId) => transcriptionQueue.cancel(sessionId) };
