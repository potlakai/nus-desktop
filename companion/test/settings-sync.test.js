const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createSync, pick, KEYS } = require('../src/settings-sync');

const root = path.resolve(__dirname, '../..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8').replace(/\r\n/g, '\n');

// The account's row, merged per key by the later `at`, like put_settings.
function server() {
  const row = { settings: {}, version: 0 };
  const calls = [];
  let down = false;
  const call = async (p, init = {}) => {
    calls.push({ path: p, method: init.method || 'POST', body: init.body });
    if (down) return { status: 0, json: null };
    if (p.startsWith('/rest/v1/user_settings')) return { status: 200, json: row.version ? [JSON.parse(JSON.stringify(row))] : [] };
    if (p === '/rest/v1/rpc/put_settings') {
      for (const [k, e] of Object.entries(init.body.patch)) {
        assert.ok(KEYS.includes(k), 'only allowlisted keys reach the server: ' + k);
        if (k === 'hands') assert.equal(e.v, false, 'Hands syncs off only');
        if (!row.settings[k] || e.at > row.settings[k].at) row.settings[k] = { v: e.v, at: e.at };
      }
      row.version += 1;
      return { status: 200, json: { settings: row.settings, version: row.version } };
    }
    return { status: 404, json: null };
  };
  return { row, calls, call, setDown: v => { down = v; } };
}

// One computer: its settings object, the apply path, the sync state.
function computer(srv, settings, clock, userId = 'u1') {
  let s = JSON.parse(JSON.stringify(settings));
  let mem = null;
  const account = { status: () => ({ signedIn: true, userId }), call: srv.call };
  const apply = patch => {
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'ptt') s.shortcuts = { ...s.shortcuts, ptt: v };
      else s[k] = v;
    }
  };
  const sync = createSync({ account, settings: () => s, apply, memory: { get: () => mem, set: v => { mem = v; } }, now: () => clock.t });
  return { sync, get: () => s, set: patch => { s = { ...s, ...patch }; }, mem: () => mem };
}

const BASE = {
  shortcuts: { ptt: 'CommandOrControl+Alt+Space', assist: 'CommandOrControl+Return' }, voice: 'system', knotIsland: false, knotCorner: 'br',
  proactive: true, sounds: true, focusGuard: null, focusGuardFeeds: ['Instagram', 'Reels'], hands: false,
  apiKeys: { gemini: 'AIzaSECRET', anthropic: 'sk-ant-SECRET' }, vaultPath: 'C:\\Users\\x\\vault', resumeContext: 'my résumé', watchFolder: 'C:\\w', packPath: 'p', sparPath: 's',
};

test('only the allowlisted settings can ever leave', () => {
  const p = pick(BASE);
  assert.deepEqual(Object.keys(p).sort(), ['focusGuardFeeds', 'hands', 'knotCorner', 'knotIsland', 'proactive', 'ptt', 'sounds', 'voice']);
  const text = JSON.stringify(p);
  for (const secret of ['SECRET', 'vault', 'résumé', 'C:\\\\w', 'assist']) assert.equal(text.includes(secret), false, secret);
  assert.equal('hands' in pick({ ...BASE, hands: true }), false, 'Hands on never syncs');
  assert.equal('focusGuard' in pick(BASE), false, 'a focus guard never used stays out');
});

test('off by default: nothing is sent until the box is ticked', async () => {
  const srv = server();
  const a = computer(srv, BASE, { t: 1000 });
  assert.equal(a.sync.status().syncOn, false);
  await a.sync.sync();
  assert.equal(srv.calls.length, 0);
});

test('first computer fills the account; the second takes it when sync is turned on there', async () => {
  const srv = server();
  const clock = { t: 1000 };
  const a = computer(srv, { ...BASE, knotIsland: true, voice: 'fable', shortcuts: { ...BASE.shortcuts, ptt: 'CommandOrControl+Shift+M' } }, clock);
  const r1 = await a.sync.setOn(true);
  assert.equal(r1.syncOn, true);
  assert.equal(r1.pushed.length, 8);
  const body = JSON.stringify(srv.calls.filter(c => c.path.includes('put_settings')).map(c => c.body));
  for (const secret of ['SECRET', 'vault', 'résumé']) assert.equal(body.includes(secret), false);
  clock.t = 2000;
  const b = computer(srv, BASE, clock);
  const r2 = await b.sync.setOn(true);
  assert.deepEqual(r2.applied.sort(), ['knotIsland', 'ptt', 'voice']);
  assert.equal(b.get().knotIsland, true);
  assert.equal(b.get().shortcuts.ptt, 'CommandOrControl+Shift+M');
  assert.equal(b.get().apiKeys.gemini, 'AIzaSECRET', 'local keys untouched');
});

