const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createEntitlement, CACHE_KEY } = require('../src/entitlement');
const { OFFLINE_GRACE_MS } = require('../../src/license');

const root = path.resolve(__dirname, '../..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8').replace(/\r\n/g, '\n');
const HOUR = 3600000;

function vault(available = true) {
  const m = new Map();
  return { m, available: () => available, get: k => (m.has(k) ? m.get(k) : null), set: (k, v) => { m.set(k, v); }, remove: k => { m.delete(k); } };
}

function rig(opts = {}) {
  const clock = { t: Date.parse('2026-11-01T10:00:00Z') };
  const calls = [];
  let down = false;
  let signedIn = opts.signedIn !== false;
  let token = opts.token === undefined ? 'at1' : opts.token;
  const row = opts.row || { plan: 'free', status: 'none', is_pro: false, current_period_end: null, cancel_at_period_end: false };
  const fetch = async (url, init) => {
    calls.push({ url, headers: init.headers });
    if (down) throw new Error('fetch failed');
    return { ok: true, status: 200, json: async () => [row] };
  };
  const account = { status: () => ({ signedIn, userId: signedIn ? 'u1' : '' }), accessToken: async () => (signedIn ? token : null) };
  const secrets = opts.secrets || vault();
  const ent = createEntitlement({ account, secrets, fetch, now: () => clock.t, url: 'https://p.example', anonKey: 'anon' });
  return { ent, calls, clock, secrets, setDown: v => { down = v; }, setToken: v => { token = v; }, signOut: () => { signedIn = false; } };
}

const PRO = { plan: 'pro', status: 'active', is_pro: true, current_period_end: '2026-12-01T00:00:00Z', cancel_at_period_end: false };

test('signed out: free and no network call', async () => {
  const r = rig({ signedIn: false });
  assert.deepEqual(await r.ent.refresh(), { plan: 'free', isPro: false, planSource: 'signed_out', planUntil: null });
  assert.equal(r.calls.length, 0);
});

test('online: the entitlement RPC with the bearer, free by default', async () => {
  const r = rig();
  const s = await r.ent.refresh();
  assert.deepEqual([s.plan, s.planSource], ['free', 'online']);
  assert.equal(r.calls[0].url, 'https://p.example/rest/v1/rpc/entitlement');
  assert.equal(r.calls[0].headers.Authorization, 'Bearer at1');
});

test('a paid plan is cached encrypted and survives 72 hours offline, then reads as free', async () => {
  const r = rig({ row: PRO });
  assert.equal((await r.ent.refresh()).plan, 'pro');
  assert.ok(r.secrets.get(CACHE_KEY));
  r.setDown(true);
  r.clock.t += 71 * HOUR;
  const cached = await r.ent.refresh();
  assert.deepEqual([cached.plan, cached.planSource], ['pro', 'offline_cache']);
  r.clock.t += 2 * HOUR;
  assert.ok(r.clock.t - Date.parse('2026-11-01T10:00:00Z') > OFFLINE_GRACE_MS);
  assert.equal((await r.ent.refresh()).plan, 'free');
});

test('no token (refresh failed offline) takes the offline path without a request', async () => {
  const r = rig({ row: PRO });
  await r.ent.refresh();
  const before = r.calls.length;
  r.setToken(null);
  r.clock.t += HOUR;
  const s = await r.ent.refresh();
  assert.deepEqual([s.plan, s.planSource], ['pro', 'offline_cache']);
  assert.equal(r.calls.length, before);
});

test('no encryption on the PC: nothing cached, an offline paid plan reads as free', async () => {
  const secrets = vault(false);
  const r = rig({ row: PRO, secrets });
  assert.equal((await r.ent.refresh()).plan, 'pro');
  assert.equal(secrets.m.size, 0);
  r.setDown(true);
  assert.equal((await r.ent.refresh()).plan, 'free');
});

test('clear drops the cached plan', async () => {
  const r = rig({ row: PRO });
  await r.ent.refresh();
  r.ent.clear();
  assert.equal(r.secrets.get(CACHE_KEY), null);
});

test('wiring: license.js is packed with the Companion, nothing is gated, Home shows the plan', () => {
  const builder = read('electron-builder.companion.config.js');
  assert.match(builder, /'src\/license\.js'/);
  assert.match(builder, /'!node_modules\/@supabase\/\*\*'/, 'still no SDK in the Companion build');
  const main = read('src/main-companion.js');
  assert.match(main, /getEntitlement\(\)\.refresh\(\)/);
  assert.doesNotMatch(main, /isPro\s*\?|\.isPro\)/, 'no feature reads the plan yet');
  assert.match(read('companion/home/index.html'), /id="account-plan"/);
});
