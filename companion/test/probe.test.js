// The Windows probe: protocol handling with a fake sidecar (no PowerShell),
// plus the contract that ships it and wires it. The real sidecar is checked
// by hand with `node scripts/probe-check.js`.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const { createProbe, scriptPath } = require('../src/win/probe');
const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

function fakeSpawn() {
  const calls = [];
  const children = [];
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.written = [];
    child.stdin = { destroyed: false, write: (s) => { child.written.push(JSON.parse(s)); return true; }, end: () => {} };
    child.kill = () => { child.emit('exit', 0, null); };
    child.reply = (obj) => child.stdout.write(JSON.stringify(obj) + '\n');
    child.answerNext = (extra = {}) => {
      const last = child.written[child.written.length - 1];
      child.reply(Object.assign({ id: last.id }, extra));
      return last;
    };
    children.push(child);
    return child;
  };
  return { spawn, calls, children };
}

const tick = () => new Promise((r) => setImmediate(r));

test('the probe only ever starts on Windows and degrades to unavailable elsewhere', () => {
  const { spawn, calls } = fakeSpawn();
  const probe = createProbe({ spawn, platform: 'darwin', script: 'x.ps1' });
  probe.start();
  assert.equal(calls.length, 0);
  assert.equal(probe.available, false);
  probe.stop();
});

test('availability is gated on the ping, requests round-trip by id, events are emitted', async () => {
  const { spawn, calls, children } = fakeSpawn();
  const probe = createProbe({ spawn, platform: 'win32', script: 'C:\\probe.ps1' });
  const seen = [];
  probe.on('availability', (v) => seen.push(v));
  probe.start();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'powershell.exe');
  assert.deepEqual(calls[0].args.slice(0, 4), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass']);
  assert.equal(calls[0].opts.windowsHide, true, 'never a console window');
  const child = children[0];
  assert.equal(child.written[0].op, 'ping');
  assert.equal(probe.available, false, 'not available before the ping answers');
  child.reply({ ev: 'ready', pid: 4242 });
  child.answerNext({ ok: true, pid: 4242, ps: '5.1' });
  await tick(); await tick();
  assert.equal(probe.available, true);
  assert.deepEqual(seen, [true]);
  assert.equal(probe.status().pid, 4242);

  const p = probe.request('fg', {});
  const sent = child.written[child.written.length - 1];
  assert.equal(sent.op, 'fg');
  child.reply({ id: sent.id, title: 'Canvas', process: 'chrome' });
  const r = await p;
  assert.equal(r.title, 'Canvas');

  const errored = probe.request('uia.list', { hwnd: 1 });
  child.answerNext({ error: 'boom' });
  await assert.rejects(errored, /boom/);

  const events = [];
  probe.on('click', (e) => events.push(e));
  child.reply({ ev: 'click', x: 10, y: 20 });
  await tick();
  assert.deepEqual(events, [{ ev: 'click', x: 10, y: 20 }]);
  probe.stop();
});

test('watch is explicit and stops; an exit fails pending requests and drops availability', async () => {
  const { spawn, children } = fakeSpawn();
  const probe = createProbe({ spawn, platform: 'win32', script: 'C:\\probe.ps1' });
  probe.start();
  const child = children[0];
  child.reply({ ev: 'ready', pid: 1 });
  child.answerNext({ ok: true, pid: 1 });
  await tick(); await tick();
  const w = probe.watch({ keys: [27] });
  const sent = child.answerNext({ ok: true, watching: true });
  assert.equal(sent.op, 'watch.start');
  assert.deepEqual(sent.keys, [27]);
  assert.equal(sent.click, true);
  await w;
  assert.deepEqual(probe.status().watching, { keys: [27], click: true, fg: true });
  const hanging = probe.request('fg', {});
  child.emit('exit', 1, null);
  await assert.rejects(hanging, /exited/);
  assert.equal(probe.available, false);
  assert.equal(probe.status().watching, null);
  probe.stop();
});

test('the sidecar ships outside the asar and is wired into the Companion', () => {
  const ps1 = read('src', 'win', 'probe.ps1');
  for (const op of ["'ping'", "'fg'", "'uia.list'", "'uia.frompoint'", "'uia.find'", "'watch.start'", "'watch.stop'"]) assert.match(ps1, new RegExp(op.replace(/\./g, '\\.')), op);
  assert.match(ps1, /SetProcessDpiAwarenessContext/, 'physical pixels, per-monitor aware');
  assert.match(ps1, /ignorePid/, 'point lookup skips the overlay window');
  assert.doesNotMatch(ps1, /SetCursorPos|mouse_event|SendInput|keybd_event/, 'the probe never clicks or types');
  assert.equal(scriptPath(null), path.join(root, 'src', 'win', 'probe.ps1'));
  const builder = fs.readFileSync(path.join(root, '..', 'electron-builder.config.js'), 'utf8');
  assert.match(builder, /from: 'companion\/src\/win', to: 'win', filter: \['\*\.ps1'\]/);
  const main = read('index.js');
  assert.match(main, /function startProbe\(\)/);
  assert.match(main, /process\.platform !== 'win32'\) return;/);
  assert.match(main, /ignorePid: process\.pid/);
  assert.match(main, /stopProbe\(\);/);
  const screen = read('src', 'screen.js');
  assert.match(screen, /async function captureDisplay\(displayId, opts = \{\}\)/);
  assert.match(screen, /maxSide/);
});
