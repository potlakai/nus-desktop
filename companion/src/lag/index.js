'use strict';
// The lag recorder, wired to the app. Off unless asked for:
//   - a dev run (not packaged) has it on, NUS_LAG=0 turns it off;
//   - a packaged build turns it on with NUS_LAG=1, or with an empty file named
//     lag-on.txt in the profile folder (%APPDATA%\Nus Companion).
// It writes to <profile>\companion\lag\lag-<start time>.jsonl and keeps the last
// few runs. `node scripts/lag-report.js <file>` reads one back as a table.
//
// What it watches (see recorder.js for the lines it writes):
//   - the main thread: Node's event loop delay histogram, and a 50 ms timer whose
//     lateness is a stall;
//   - named main-thread work: IPC handlers, timer callbacks, synchronous file
//     calls, synchronous child processes, each timed, written only when slow;
//   - every child process: what, how long starting it held the main thread, how
//     long it lived;
//   - each window: long tasks, long frames, input delay, the wait for each frame
//     the page asked for, and how long the page took to answer main;
//   - CPU and memory per process, from app.getAppMetrics();
//   - whether the overlay is taking the mouse (not click-through).
//
// Off, every function here is a no-op and nothing is patched.

const path = require('path');
const { createRecorder, createNoop, round } = require('./recorder');
const pageProbe = require('./page-probe');

const KEEP_FILES = 6;
const MAX_BYTES = 12 * 1024 * 1024;     // one run stops writing past this

let rec = createNoop();
let active = false;
let file = null;

function wanted({ env = process.env, packaged, userData, fs = require('fs') }) {
  if (env.NUS_LAG === '0') return false;
  if (env.NUS_LAG === '1' || env.NUS_LAG === '2') return true;
  try { if (userData && fs.existsSync(path.join(userData, 'lag-on.txt'))) return true; } catch (_) { /* unreadable profile: off */ }
  return !packaged;
}

function windowName(url) {
  const u = String(url || '');
  if (/renderer\/index\.html/.test(u)) return 'overlay';
  if (/home\/index\.html/.test(u)) return 'dashboard';
  if (/publik\/gate\.html/.test(u)) return 'signin';
  if (/touch-pad\.html/.test(u)) return 'touchpad';
  return null;
}

function label(fn) {
  if (!fn) return '?';
  if (fn.name) return fn.name;
  const src = Function.prototype.toString.call(fn).replace(/\s+/g, ' ');
  return src.slice(0, 70);
}

