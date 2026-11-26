'use strict';
// Which line of `where.exe claude` Nūs starts on Windows. An npm install lists a bare `claude`
// shell script first, and starting that one fails with ENOENT (0.1.30 and earlier).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { pickWindowsCli } = require('../../src/claude-pool');

const NPM = 'C:/Users/someone/AppData/Roaming/npm/';
const none = () => false;

test('an npm install: the .cmd is picked, not the bare shell script listed first', () => {
  assert.strictEqual(pickWindowsCli([NPM + 'claude', NPM + 'claude.cmd'], none), NPM + 'claude.cmd');
  assert.strictEqual(pickWindowsCli(NPM + 'claude\r\n' + NPM + 'claude.cmd\r\n', none), NPM + 'claude.cmd');
});

test('a real program wins over a shim, wherever it is in the list', () => {
  const exe = 'C:/Users/someone/.local/bin/claude.exe';
  assert.strictEqual(pickWindowsCli([NPM + 'claude', NPM + 'claude.cmd', exe], none), exe);
  assert.strictEqual(pickWindowsCli([exe], none), exe);
});

test('only the bare script is listed: the .cmd beside it is used when it is there', () => {
  assert.strictEqual(pickWindowsCli([NPM + 'claude'], (p) => p === NPM + 'claude.cmd'), NPM + 'claude.cmd');
});

test('nothing better: the first line, as before; nothing listed: null', () => {
  assert.strictEqual(pickWindowsCli([NPM + 'claude'], none), NPM + 'claude');
  assert.strictEqual(pickWindowsCli('', none), null);
  assert.strictEqual(pickWindowsCli('\r\n  \r\n', none), null);
  assert.strictEqual(pickWindowsCli(null, none), null);
});

test('a path with spaces and stray blank lines is kept whole', () => {
  const p = 'C:/Program Files/Claude Code/claude.cmd';
  assert.strictEqual(pickWindowsCli('\r\n' + p + '  \r\n', none), p);
});

// The real thing, on Windows only: files laid out as npm leaves them, found with where.exe, and
// started the way src/ai.js starts them. The bare script fails with ENOENT; the pick runs.
test('on Windows, the pick from a real npm-style folder starts and the bare script does not', { skip: process.platform !== 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nus-cli-pick-'));
  try {
    fs.writeFileSync(path.join(dir, 'claude'), '#!/bin/sh\nexec node cli.js "$@"\n');
    fs.writeFileSync(path.join(dir, 'claude.cmd'), '@ECHO off\r\necho shim-ran\r\n');
    fs.writeFileSync(path.join(dir, 'claude.ps1'), 'Write-Output ps\r\n');
    const env = { ...process.env, PATH: dir + ';' + path.join(process.env.SystemRoot || 'C:/Windows', 'System32') };
    const out = await new Promise((resolve) => {
      let text = '';
      const w = spawn('where.exe', ['claude'], { env, windowsHide: true });
      w.stdout.on('data', (d) => { text += d; });
      w.on('close', () => resolve(text));
    });
    const lines = out.split(/\r?\n/).filter(Boolean);
    assert.ok(lines.length >= 2 && !path.extname(lines[0]), 'where.exe lists the bare script first: ' + JSON.stringify(lines));

    const bare = await new Promise((resolve) => { const c = spawn(lines[0], [], { windowsHide: true }); c.on('error', (e) => resolve(e.code)); c.on('exit', () => resolve('ran')); });
    assert.strictEqual(bare, 'ENOENT');

    const picked = pickWindowsCli(out);
    assert.match(picked, /claude\.cmd$/i);
    const said = await new Promise((resolve) => {
      let text = '';
      const c = spawn('cmd.exe', ['/c', picked], { windowsHide: true });
      c.stdout.on('data', (d) => { text += d; });
      c.on('error', (e) => resolve('error ' + e.code));
      c.on('close', () => resolve(text.trim()));
    });
    assert.strictEqual(said, 'shim-ran');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
