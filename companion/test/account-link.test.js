const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createLink, CONSENT, CONSENT_VERSION } = require('../src/account-link');

const root = path.resolve(__dirname, '../..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8').replace(/\r\n/g, '\n');
const ID = '3f2b8c1e-5a4d-4c7b-9e2f-1a2b3c4d5e6f';

// A signed-in account whose call() answers from a table, and the remembered
// link in a variable.
function rig(opts = {}) {
  const calls = [];
  let signedIn = opts.signedIn !== false;
  let mem = opts.mem || null;
  let statsOn = opts.statsOn !== false;
  const answers = opts.answers || {};
  const account = {
    status: () => ({ signedIn, userId: signedIn ? (opts.userId || 'u1') : '' }),
    call: async (p, init = {}) => { calls.push({ path: p, method: init.method || 'POST', body: init.body }); const a = answers[(init.method || 'POST') + ' ' + p]; return typeof a === 'function' ? a() : (a || { status: 200, json: {} }); },
    signOut: async () => { signedIn = false; return account.status(); },
  };
  const link = createLink({ account, installId: () => (statsOn ? ID : null), memory: { get: () => mem, set: v => { mem = v; } }, appVersion: '0.1.15', platform: 'win32' });
  return { link, calls, mem: () => mem, statsOff: () => { statsOn = false; }, account };
}

test('the consent words are the ones Pranav approved, without em dashes', () => {
  assert.equal(CONSENT, "Signing in links this computer's anonymous stats to your Google account so your settings can follow you and Pranav can help if you write in. Unlink or delete any time.");
  assert.equal(CONSENT_VERSION, '2026-10-31');
  assert.match(read('accounts-server/functions/link-install/index.ts'), new RegExp("CONSENT_VERSIONS = new Set\\(\\['" + CONSENT_VERSION + "'\\]\\)"));
  assert.doesNotMatch(CONSENT, /—/);
});

test('link sends the install id, consent version, version and platform, and nothing else', async () => {
  const r = rig();
  assert.equal((await r.link.link()).link, 'linked');
  assert.equal(r.calls.length, 1);
  assert.deepEqual(r.calls[0], { path: '/functions/v1/link-install', method: 'POST', body: { install_id: ID, consent_version: CONSENT_VERSION, app_version: '0.1.15', platform: 'win32' } });
  assert.equal(r.mem().installId, ID);
  // Already linked: a later launch sends nothing.
  await r.link.ensure();
  assert.equal(r.calls.length, 1);
});

test('stats off: nothing is linked and the id never leaves', async () => {
  const r = rig({ statsOn: false });
  assert.equal((await r.link.link()).link, 'stats_off');
  assert.equal(r.calls.length, 0);
});

test('signed out: no call at all', async () => {
  const r = rig({ signedIn: false });
  assert.equal((await r.link.ensure()).link, 'signed_out');
  assert.equal(r.calls.length, 0);
});

test('offline: pending, no error shown, retried at the next ensure', async () => {
  let down = true;
  const r = rig({ answers: { 'POST /functions/v1/link-install': () => (down ? { status: 0 } : { status: 200 }) } });
  const s = await r.link.link();
  assert.deepEqual(s, { link: 'pending', linkError: '' });
  down = false;
  assert.equal((await r.link.ensure()).link, 'linked');
});

test('another account on the same computer links again', async () => {
  const r = rig({ userId: 'u2', mem: { userId: 'u1', installId: ID, consent: CONSENT_VERSION } });
  assert.equal(r.link.status().link, 'pending');
  await r.link.ensure();
  assert.equal(r.calls.length, 1);
  assert.equal(r.mem().userId, 'u2');
});

test('too many computers says so', async () => {
  const r = rig({ answers: { 'POST /functions/v1/link-install': { status: 409 } } });
  assert.match((await r.link.link()).linkError, /20 computers/);
});

test('unlink deletes the link and the next launch does not relink', async () => {
  const r = rig({ mem: { userId: 'u1', installId: ID, consent: CONSENT_VERSION } });
  const s = await r.link.unlink();
  assert.equal(s.link, 'unlinked');
  assert.deepEqual(r.calls[0], { path: '/functions/v1/link-install', method: 'DELETE', body: { install_id: ID } });
  await r.link.ensure();
  assert.equal(r.calls.length, 1);
  // A fresh sign-in clears the choice; then linking is allowed again.
  r.link.forget();
  assert.equal((await r.link.ensure()).link, 'linked');
});

test('unlink offline keeps the link and says why', async () => {
  const r = rig({ mem: { userId: 'u1', installId: ID, consent: CONSENT_VERSION }, answers: { 'DELETE /functions/v1/link-install': { status: 0 } } });
  const s = await r.link.unlink();
  assert.equal(s.link, 'linked');
  assert.match(s.linkError, /could not reach/);
});

test('delete account: the server deletes, this computer signs out, the anonymous install stays', async () => {
  const r = rig({ mem: { userId: 'u1', installId: ID, consent: CONSENT_VERSION } });
  assert.deepEqual(await r.link.deleteAccount(), { ok: true });
  assert.equal(r.calls[0].path, '/functions/v1/delete-account');
  assert.equal(r.account.status().signedIn, false);
  assert.equal(r.mem(), null);
});

test('delete account refuses while a plan runs, and offline', async () => {
  const paid = rig({ answers: { 'POST /functions/v1/delete-account': { status: 409 } } });
  assert.match((await paid.link.deleteAccount()).error, /Cancel your Nūs plan/);
  assert.equal(paid.account.status().signedIn, true);
  const off = rig({ answers: { 'POST /functions/v1/delete-account': { status: 0 } } });
  assert.match((await off.link.deleteAccount()).error, /could not reach/);
});

test('server files: written, not deployed; RLS reads own rows only and clients cannot write', () => {
  const sql = read('accounts-server/migrations/2026-11-01-a-install-links.sql');
  assert.match(sql, /install_id\s+uuid primary key/);
  assert.match(sql, /references auth\.users\(id\) on delete cascade/);
  assert.match(sql, /alter table public\.install_links enable row level security/);
  assert.match(sql, /for select\s+using \(auth\.uid\(\) = user_id\)/);
  assert.doesNotMatch(sql, /for (insert|update|delete|all)/i);
  assert.match(sql, /revoke insert, update, delete on public\.install_links from anon, authenticated/);
  for (const f of ['link-install', 'delete-account']) {
    const ts = read('accounts-server/functions/' + f + '/index.ts');
    assert.match(ts, /JWT verification ON/);
    assert.match(ts, /auth\.getUser\(jwt\)/);
    assert.doesNotMatch(ts, /—/);
  }
  const main = read('src/main-companion.js');
  for (const ch of ['account:unlink', 'account:delete']) assert.match(main, new RegExp("handle\\('home:" + ch + "'"));
  const html = read('companion/home/index.html');
  assert.match(html, /id="account-consent"/);
  assert.ok(html.includes(CONSENT.replace("'", '&#39;')) || html.includes(CONSENT), 'the card shows the approved consent words');
});
