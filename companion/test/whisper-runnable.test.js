'use strict';
// src/whisper-server.js runnableCopy: on a Mac the bundled whisper runs from a copy in the data
// folder (files the app writes carry no download quarantine flag); elsewhere nothing changes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runnableCopy } = require('../../src/whisper-server');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nus-wr-'));
  const app = path.join(root, 'Resources', 'whisper'); fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(app, 'whisper-cli'), 'cli-v1');
  fs.writeFileSync(path.join(app, 'whisper-server'), 'server-v1');
  return { root, cli: path.join(app, 'whisper-cli'), userData: path.join(root, 'profile') };
}

test('a Mac copies whisper-cli and whisper-server into the data folder and runs the copy', () => {
  const f = fixture();
  const out = runnableCopy(f.cli, f.userData, { platform: 'darwin' });
  assert.notEqual(out, f.cli);
  assert.ok(out.startsWith(path.join(f.userData, 'whisper-bin')));
  assert.equal(fs.readFileSync(out, 'utf8'), 'cli-v1');
  assert.equal(fs.readFileSync(path.join(path.dirname(out), 'whisper-server'), 'utf8'), 'server-v1', 'the server sits beside the copy');
  if (process.platform !== 'win32') assert.ok(fs.statSync(out).mode & 0o100, 'executable');
  assert.equal(runnableCopy(f.cli, f.userData, { platform: 'darwin' }), out, 'the same copy next time');
});

test('a changed app copy gets a fresh data-folder copy', () => {
  const f = fixture();
  const first = runnableCopy(f.cli, f.userData, { platform: 'darwin' });
  fs.writeFileSync(f.cli, 'cli-v2-longer');
  const second = runnableCopy(f.cli, f.userData, { platform: 'darwin' });
  assert.notEqual(second, first);
  assert.equal(fs.readFileSync(second, 'utf8'), 'cli-v2-longer');
});

test('Windows, no data folder, or a failed copy: the original path', () => {
  const f = fixture();
  assert.equal(runnableCopy(f.cli, f.userData, { platform: 'win32' }), f.cli);
  assert.equal(runnableCopy(f.cli, null, { platform: 'darwin' }), f.cli);
  const broken = { existsSync: () => true, statSync: () => { throw new Error('no'); } };
  assert.equal(runnableCopy(f.cli, f.userData, { platform: 'darwin', fsImpl: broken }), f.cli);
});
