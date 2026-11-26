'use strict';
const path = require('path');
const { spawn } = require('node:child_process');
const { modelCapture } = require('./capture-model');

function createCaptureClient({ nativeImage, launch = spawn, executable = process.execPath, log = () => {}, timeoutMs = 10000 }) {
  let child = null, sequence = 0;
  const pending = new Map();
  function failAll(error) { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); } pending.clear(); }
  function ensure() {
    if (child) return child;
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const c = launch(executable, [path.join(__dirname, 'capture-worker.js')], { env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], serialization: 'advanced' });
    child = c;
    c.stderr?.on('data', b => log('capture worker: ' + String(b).trim().slice(0, 250)));
    c.on('error', e => { if (child === c) { child = null; failAll(e); } });
    c.on('exit', () => { if (child === c) { child = null; failAll(new Error('capture worker exited')); } });
    c.on('message', m => {
      if (m.type === 'ready') { log('capture worker ready'); return; }
      const p = pending.get(m.id); if (!p) return;
      pending.delete(m.id); clearTimeout(p.timer);
      if (m.error) { p.reject(new Error(m.error)); return; }
      if ('model' in m) { p.resolve(m.model ? modelCapture(m.model, nativeImage) : null); return; }
      if (!m.cap) { p.resolve(null); return; }
      try {
        const { bitmap, imageSize, ...cap } = m.cap, started = performance.now();
        Object.defineProperty(cap, 'image', { value: nativeImage.createFromBitmap(Buffer.from(bitmap), imageSize), enumerable: false });
        cap.workerImageOpsMs = cap.blockMs;
        cap.blockMs = performance.now() - started;
        p.resolve(cap);
      } catch (e) { p.reject(e); }
    });
    return c;
  }
  function request(type, displayId, opts) {
    return new Promise((resolve, reject) => {
      const c = ensure(), id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('capture worker timed out')); if (child === c) { child = null; c.kill(); failAll(new Error('capture worker reset')); } }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      c.send({ type, id, displayId, opts }, e => { if (e && pending.has(id)) { pending.delete(id); clearTimeout(timer); reject(e); } });
    });
  }
  return {
    start() { ensure(); },
    capture(displayId, opts = {}) { return request('capture', displayId, { ...opts, dataUrl: false }); },
    // The guide's screenshot: { dataUrl (JPEG), width, height, pxWidth, pxHeight, display, image }.
    captureModel(displayId, opts = {}) { return request('model', displayId, opts); },
    close() { const c = child; child = null; failAll(new Error('capture stopped')); c?.kill(); },
  };
}
module.exports = { createCaptureClient };