function install({ electron = require('electron'), fs = require('fs'), version = '' } = {}) {
  const { app, ipcMain } = electron;
  if (active) return api;
  let userData = '';
  try { userData = app.getPath('userData'); } catch (_) { /* not ready */ }
  if (!wanted({ packaged: app.isPackaged, userData, fs })) return api;

  const os = require('os');
  const perf = require('perf_hooks');
  const dir = path.join(userData, 'companion', 'lag');
  // The originals, taken before anything is wrapped, for the recorder's own use.
  const raw = { mkdirSync: fs.mkdirSync, readdirSync: fs.readdirSync, unlinkSync: fs.unlinkSync, appendFile: fs.appendFile, appendFileSync: fs.appendFileSync,
    setInterval: global.setInterval, setTimeout: global.setTimeout };
  try {
    raw.mkdirSync.call(fs, dir, { recursive: true });
    const old = raw.readdirSync.call(fs, dir).filter((n) => /^lag-.*\.jsonl$/.test(n)).sort();
    for (const n of old.slice(0, Math.max(0, old.length - (KEEP_FILES - 1)))) { try { raw.unlinkSync.call(fs, path.join(dir, n)); } catch (_) { /* in use */ } }
  } catch (_) { return api; }
  file = path.join(dir, 'lag-' + new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '') + '.jsonl');

  // Lines wait in memory and go to disk off the main thread's clock.
  let pending = [], written = 0, full = false;
  const write = (line) => { if (full) return; pending.push(line); };
  const flush = (sync) => {
    if (!pending.length) return;
    const text = pending.join('\n') + '\n'; pending = [];
    written += text.length; if (written > MAX_BYTES) full = true;
    if (sync) { try { raw.appendFileSync.call(fs, file, text); } catch (_) { /* disk */ } }
    else raw.appendFile.call(fs, file, text, () => {});
  };

  rec = createRecorder({ write, sampleMs: Number(process.env.NUS_LAG_SAMPLE_MS) || 5000 });
  active = true;
  const cfg = rec.config;
  rec.emit('start', { version, electron: process.versions.electron, packaged: !!app.isPackaged, cpus: os.cpus().length, cpu: (os.cpus()[0] || {}).model || '', memGb: round(os.totalmem() / 1073741824),
    sampleMs: cfg.sampleMs, tickMs: cfg.tickMs, stallMs: cfg.stallMs, slowMs: cfg.slowMs });

  // ---- child processes ------------------------------------------------------
  // Every asynchronous start (spawn, exec, execFile, fork) goes through this one
  // method, whatever a module kept a reference to.
  const cp = require('child_process');
  const procName = (options) => {
    const f = path.basename(String((options && options.file) || '?'));
    const args = (options && options.args) || [];
    const script = args.find((a) => /\.(ps1|js|cjs|mjs|cmd|bat)$/i.test(String(a)));
    return script ? f + ' ' + path.basename(String(script)) : f;
  };
  const spawnOrig = cp.ChildProcess.prototype.spawn;
  cp.ChildProcess.prototype.spawn = function (options) {
    const t0 = perf.performance.now();
    let r;
    try { r = spawnOrig.call(this, options); }
    finally {
      const syncMs = perf.performance.now() - t0;
      const end = rec.spawnBegin(procName(options), syncMs);
      this.once('exit', (code) => end(code));
      this.once('error', () => end(-1));
      if (syncMs >= cfg.slowMs) rec.slow('spawn ' + procName(options), syncMs);
    }
    return r;
  };
  for (const name of ['spawnSync', 'execSync', 'execFileSync']) {
    const orig = cp[name];
    cp[name] = rec.timed((a) => name + ' ' + path.basename(String(a[0] || '').split(' ')[0]), orig);
  }

  // ---- synchronous file calls -------------------------------------------------
  const fileLabel = (name) => (a) => name + ' ' + (typeof a[0] === 'string' ? path.basename(a[0]) : typeof a[0] === 'number' ? 'fd' : '?');
  for (const name of ['readFileSync', 'writeFileSync', 'appendFileSync', 'renameSync', 'fsyncSync', 'readdirSync', 'copyFileSync', 'rmSync', 'unlinkSync', 'mkdirSync', 'statSync', 'existsSync', 'openSync', 'closeSync']) {
    if (typeof fs[name] === 'function') fs[name] = rec.timed(fileLabel(name), fs[name]);
  }

  // ---- IPC handlers and timers ------------------------------------------------
  // A listener is wrapped, so taking it off again has to find the wrapper.
  const wrappers = new WeakMap();
  for (const method of ['handle', 'on', 'once']) {
    const orig = ipcMain[method].bind(ipcMain);
    ipcMain[method] = (channel, listener) => {
      const w = rec.timed('ipc ' + channel, listener);
      if (typeof listener === 'function') wrappers.set(listener, w);
      return orig(channel, w);
    };
  }
  for (const method of ['removeListener', 'off']) {
    const orig = ipcMain[method].bind(ipcMain);
    ipcMain[method] = (channel, listener) => orig(channel, wrappers.get(listener) || listener);
  }
  for (const name of ['setTimeout', 'setInterval', 'setImmediate']) {
    const orig = global[name];
    const patched = function (fn, ...rest) { return orig(typeof fn === 'function' ? rec.timed(() => name + ' ' + label(fn), fn) : fn, ...rest); };
    for (const key of Object.getOwnPropertySymbols(orig)) patched[key] = orig[key];
    global[name] = patched;
  }

  // ---- the main thread's clock --------------------------------------------------
  let loop = null;
  try { loop = perf.monitorEventLoopDelay({ resolution: 20 }); loop.enable(); } catch (_) { loop = null; }
  raw.setInterval(() => rec.tick(), cfg.tickMs).unref();

  // ---- windows ------------------------------------------------------------------
  const pages = new Map();   // name -> { wc, busy, askedAt }
  app.on('browser-window-created', (_e, w) => {
    const wc = w.webContents;
    // The app's own code is left as it is: the recorder listens at the window. What main sends
    // the Knot's page says what the Knot is doing, and the one call that makes a window take or
    // pass the mouse is noted as it goes by.
    const sendOrig = wc.send.bind(wc);
    wc.send = (channel, ...args) => { if (windowName(wc.getURL()) === 'overlay') rec.channel(channel, args[0]); return sendOrig(channel, ...args); };
    const ignoreOrig = w.setIgnoreMouseEvents.bind(w);
    w.setIgnoreMouseEvents = (ignore, options) => { const name = windowName(wc.getURL()); if (name) rec.mouseSet(name, !ignore); return ignoreOrig(ignore, options); };
    const attach = () => {
      const name = windowName(wc.getURL());
      if (!name) return;
      pages.set(name, { wc, w, busy: false, askedAt: 0 });
      if (name === 'dashboard' || name === 'signin') rec.set({ [name]: true });
      wc.executeJavaScript(pageProbe.SOURCE, true).catch(() => {});
    };
    wc.on('did-finish-load', attach);
    w.on('unresponsive', () => rec.emit('hung', { w: windowName(wc.getURL()), on: true }));
    w.on('responsive', () => rec.emit('hung', { w: windowName(wc.getURL()), on: false }));
    w.on('closed', () => { for (const [name, p] of pages) if (p.w === w) { pages.delete(name); if (name === 'dashboard' || name === 'signin') rec.set({ [name]: false }); } });
  });

  // ---- the sample -----------------------------------------------------------------
  const ncpu = os.cpus().length;
  let lastCpu = new Map(), lastAt = perf.performance.now();
  function procs() {
    const out = [], next = new Map(), t = perf.performance.now(), wall = (t - lastAt) / 1000;
    let total = 0;
    let rows = [];
    try { rows = app.getAppMetrics(); } catch (_) { rows = []; }
    const names = new Map();
    for (const [name, p] of pages) { try { names.set(p.wc.getOSProcessId(), name); } catch (_) { /* gone */ } }
    for (const m of rows) {
      const cum = m.cpu && Number.isFinite(m.cpu.cumulativeCPUUsage) ? m.cpu.cumulativeCPUUsage : null;
      let pct;
      if (cum != null) { next.set(m.pid, cum); pct = lastCpu.has(m.pid) && wall > 0 ? (cum - lastCpu.get(m.pid)) / wall * 100 : 0; }
      else pct = ((m.cpu && m.cpu.percentCPUUsage) || 0) * ncpu;
      total += pct;
      const type = m.type === 'Tab' ? (names.get(m.pid) || 'page') : m.type === 'Browser' ? 'main' : (m.serviceName || m.name || m.type || '').replace(/^.*\./, '').slice(0, 24) || m.type;
      out.push({ p: type, cpu: round(pct), mb: Math.round(((m.memory && m.memory.workingSetSize) || 0) / 1024) });
    }
    lastCpu = next; lastAt = t;
    return { total: round(total), list: out };
  }
  async function drainPage(name, p) {
    if (p.wc.isDestroyed()) return null;
    if (p.busy) return { hungMs: Math.round(perf.performance.now() - p.askedAt) };
    p.busy = true; p.askedAt = perf.performance.now();
    try {
      const d = await p.wc.executeJavaScript(pageProbe.DRAIN, true);
      const rt = perf.performance.now() - p.askedAt;
      return d ? Object.assign(d, { rt: round(rt) }) : { rt: round(rt), probe: false };
    } catch (_) { return null; }
    finally { p.busy = false; }
  }
  let battery = null;
  async function sampleNow() {
    try { const b = !!electron.powerMonitor.isOnBatteryPower(); if (b !== battery) { battery = b; rec.set({ battery: b }); } } catch (_) { /* no power monitor */ }
    const extra = {};
    if (loop) {
      extra.loop = { p50: round(loop.percentile(50) / 1e6), p99: round(loop.percentile(99) / 1e6), max: round(loop.max / 1e6), mean: round(loop.mean / 1e6) };
      loop.reset();
    }
    extra.cpu = procs();
    const windows = {};
    await Promise.all([...pages].map(async ([name, p]) => { const d = await Promise.race([drainPage(name, p), new Promise((r) => raw.setTimeout(() => r({ late: true }), 2000))]); if (d) windows[name] = d; }));
    extra.win = windows;
    rec.sample(extra);
    flush(false);
  }
  raw.setInterval(() => { sampleNow().catch(() => {}); }, cfg.sampleMs).unref();
  app.on('will-quit', () => { try { rec.emit('stop', rec.stats()); flush(true); } catch (_) { /* quitting */ } });
  console.log('[lag] recording to ' + file);
  return api;
}

const api = {
  install,
  on: () => active,
  file: () => file,
  // For code that wants to say so itself; the windows are tapped in install(), so nothing has to.
  channel: (name, data) => { if (active) rec.channel(name, data); },
  // taking: true while the window takes the mouse (the opposite of click-through).
  mouse: (name, taking) => { if (active) rec.mouseSet(name, taking); },
  set: (patch) => { if (active) rec.set(patch); },
  slow: (name, ms) => { if (active) rec.slow(name, ms); },
  timed: (name, fn) => (active ? rec.timed(name, fn) : fn),
  wanted, windowName,
};

module.exports = api;
