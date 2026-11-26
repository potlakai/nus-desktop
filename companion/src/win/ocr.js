// The words on a screenshot, through the OCR engine built into Windows
// (ocr.ps1). One short-lived PowerShell per read: about a second, local, free.
// Anything that goes wrong is a rejection; assignment mode then lets the model
// decide instead.
'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const SCRIPT = path.join(__dirname, 'ocr.ps1').replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
const TIMEOUT_MS = 8000;

function ocrFile(file, words) {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') { reject(new Error('ocr is Windows only')); return; }
    // WinRT's GetFileFromPathAsync refuses forward slashes and relative paths.
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-Path', path.resolve(file)].concat(words ? ['-Words'] : []),
      { windowsHide: true, timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) { reject(new Error(String(stderr || err.message).trim().slice(0, 200))); return; }
        resolve(String(stdout || '').replace(/^﻿/, ''));
      });
  });
}

// jpeg: a Buffer. dir: where the short-lived file goes (app-owned).
// probe: the long-lived Windows probe when it is up; its 'ocr' op skips the
// half second a fresh PowerShell costs. A probe failure falls back to one.
async function ocrJpeg(jpeg, dir, probe) {
  // Not on Windows (the Mac beta): no file is written and nothing is started; the caller lets the model read instead.
  if (process.platform !== 'win32') throw new Error('ocr is Windows only');
  await fs.promises.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'ocr-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7) + '.jpg');
  await fs.promises.writeFile(file, jpeg);
  try {
    if (probe && probe.available) {
      try {
        const r = await probe.request('ocr', { path: path.resolve(file) }, TIMEOUT_MS);
        if (r && typeof r.text === 'string') return r.text;
        throw new Error((r && r.error) || 'no text from the probe');
      } catch (e) { /* the one-shot path below still works */ void e; }
    }
    return await ocrFile(file);
  } finally { try { await fs.promises.unlink(file); } catch (_) { /* best effort */ } }
}

// The same read, with where each word is: for marks drawn on the screen
// (src/guide/marks.js). -> { width, height, lines:[{ words:[{t,x,y,w,h}] }] }
// in the image's own pixels. Rejects like ocrJpeg; the caller then draws only
// what the control list can place.
async function ocrWords(jpeg, dir, probe) {
  const { parseOcrWords } = require('../guide/marks');
  await fs.promises.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'ocr-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7) + '.jpg');
  await fs.promises.writeFile(file, jpeg);
  try {
    if (probe && probe.available) {
      try {
        const r = await probe.request('ocr', { path: path.resolve(file), words: true }, TIMEOUT_MS);
        if (r && typeof r.words === 'string' && r.width > 0 && r.height > 0) return Object.assign({ width: Number(r.width), height: Number(r.height) }, parseOcrWords(r.words));
        throw new Error((r && r.error) || 'no words from the probe');
      } catch (e) { /* the one-shot path below still works */ void e; }
    }
    const raw = await ocrFile(file, true);
    const nl = raw.indexOf('\n');
    const size = /^(\d+) (\d+)\s*$/.exec(nl < 0 ? raw : raw.slice(0, nl));
    if (!size) throw new Error('no words from the OCR script');
    return Object.assign({ width: Number(size[1]), height: Number(size[2]) }, parseOcrWords(nl < 0 ? '' : raw.slice(nl + 1)));
  } finally { try { await fs.promises.unlink(file); } catch (_) { /* best effort */ } }
}

module.exports = { ocrFile, ocrJpeg, ocrWords };
