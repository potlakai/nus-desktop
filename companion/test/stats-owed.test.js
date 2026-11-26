// A hello (app_open) or an engaged that got no answer from the server is owed,
// not lost. Until 0.1.29 the day was marked done before the send: a laptop lid
// opened before Wi-Fi was back, or a start at sign-in before the network, lost
// that day's rows for the rest of the process. Found on the 2026-11-16
// retention read, where installs showed more engaged days than open days.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStats } = require('../src/stats');

const DAY = 24 * 3600 * 1000;
function rig(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nus-stats-owed-'));
  const calls = [];
  const net = { up: true, status: 204 };
  let settings = { sendStats: true };
  const fetch = async (url, init) => {
    if (!net.up) throw new Error('net::ERR_INTERNET_DISCONNECTED');
    calls.push(JSON.parse(init.body));
    return { status: net.status };
  };
  const clock = { t: Date.parse('2026-11-12T20:00:00Z') };
  const timeouts = [];
  const stats = createStats({ userData: dir, settings: { get: () => settings, set: p => { settings = { ...settings, ...p }; } },
    appVersion: '0.1.30', platform: 'win32', packaged: true, env: {}, fetch, now: () => clock.t,
    setInterval: () => ({ unref() {} }), clearInterval() {},
    setTimeout: (fn, ms) => { const t = { fn, ms, unref() {} }; timeouts.push(t); return t; }, clearTimeout: t => { const i = timeouts.indexOf(t); if (i >= 0) timeouts.splice(i, 1); },
    ...opts });
  const named = name => calls.filter(c => c.name === name);
  // The short retry timer coming due.
  const fire = async () => { const due = timeouts.splice(0); for (const t of due) await t.fn(); await new Promise(r => setImmediate(r)); };
  return { stats, calls, net, clock, timeouts, named, fire, setSettings: p => { settings = { ...settings, ...p }; }, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('a lid opened before Wi-Fi is back: the day check says hello again once the network answers', async () => {
  const r = rig();
  await r.stats.boot({ via: 'manual' });
  assert.equal(r.named('app_open').length, 1);
  r.net.up = false; r.clock.t += 18 * 3600 * 1000;            // 14:00 UTC the next day, offline
  await r.stats.tick();
  assert.equal(r.named('app_open').length, 1, 'nothing reached the server');
  r.net.up = true; r.clock.t += 15 * 60 * 1000;
  await r.stats.tick();
  assert.equal(r.named('app_open').length, 2, 'the same day is said once the network is back');
  assert.equal(r.named('app_open')[1].props.via, undefined, 'a day check still carries no via');
  await r.stats.tick(); await r.stats.tick();
  assert.equal(r.named('app_open').length, 2, 'and only once');
  r.done();
});

test('a start at sign-in with no network: the hello is owed and keeps its via', async () => {
  const r = rig();
  r.net.up = false;
  await r.stats.boot({ via: 'login' });
  assert.equal(r.calls.length, 0);
  assert.equal(r.timeouts.length, 1, 'one short retry is set');
  assert.equal(r.timeouts[0].ms, 45000);
  r.net.up = true;
  await r.fire();
  assert.deepEqual(r.named('app_open').map(c => c.props.via), ['login']);
  await r.fire(); await r.stats.tick();
  assert.equal(r.named('app_open').length, 1);
  r.done();
});

test('offline for the whole day: the owed hello is dropped, the next day says its own', async () => {
  const r = rig();
  r.net.up = false;
  await r.stats.boot({ via: 'login' });
  await r.stats.tick();
  r.net.up = true; r.clock.t += DAY;
  await r.stats.tick(); await r.stats.tick();
  assert.equal(r.named('app_open').length, 1, 'one hello for the new day, none back-dated');
  assert.equal(r.named('app_open')[0].props.via, undefined);
  r.done();
});

test('a server that answers 5xx is a miss too; a 4xx is an answer', async () => {
  const r = rig();
  r.net.status = 503;
  await r.stats.boot();
  const before = r.named('app_open').length;
  r.net.status = 204; r.clock.t += 15 * 60 * 1000;
  await r.stats.tick();
  assert.equal(r.named('app_open').length, before + 1, 'asked again after a 503');
  const s = rig();
  s.net.status = 400;
  await s.stats.boot();
  const taken = s.named('app_open').length;
  await s.stats.tick();
  assert.equal(s.named('app_open').length, taken, 'a refusal is not asked again');
  assert.equal(s.timeouts.length, 0);
  r.done(); s.done();
});

test('an engaged that got no answer is said by the next action, at most once a minute', async () => {
  const r = rig();
  await r.stats.boot();
  r.net.up = false;
  await r.stats.engaged();
  r.net.up = true;
  await r.stats.engaged();
  assert.equal(r.named('engaged').length, 0, 'not again within the minute');
  r.clock.t += 61 * 1000;
  await r.stats.engaged();
  assert.equal(r.named('engaged').length, 1);
  await r.stats.engaged();
  assert.equal(r.named('engaged').length, 1, 'once per day');
  r.done();
});

test('an owed engaged goes out at the day check even if the person never acts again', async () => {
  const r = rig();
  await r.stats.boot();
  r.net.up = false;
  await r.stats.engaged();
  r.net.up = true; r.clock.t += 15 * 60 * 1000;
  await r.stats.tick(); await new Promise(res => setImmediate(res));
  assert.equal(r.named('engaged').length, 1);
  r.done();
});

test('the day check never makes an engaged on its own, and an owed one does not cross midnight', async () => {
  const r = rig();
  await r.stats.boot();
  r.clock.t += DAY; await r.stats.tick();
  assert.equal(r.named('engaged').length, 0, 'a Knot left running is not engaged');
  r.net.up = false;
  await r.stats.engaged();                                       // acted, offline
  r.net.up = true; r.clock.t += DAY;
  await r.stats.tick(); await new Promise(res => setImmediate(res));
  assert.equal(r.named('engaged').length, 0, 'yesterday is not said as today');
  r.done();
});

test('stats off: nothing is owed and no timer is set', async () => {
  const r = rig();
  r.setSettings({ sendStats: false });
  await r.stats.boot(); await r.stats.engaged(); await r.stats.tick();
  assert.equal(r.calls.length, 0);
  assert.equal(r.timeouts.length, 0);
  r.done();
});

test('stop clears the retry timer', async () => {
  const r = rig();
  r.net.up = false;
  await r.stats.boot();
  assert.equal(r.timeouts.length, 1);
  await r.stats.stop();
  assert.equal(r.timeouts.length, 0);
  r.done();
});
