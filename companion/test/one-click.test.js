// One-click update: only bytes that match the signed size and hash ever reach
// the installer step, and every failure leaves the app running and no file.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { createOneClick, download, INSTALLER_ARGS } = require('../src/one-click');

function bytes(n, fill = 7) { return Buffer.alloc(n, fill); }
function sha(b) { return crypto.createHash('sha512').update(b).digest('base64'); }
function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'nus-oneclick-')); }
function respond(buf, status = 200) { return async () => new Response(buf, { status }); }

function rig({ payload = bytes(4096), size, hash, fetchImpl, canRun = true, spawnError = null, update = true } = {}) {
  const dir = tmp();
  const calls = { spawn: [], quit: 0, states: [], before: [] };
  const channel = { update: () => (update ? { version: '0.1.16', installer: { url: 'https://x.test/s.exe', size: size == null ? payload.length : size, sha512: hash || sha(payload) } } : null) };
  const spawnImpl = (file, args, opts) => {
    calls.spawn.push({ file, args, opts, bytes: fs.readFileSync(file) });
    const child = new EventEmitter();
    child.unref = () => { calls.unref = true; };
    setImmediate(() => child.emit(spawnError ? 'error' : 'spawn', spawnError || undefined));
    return child;
  };
  const oc = createOneClick({ channel, dir, canRun, fetchImpl: fetchImpl || respond(payload), spawnImpl, quit: () => { calls.quit++; }, onState: s => calls.states.push(s.phase), beforeInstall: v => calls.before.push(v) });
  return { oc, dir, calls, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('a good download runs the installer silently, then quits, in that order', async () => {
  const payload = bytes(8192, 3);
  const r = rig({ payload });
  assert.equal(r.oc.available(), true);
  assert.equal(await r.oc.run(), true);
  assert.equal(r.calls.spawn.length, 1);
  assert.deepEqual(r.calls.spawn[0].args, INSTALLER_ARGS);
  assert.deepEqual(INSTALLER_ARGS, ['--updated', '/S', '--force-run']);
  assert.equal(r.calls.spawn[0].opts.detached, true);
  assert.ok(r.calls.spawn[0].bytes.equals(payload));
  assert.equal(r.calls.unref, true);
  assert.equal(r.calls.quit, 1);
  assert.deepEqual(r.calls.before, ['0.1.16']);
  assert.deepEqual([...new Set(r.calls.states)], ['downloading', 'installing']);
  r.oc.cleanup();
  assert.equal(fs.existsSync(r.dir), false);
  r.done();
});

test('a wrong hash, a short file, a long file, an error status and a dropped connection never reach spawn', async () => {
  const payload = bytes(4096);
  const cases = [
    { hash: sha(bytes(4096, 9)), why: /signed hash/ },
    { size: 8192, why: /smaller/ },
    { size: 100, why: /larger/ },
    { fetchImpl: respond('nope', 404), why: /answered 404/ },
    { fetchImpl: async () => { throw new Error('offline'); }, why: /offline/ },
  ];
  for (const c of cases) {
    const r = rig({ payload, ...c });
    assert.equal(await r.oc.run(), false);
    assert.equal(r.calls.spawn.length, 0);
    assert.equal(r.calls.quit, 0, 'the app stays up');
    assert.equal(r.oc.state().phase, 'failed');
    assert.match(r.oc.state().error, c.why);
    assert.deepEqual(fs.existsSync(r.dir) ? fs.readdirSync(r.dir) : [], [], 'nothing is left behind');
    r.done();
  }
});

test('an installer Windows refuses to start leaves the app running and says so', async () => {
  const r = rig({ spawnError: Object.assign(new Error('blocked'), { code: 'EPERM' }) });
  assert.equal(await r.oc.run(), false);
  assert.equal(r.calls.quit, 0);
  assert.equal(r.oc.state().phase, 'failed');
  r.done();
});

test('a portable copy or dev run never updates itself, and neither does a file with no installer', async () => {
  const portable = rig({ canRun: false });
  assert.equal(portable.oc.available(), false);
  assert.equal(await portable.oc.run(), false);
  assert.equal(portable.calls.spawn.length, 0);
  portable.done();
  const none = rig({ update: false });
  assert.equal(none.oc.available(), false);
  assert.equal(await none.oc.run(), false);
  none.done();
});

test('two clicks are one run', async () => {
  const r = rig();
  const [a, b] = await Promise.all([r.oc.run(), r.oc.run()]);
  assert.equal(a, true); assert.equal(b, true);
  assert.equal(r.calls.spawn.length, 1);
  assert.equal(r.calls.quit, 1);
  r.done();
});

test('progress is reported in whole percents and the file lands under its own name', async () => {
  const dir = tmp();
  const payload = bytes(1000);
  const seen = [];
  const dest = path.join(dir, 'a', 's.exe');
  await download({ url: 'https://x.test', dest, size: payload.length, sha512: sha(payload), fetchImpl: respond(payload), onProgress: p => seen.push(p) });
  assert.ok(fs.readFileSync(dest).equals(payload));
  assert.equal(seen[seen.length - 1], 100);
  assert.equal(fs.existsSync(dest + '.part'), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
