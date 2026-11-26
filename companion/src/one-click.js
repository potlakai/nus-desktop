'use strict';
// One-click update: fetch the installer named in the signed channel file, check
// its size and SHA-512 against that file, run it silently, quit. Only what the
// channel signed can run: the URL, size and hash all come from it. Why this and
// not electron-updater: docs/update-channel.md. Electron-free for node --test.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { Readable, Transform } = require('stream');

// electron-builder's NSIS flags: --updated (keep the person's shortcut choices,
// wait for the app to leave), /S (no pages), --force-run (open the new version).
const INSTALLER_ARGS = ['--updated', '/S', '--force-run'];
const STALL_MS = 60000;

function fileSha512(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha512');
    fs.createReadStream(file).on('error', reject).on('data', c => h.update(c)).on('end', () => resolve(h.digest('base64')));
  });
}

// Streams `url` to `dest`, then checks the file on disk. Anything short, long or
// different is deleted and throws; a file that throws here never reaches spawn.
async function download({ url, dest, size, sha512, fetchImpl = global.fetch, onProgress = () => {} }) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const part = dest + '.part';
  const ctl = new AbortController();
  let stall = setTimeout(() => ctl.abort(), STALL_MS);
  const alive = () => { clearTimeout(stall); stall = setTimeout(() => ctl.abort(), STALL_MS); };
  try {
    const res = await fetchImpl(url, { credentials: 'omit', redirect: 'follow', signal: ctl.signal });
    if (!res.ok || !res.body) throw new Error('download answered ' + res.status);
    let got = 0, lastPct = -1;
    const counter = new Transform({
      transform(chunk, _enc, done) {
        alive();
        got += chunk.length;
        if (got > size) return done(new Error('download is larger than the signed size'));
        const pct = Math.floor(got / size * 100);
        if (pct !== lastPct) { lastPct = pct; onProgress(pct); }
        done(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(part));
    if (got !== size) throw new Error('download is smaller than the signed size');
    const actual = await fileSha512(part);
    if (actual !== sha512) throw new Error('download does not match the signed hash');
    fs.rmSync(dest, { force: true });
    fs.renameSync(part, dest);
    return dest;
  } catch (e) {
    fs.rmSync(part, { force: true });
    throw e;
  } finally {
    clearTimeout(stall);
  }
}

// channel: createChannel(). dir: where the installer waits. quit: leaves the app.
// canRun: this copy can replace itself (the installed build on Windows; never a
// portable copy, which has no install folder, and never a dev run).
function createOneClick({ channel, dir, canRun, fetchImpl, spawnImpl, quit, onState = () => {}, beforeInstall = () => {}, log = () => {} }) {
  let state = { phase: 'idle', pct: 0, version: null };
  const set = patch => { state = { ...state, ...patch }; try { onState(state); } catch { /* the display never stops an update */ } };

  function available() {
    if (!canRun) return false;
    const u = channel.update();
    return !!(u && u.installer);
  }

  function start(file) {
    return new Promise((resolve, reject) => {
      let child;
      try { child = spawnImpl(file, INSTALLER_ARGS, { detached: true, stdio: 'ignore', windowsHide: true }); } catch (e) { reject(e); return; }
      child.once('error', reject);
      child.once('spawn', () => { child.unref(); resolve(); });
    });
  }

  // Resolves to true when the installer is running and the app is on its way
  // out, false when nothing changed. Never rejects; a second click while one is
  // going is the same run.
  let running = null;
  function run() {
    if (running) return running;
    running = (async () => {
      const u = channel.update();
      if (!canRun || !u || !u.installer) return false;
      try {
        set({ phase: 'downloading', pct: 0, version: u.version, error: null });
        const dest = path.join(dir, 'Nus-Companion-Setup-' + u.version + '.exe');
        await download({ url: u.installer.url, dest, size: u.installer.size, sha512: u.installer.sha512, fetchImpl, onProgress: pct => set({ pct }) });
        set({ phase: 'installing', pct: 100 });
        beforeInstall(u.version);
        await start(dest);
        log('one-click: installer started for ' + u.version);
        quit();
        return true;
      } catch (e) {
        log('one-click failed: ' + e.message);
        set({ phase: 'failed', error: e.message });
        return false;
      } finally { running = null; }
    })();
    return running;
  }

  // At launch: the installer that brought this version is finished with.
  function cleanup() {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* retried at the next launch */ }
  }

  return { available, run, cleanup, state: () => state };
}

module.exports = { createOneClick, download, fileSha512, INSTALLER_ARGS };
