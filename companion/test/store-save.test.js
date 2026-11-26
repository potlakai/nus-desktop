'use strict';
// A switch either reaches the disk or the person hears it did not, a failed read or
// write says why, and a file that could not be read is never replaced by the defaults
// without a copy (live 2026-11-03: the file unchanged for two weeks, in silence).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const root = path.resolve(__dirname, '..');
const storeFile = path.join(root, 'src', 'store.js');

// A fresh store over a fake electron, with what it logs.
function rig({ encrypt, decrypt, available = true, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nus-store-')) } = {}) {
  const logs = [];
  const safeStorage = {
    isEncryptionAvailable: () => available,
    encryptString: encrypt || ((s) => Buffer.from(s)),
    decryptString: decrypt || ((b) => b.toString()),
  };
  const fake = { app: { getPath: (n) => (n === 'userData' ? dir : path.join(dir, 'appdata')) }, safeStorage };
  const load = Module._load;
  Module._load = function (req, ...rest) { return req === 'electron' ? fake : load.call(this, req, ...rest); };
  delete require.cache[storeFile];
  let store;
  try { store = require(storeFile); } finally { Module._load = load; }
  store.setStandalone(true);
  const log = console.log;
  const quiet = (fn) => { console.log = (...a) => logs.push(a.join(' ')); try { return fn(); } finally { console.log = log; } };
  return { store, dir, logs, quiet, file: path.join(dir, 'companion-settings.json'), safeStorage };
}
const sealed = (o) => JSON.stringify({ encrypted: true, payload: Buffer.from(JSON.stringify(o)).toString('base64') });
const onDisk = (file) => JSON.parse(Buffer.from(JSON.parse(fs.readFileSync(file, 'utf8')).payload, 'base64').toString());

test('a good file: read, a switch saved, the boot line says so', () => {
  const r = rig();
  fs.writeFileSync(r.file, sealed({ hands: true, hideFromCapture: true, apiKeys: { anthropic: 'sk-secret' } }));
  r.quiet(() => {
    assert.equal(r.store.getSettings().hands, true);
    const line = r.store.statusLine();
    assert.match(line, /read ok, hands true, tasks false, island false, hide from capture true$/);
    assert.ok(line.includes(r.file));
    assert.doesNotMatch(line, /secret/);
    r.store.setSettings({ tasks: true });
  });
  assert.equal(r.store.saveError(), '');
  assert.equal(onDisk(r.file).tasks, true);
  assert.equal(onDisk(r.file).apiKeys.anthropic, 'sk-secret');
  assert.deepEqual(fs.readdirSync(r.dir).filter((f) => /unreadable/.test(f)), []);
  assert.ok(r.logs.some((l) => l.startsWith('[settings] saved ')));
});

test('no file yet is a first run, not a failure', () => {
  const r = rig();
  r.quiet(() => {
    assert.match(r.store.statusLine(), /read new, hands false/);
    r.store.setSettings({ hands: true });
  });
  assert.equal(r.logs.filter((l) => /could not/.test(l)).length, 0);
  assert.equal(onDisk(r.file).hands, true);
  assert.deepEqual(fs.readdirSync(r.dir).filter((f) => /unreadable/.test(f)), []);
});

test('a file that cannot be decrypted: says why, runs on the defaults, and is copied aside before the first save', () => {
  const r = rig({ decrypt: () => { throw new Error('Decryption is not available'); } });
  const before = sealed({ hands: true, apiKeys: { anthropic: 'sk-secret' } });
  fs.writeFileSync(r.file, before);
  r.quiet(() => {
    assert.equal(r.store.getSettings().hands, false, 'the defaults, for this run');
    assert.match(r.store.statusLine(), /read failed \(Decryption is not available\), hands false/);
    assert.equal(fs.readFileSync(r.file, 'utf8'), before, 'reading alone changes nothing');
    r.store.setSettings({ tasks: true });
    r.store.setSettings({ sounds: false });
  });
  assert.ok(r.logs.some((l) => /could not read .*Decryption is not available/.test(l)));
  const copies = fs.readdirSync(r.dir).filter((f) => /companion-settings\.json\.unreadable-\d+$/.test(f));
  assert.equal(copies.length, 1, 'one copy, however many saves');
  assert.equal(fs.readFileSync(path.join(r.dir, copies[0]), 'utf8'), before, 'the keys are still in it');
  assert.equal(onDisk(r.file).tasks, true);
});

test('if that copy cannot be made, the file is not written over', () => {
  const r = rig({ decrypt: () => { throw new Error('nope'); } });
  const before = sealed({ apiKeys: { anthropic: 'sk-secret' } });
  fs.writeFileSync(r.file, before);
  const copy = fs.copyFileSync;
  fs.copyFileSync = () => { throw new Error('disk full'); };
  try { r.quiet(() => { r.store.getSettings(); r.store.setSettings({ tasks: true }); }); } finally { fs.copyFileSync = copy; }
  assert.equal(fs.readFileSync(r.file, 'utf8'), before);
  assert.equal(r.store.saveError(), 'disk full');
  assert.equal(r.store.getSettings().tasks, true, 'it holds for this run');
});

test('a torn file is reported without quoting it: it may hold keys', () => {
  const r = rig();
  fs.writeFileSync(r.file, '{"apiKeys":{"anthropic":"sk-secret"');
  const line = r.quiet(() => r.store.statusLine());
  assert.match(line, /read failed \(not valid JSON\)/);
  assert.doesNotMatch(line + r.logs.join(' '), /secret/);
});

test('a failed encrypt and a failed write are each logged with the message, and the next good save clears it', () => {
  const r = rig({ encrypt: () => { throw new Error('Error while encrypting'); } });
  r.quiet(() => { r.store.getSettings(); r.store.setSettings({ hands: true }); });
  assert.equal(r.store.saveError(), 'Error while encrypting');
  assert.ok(r.logs.some((l) => l.includes('could not save ' + r.file + ': Error while encrypting')));
  assert.equal(r.store.getSettings().hands, true, 'the switch holds for this run');
  assert.equal(fs.existsSync(r.file), false);

  const w = rig();
  fs.mkdirSync(w.file);   // nothing can write here
  w.quiet(() => { w.store.setSettings({ hands: true }); });
  assert.match(w.store.saveError(), /EISDIR|EPERM|EACCES|illegal operation/i);
  assert.ok(w.logs.some((l) => l.includes('could not save ')));
  fs.rmdirSync(w.file);
  w.quiet(() => { w.store.setSettings({ tasks: true }); });
  assert.equal(w.store.saveError(), '');
  assert.equal(onDisk(w.file).hands, true, 'nothing was lost: the whole object goes');
});

test('no encryption on this machine: plain text as before, and it says so once', () => {
  const r = rig({ available: false });
  r.quiet(() => { r.store.setSettings({ hands: true }); r.store.setSettings({ tasks: true }); });
  assert.equal(JSON.parse(fs.readFileSync(r.file, 'utf8')).tasks, true);
  assert.equal(r.logs.filter((l) => /saving as plain text/.test(l)).length, 1);
});

test('the person hears about a switch that did not save, and every run logs the state', () => {
  const main = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
  const apply = main.slice(main.indexOf('function applySettingsPatch(patch)'), main.indexOf('// The voice switch: the renderer must know'));
  assert.ok(apply.indexOf('store.setSettings(patch)') < apply.indexOf('noteSettingsSave()'));
  const note = main.slice(main.indexOf('function noteSettingsSave()'), main.indexOf('function applySettingsPatch(patch)'));
  assert.match(note, /routeLog\('settings not saved: ' \+ failed\); flash\('That holds for now, but I could not save it\.', 4000\);/);
  assert.match(note, /routeLog\('settings saved'\);/);
  assert.match(main, /hooks = providedHooks;\n\s*routeLog\(store\.statusLine\(\)\);/, 'at boot');
  assert.match(fs.readFileSync(path.join(root, '..', 'src', 'main-companion.js'), 'utf8'), /\[settings\] from the account: /, 'a switch set by the account says so');
});