test('last write wins per key across two computers', async () => {
  const srv = server();
  const clock = { t: 1000 };
  const a = computer(srv, BASE, clock);
  const b = computer(srv, BASE, clock);
  await a.sync.setOn(true);
  clock.t = 1100; await b.sync.setOn(true);
  // A changes sounds at 2000, B changes corner at 3000; both sync later.
  clock.t = 2000; a.set({ sounds: false }); await a.sync.sync();
  clock.t = 3000; b.set({ knotCorner: 'tl' }); await b.sync.sync();
  assert.equal(b.get().sounds, false, 'B takes the newer sounds from A');
  clock.t = 4000; await a.sync.sync();
  assert.equal(a.get().knotCorner, 'tl', 'A takes the newer corner from B');
  // Both change the same key; the later one wins everywhere.
  clock.t = 5000; a.set({ focusGuardFeeds: ['Instagram'] }); await a.sync.sync();
  clock.t = 6000; b.set({ focusGuardFeeds: ['TikTok'] }); await b.sync.sync();
  clock.t = 7000; await a.sync.sync();
  assert.deepEqual(a.get().focusGuardFeeds, ['TikTok']);
  assert.equal(srv.row.settings.focusGuardFeeds.at, 6000);
});

test('two changes seen in the same millisecond converge on the account value', async () => {
  const srv = server();
  const clock = { t: 1000 };
  const a = computer(srv, BASE, clock);
  const b = computer(srv, BASE, clock);
  await a.sync.setOn(true); await b.sync.setOn(true);
  clock.t = 5000; a.set({ knotCorner: 'tl' }); b.set({ knotCorner: 'tr' });
  await a.sync.sync(); await b.sync.sync(); await a.sync.sync();
  assert.equal(a.get().knotCorner, b.get().knotCorner);
});

test('Hands: off travels, on never does', async () => {
  const srv = server();
  const clock = { t: 1000 };
  const a = computer(srv, { ...BASE, hands: true }, clock);
  await a.sync.setOn(true);
  assert.equal(srv.row.settings.hands, undefined, 'Hands on is not sent');
  const b = computer(srv, BASE, clock);
  clock.t = 1500; await b.sync.setOn(true);
  assert.equal(srv.row.settings.hands.v, false);
  clock.t = 2000; await a.sync.sync();
  assert.equal(a.get().hands, false, 'an off from another computer turns Hands off here');
  // A remote "on" (a hand-edited row) is ignored.
  srv.row.settings.hands = { v: true, at: 9e12 };
  clock.t = 3000; const c = computer(srv, BASE, clock); await c.sync.setOn(true);
  assert.equal(c.get().hands, false);
});

test('offline edits keep their time and win when the network is back', async () => {
  const srv = server();
  const clock = { t: 1000 };
  const a = computer(srv, BASE, clock);
  const b = computer(srv, BASE, clock);
  await a.sync.setOn(true); await b.sync.setOn(true);
  srv.setDown(true);
  clock.t = 2000; a.set({ sounds: false });
  const off = await a.sync.sync();
  assert.equal(off.syncOffline, true);
  srv.setDown(false);
  clock.t = 2500; b.set({ knotIsland: true }); await b.sync.sync();
  clock.t = 9000; await a.sync.sync();
  assert.equal(srv.row.settings.sounds.at, 2000, 'stamped when it was made, not when it reached the server');
  assert.equal(a.get().knotIsland, true);
  await b.sync.sync();
  assert.equal(b.get().sounds, false);
});

test('bad remote values are never applied', async () => {
  const srv = server();
  srv.row.version = 1;
  srv.row.settings = { ptt: { v: 'Ctrl+<script>', at: 5 }, voice: { v: 'robot', at: 5 }, knotCorner: { v: 'middle', at: 5 }, focusGuardFeeds: { v: 'x'.repeat(50), at: 5 }, sounds: { v: false, at: 5 } };
  const a = computer(srv, BASE, { t: 1000 });
  await a.sync.setOn(true);
  assert.deepEqual([a.get().shortcuts.ptt, a.get().voice, a.get().knotCorner, a.get().sounds], [BASE.shortcuts.ptt, 'system', 'br', false]);
});

test('server SQL: allowlist, Hands off only, RLS read own, no client writes', () => {
  const sql = read('accounts-server/migrations/2026-11-01-b-user-settings.sql');
  for (const k of KEYS) assert.match(sql, new RegExp("'" + k + "'"));
  assert.match(sql, /hands_syncs_off_only/);
  assert.match(sql, /alter table public\.user_settings enable row level security/);
  assert.match(sql, /for select\s+using \(auth\.uid\(\) = user_id\)/);
  assert.match(sql, /revoke insert, update, delete on public\.user_settings from anon, authenticated/);
  assert.match(sql, /grant execute on function public\.put_settings\(jsonb\) to authenticated/);
  assert.doesNotMatch(sql, /apiKeys|vaultPath/);
});

test('wiring: the switch, the IPC, and remote values through the same validation as Home', () => {
  const main = read('src/main-companion.js');
  assert.match(main, /handle\('home:account:sync'/);
  assert.match(read('companion/home/preload.js'), /invoke\('account:sync', on\)/);
  assert.match(read('companion/home/index.html'), /id="account-sync"/);
  // Applied through settingsPatch and the talk-key rebind, never written raw.
  const apply = main.slice(main.indexOf('function getSync()'), main.indexOf('function scheduleSync()'));
  assert.match(apply, /settingsPatch\(rest\)/);
  assert.match(apply, /companion\.setPttShortcut\(ptt\)/);
  assert.doesNotMatch(apply, /store\.setSettings/);
});
