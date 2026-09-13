// The Windows probe: a long-lived PowerShell sidecar (probe.ps1) that reports
// the foreground window, UI Automation controls and their rects, and, only
// while asked to watch, key and click transitions. JSON lines over stdio.
//
// No native modules and no global hook: it follows the whisper sidecar
// precedent (spawned exe, dies with the app). Every caller must tolerate
// `available === false`: on macOS, when PowerShell is blocked, or when the
// sidecar fails to answer a ping, the Companion degrades to model-only
// pointing and toggle-to-talk, and never crashes.
'use strict';

const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');
const childProcess = require('child_process');

const PING_TIMEOUT_MS = 15000;
const DEFAULT_TIMEOUT_MS = 3000;
const RESTART_MAX_MS = 30000;

function scriptPath(resourcesPath) {
  // Packaged: outside the asar (extraResources -> resources/win/probe.ps1).
  // Dev: next to this file.
  const candidates = [];
  if (resourcesPath) candidates.push(path.join(resourcesPath, 'win', 'probe.ps1'));
  candidates.push(path.join(__dirname, 'probe.ps1'));
  for (const p of candidates) { try { if (fs.existsSync(p)) return p; } catch (_) { /* next */ } }
  return null;
}

function createProbe(opts = {}) {
  const emitter = new EventEmitter();
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const spawn = typeof opts.spawn === 'function' ? opts.spawn : childProcess.spawn;
  const platform = opts.platform || process.platform;
  const script = opts.script || scriptPath(opts.resourcesPath);

  let child = null;
  let stopped = true;
  let nextId = 1;
  let restartDelay = 1000;
  let restartTimer = null;
  let pingTimer = null;
  let buffer = '';
  const pending = new Map();      // id -> { resolve, reject, timer }
  const state = { available: false, pid: 0, restarts: 0, lastError: '', watching: null, ready: false };

  function failPending(reason) {
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
      pending.delete(id);
    }
  }

  function handleLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch (_) { log('unparsable line: ' + line.slice(0, 120)); return; }
    if (msg && msg.ev) {
      if (msg.ev === 'ready') {
        state.ready = true;
        state.pid = Number(msg.pid) || state.pid;
      }
      emitter.emit('event', msg);
      emitter.emit(msg.ev, msg);
      return;
    }
    if (msg && msg.id != null && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(String(msg.error)));
      else p.resolve(msg);
    }
  }

  function onExit(code, signal) {
    const wasAvailable = state.available;
    child = null;
    state.available = false;
    state.ready = false;
    state.watching = null;
    if (pingTimer) { clearTimeout(pingTimer); pingTimer = null; }
    failPending('probe exited');
    emitter.emit('availability', false);
    if (stopped) return;
    log('sidecar exited (' + (code != null ? code : signal) + ')' + (wasAvailable ? ', restarting' : ''));
    state.restarts += 1;
    restartTimer = setTimeout(() => { restartTimer = null; launch(); }, restartDelay);
    if (restartTimer.unref) restartTimer.unref();
    restartDelay = Math.min(RESTART_MAX_MS, restartDelay * 2);
  }

  function launch() {
    if (child || stopped) return;
    if (platform !== 'win32') { state.lastError = 'not windows'; return; }
    if (!script) { state.lastError = 'probe.ps1 missing'; log(state.lastError); return; }
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      state.lastError = 'spawn failed: ' + e.message;
      log(state.lastError);
      child = null;
      onExit(-1, null);
      return;
    }
    buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (line.trim()) handleLine(line);
      }
    });
    if (child.stderr) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (d) => { const t = String(d).trim(); if (t) { state.lastError = t.slice(0, 300); log('stderr: ' + t.slice(0, 300)); } });
    }
    child.on('error', (e) => { state.lastError = e.message; log('error: ' + e.message); });
    child.on('exit', onExit);
    // The ping is the availability gate: no answer means degrade, not hang.
    pingTimer = setTimeout(() => {
      pingTimer = null;
      if (!state.available && child) { log('no ping reply, giving up on the sidecar'); stopped = true; try { child.kill(); } catch (_) {} }
    }, PING_TIMEOUT_MS);
    if (pingTimer.unref) pingTimer.unref();
    request('ping', {}, PING_TIMEOUT_MS).then((r) => {
      if (pingTimer) { clearTimeout(pingTimer); pingTimer = null; }
      state.available = true;
      state.pid = Number(r.pid) || state.pid;
      restartDelay = 1000;
      log('ready (pid ' + state.pid + ', PowerShell ' + (r.ps || '?') + ')');
      emitter.emit('availability', true);
    }).catch((e) => { state.lastError = 'ping: ' + e.message; });
  }

  function request(op, params = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      if (!child || !child.stdin || child.stdin.destroyed) return reject(new Error('probe not running'));
      const id = nextId++;
      const timer = setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); reject(new Error(op + ' timed out after ' + timeoutMs + 'ms')); }
      }, timeoutMs);
      if (timer.unref) timer.unref();
      pending.set(id, { resolve, reject, timer });
      try {
        child.stdin.write(JSON.stringify(Object.assign({ id, op }, params)) + '\n');
      } catch (e) {
        pending.delete(id);
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  return {
    get available() { return state.available; },
    status() { return { available: state.available, pid: state.pid, restarts: state.restarts, lastError: state.lastError, watching: state.watching, script }; },
    start() {
      if (!stopped) return;
      stopped = false;
      restartDelay = 1000;
      launch();
    },
    stop() {
      stopped = true;
      if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
      if (pingTimer) { clearTimeout(pingTimer); pingTimer = null; }
      const c = child;
      child = null;
      state.available = false;
      state.watching = null;
      failPending('probe stopped');
      if (c) { try { c.stdin.end(); } catch (_) {} try { c.kill(); } catch (_) {} }
    },
    request,
    // Only while a session needs it: key/click polling costs CPU.
    async watch(options = {}) {
      const r = await request('watch.start', { keys: options.keys || [], click: options.click !== false, fg: options.fg !== false });
      state.watching = { keys: options.keys || [], click: options.click !== false, fg: options.fg !== false };
      return r;
    },
    async unwatch() {
      state.watching = null;
      if (!child) return { ok: true };
      return request('watch.stop', {}).catch(() => ({ ok: false }));
    },
    on: (event, cb) => { emitter.on(event, cb); return () => emitter.off(event, cb); },
    off: (event, cb) => emitter.off(event, cb),
    _handleLine: handleLine,
  };
}

module.exports = { createProbe, scriptPath };
