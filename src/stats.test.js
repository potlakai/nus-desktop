// Anonymous usage stats: the client half of TELEMETRY-CONTRACT.md. These
// tests mock fetch and the preferences store; nothing here touches the
// network or the real app data.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStats, sanitizeProps, INSTALL_ID_FILE, KEY_ENABLED, KEY_INSTALL_SENT, KEY_SOURCE_ASKED, KEY_FIRST_ASK_SENT } = require('./stats');
const acquisition = require('./acquisition');

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONFIG = { supabase: { url: 'https://project.supabase.co', anonKey: 'publishable' } };

function memoryStore(initial = {}) {
  const data = { ...initial };
  return { data, get: (key) => data[key], set: (key, value) => { data[key] = value; } };
}

// A fetch mock that records every call and answers with the given status.
function fakeFetch(status = 204) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
    const next = typeof status === 'function' ? status(calls.length) : status;
    if (next === 'network') throw new Error('ECONNRESET');
    return { status: next, ok: next >= 200 && next < 300 };
  };
  impl.calls = calls;
  return impl;
}

function harness(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nus-stats-'));
  const store = overrides.store || memoryStore();
  const fetchImpl = overrides.fetchImpl || fakeFetch(204);
  const timers = [];
  const stats = createStats({
    userData: dir,
    config: CONFIG,
    appVersion: '0.2.7',
    platform: 'win32',
    store,
    packaged: true,
    env: {},
    fetchImpl,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; },
    clearTimer: () => {},
    ...overrides,
  });
  return { dir, store, fetchImpl, stats, timers, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('the install id is created once, is a UUID v4, and stays stable across instances', () => {
  const h = harness();
  try {
    const first = h.stats.getInstallId();
    assert.match(first, UUID_V4);
    const onDisk = fs.readFileSync(path.join(h.dir, INSTALL_ID_FILE), 'utf8').trim();
    assert.equal(onDisk, first);
    const again = createStats({ userData: h.dir, config: CONFIG, store: h.store, packaged: true, env: {}, fetchImpl: h.fetchImpl });
    assert.equal(again.getInstallId(), first);
    assert.equal(h.stats.getInstallId(), first);
  } finally { h.cleanup(); }
});

test('a send carries exactly the contract body and nothing identifying', async () => {
  const h = harness();
  try {
    const result = await h.stats.track('signin', { method: 'google', acq_action_id: 'act-20261001-abcdef0', email: 'x@y.z', nested: { a: 1 } });
    assert.deepEqual(result, { sent: true, ok: true, status: 204 });
    assert.equal(h.fetchImpl.calls.length, 1);
    const call = h.fetchImpl.calls[0];
    assert.equal(call.url, 'https://project.supabase.co/functions/v1/track');
    assert.deepEqual(call.headers, { 'Content-Type': 'application/json' });
    assert.deepEqual(Object.keys(call.body).sort(), ['app_version', 'install_id', 'name', 'platform', 'product', 'props']);
    assert.equal(call.body.product, 'desktop');
    assert.equal(call.body.app_version, '0.2.7');
    assert.equal(call.body.platform, 'win32');
    assert.match(call.body.install_id, UUID_V4);
    assert.deepEqual(call.body.props, { method: 'google', acq_action_id: 'act-20261001-abcdef0' });
  } finally { h.cleanup(); }
});

test('unknown event names never reach the network', async () => {
  const h = harness();
  try {
    assert.deepEqual(await h.stats.track('made_up', {}), { sent: false, ok: false, status: null });
    assert.equal(h.fetchImpl.calls.length, 0);
  } finally { h.cleanup(); }
});

test('disabled in Settings: no fetch at all', async () => {
  const h = harness({ store: memoryStore({ [KEY_ENABLED]: false }) });
  try {
    h.stats.start({});
    await h.stats.track('app_open', {});
    await h.stats.ask('text');
    await h.stats.track('limit_hit', { unit: 'questions' });
    assert.equal(h.fetchImpl.calls.length, 0);
    assert.equal(h.stats.status().enabled, false);
    assert.equal(h.stats.status().active, false);
    assert.equal(h.stats.status().askSource, false, 'no question when nothing could be sent');
  } finally { h.cleanup(); }
});

test('NUS_STATS=0 disables everything, even packaged and enabled', async () => {
  const h = harness({ env: { NUS_STATS: '0' } });
  try {
    h.stats.start({});
    await h.stats.track('app_open', {});
    await h.stats.setEnabled(false);
    assert.equal(h.fetchImpl.calls.length, 0, 'not even stats_off goes out');
    assert.equal(h.stats.status().envDisabled, true);
  } finally { h.cleanup(); }
});

test('unpackaged dev runs send nothing unless NUS_STATS=1', async () => {
  const dev = harness({ packaged: false, env: {} });
  const optIn = harness({ packaged: false, env: { NUS_STATS: '1' } });
  try {
    await dev.stats.track('app_open', {});
    assert.equal(dev.fetchImpl.calls.length, 0);
    await optIn.stats.track('app_open', {});
    assert.equal(optIn.fetchImpl.calls.length, 1);
  } finally { dev.cleanup(); optIn.cleanup(); }
});

test('app_open fires once per boot and once per local calendar day while running', async () => {
  let clock = new Date(2026, 9, 5, 23, 50); // local time, 5 Oct 2026
  const h = harness({ now: () => clock });
  try {
    h.stats.start({ acq_action_id: 'act-20261001-abcdef0' });
    await new Promise((r) => setImmediate(r));
    const opens = () => h.fetchImpl.calls.filter((c) => c.body.name === 'app_open');
    assert.equal(opens().length, 1);
    assert.deepEqual(opens()[0].body.props, { acq_action_id: 'act-20261001-abcdef0' });
    assert.equal(h.timers.length, 1);
    assert.equal(h.timers[0].ms, 15 * 60 * 1000);
    // Same day: the tick is a no-op.
    h.timers[0].fn();
    await new Promise((r) => setImmediate(r));
    assert.equal(opens().length, 1);
    // Midnight passes locally: the next tick opens the new day.
    clock = new Date(2026, 9, 6, 0, 5);
    h.timers[0].fn();
    await new Promise((r) => setImmediate(r));
    assert.equal(opens().length, 2);
    h.timers[0].fn();
    await new Promise((r) => setImmediate(r));
    assert.equal(opens().length, 2);
    // Starting twice does not add a second timer.
    h.stats.start({});
    assert.equal(h.timers.length, 1);
  } finally { h.cleanup(); }
});

test('install fires on the first ever run, then never again, and retries after an offline first run', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nus-stats-'));
  const store = memoryStore();
  try {
    const offline = fakeFetch('network');
    const first = createStats({ userData: dir, config: CONFIG, store, packaged: true, env: {}, fetchImpl: offline, setTimer: () => ({ unref() {} }), clearTimer: () => {} });
    first.start({});
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(offline.calls.filter((c) => c.body.name === 'install').length, 2, 'one send plus one retry');
    assert.notEqual(store.get(KEY_INSTALL_SENT), true, 'no flag while offline');

    const online = fakeFetch(204);
    const second = createStats({ userData: dir, config: CONFIG, store, packaged: true, env: {}, fetchImpl: online, setTimer: () => ({ unref() {} }), clearTimer: () => {} });
    second.start({});
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(online.calls.filter((c) => c.body.name === 'install').length, 1);
    assert.equal(store.get(KEY_INSTALL_SENT), true);

    const third = createStats({ userData: dir, config: CONFIG, store, packaged: true, env: {}, fetchImpl: online, setTimer: () => ({ unref() {} }), clearTimer: () => {} });
    third.start({});
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(online.calls.filter((c) => c.body.name === 'install').length, 1, 'never a second install');
    assert.equal(online.calls.filter((c) => c.body.name === 'app_open').length, 2, 'each boot opens');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the first_import flag is written only after a successful send', async () => {
  const h = harness({ fetchImpl: fakeFetch((n) => (n === 1 ? 'network' : n === 2 ? 'network' : 204)) });
  try {
    const send = () => h.stats.track('first_import', {}).then((r) => r.sent);
    // First confirm: offline (send + retry both fail). No flag.
    assert.equal(acquisition.hasFirstImport(h.dir), false);
    assert.equal(await acquisition.markFirstImportOnce(h.dir, send), false);
    assert.equal(acquisition.hasFirstImport(h.dir), false);
    assert.equal(h.fetchImpl.calls.length, 2);
    // Second confirm: 204. Flag written.
    assert.equal(await acquisition.markFirstImportOnce(h.dir, send), true);
    assert.equal(acquisition.hasFirstImport(h.dir), true);
    assert.equal(h.fetchImpl.calls.length, 3);
    // Third: already counted.
    assert.equal(await acquisition.markFirstImportOnce(h.dir, send), false);
    assert.equal(h.fetchImpl.calls.length, 3);
  } finally { h.cleanup(); }
});

test('a 429 or 400 still counts as sent, so the flag is written and nothing spams', async () => {
  const h = harness({ fetchImpl: fakeFetch(429) });
  try {
    const result = await h.stats.track('first_import', {});
    assert.deepEqual(result, { sent: true, ok: false, status: 429 });
    assert.equal(h.fetchImpl.calls.length, 1, 'no retry on a rate limit');
    const send = () => h.stats.track('first_import', {}).then((r) => r.sent);
    assert.equal(await acquisition.markFirstImportOnce(h.dir, send), true);
    assert.equal(acquisition.hasFirstImport(h.dir), true);
  } finally { h.cleanup(); }
});

test('a server error or timeout retries exactly once', async () => {
  const flaky = harness({ fetchImpl: fakeFetch((n) => (n === 1 ? 503 : 204)) });
  const dead = harness({ fetchImpl: fakeFetch('network') });
  try {
    assert.deepEqual(await flaky.stats.track('ask', { mode: 'text' }), { sent: true, ok: true, status: 204 });
    assert.equal(flaky.fetchImpl.calls.length, 2);
    assert.deepEqual(await dead.stats.track('ask', { mode: 'text' }), { sent: false, ok: false, status: null });
    assert.equal(dead.fetchImpl.calls.length, 2);
  } finally { flaky.cleanup(); dead.cleanup(); }
});

test('turning stats off sends stats_off once and then nothing, until turned back on', async () => {
  const h = harness();
  try {
    const status = await h.stats.setEnabled(false);
    assert.equal(status.enabled, false);
    assert.equal(h.fetchImpl.calls.length, 1);
    assert.equal(h.fetchImpl.calls[0].body.name, 'stats_off');
    assert.equal(h.store.get(KEY_ENABLED), false);
    // Off is off: nothing else goes out, and a second off sends no second stats_off.
    await h.stats.track('app_open', {});
    await h.stats.ask('voice');
    await h.stats.setEnabled(false);
    await h.stats.answerSource('reddit');
    assert.equal(h.fetchImpl.calls.length, 1);
    // Back on: later events flow again, with no event for the switch itself.
    await h.stats.setEnabled(true);
    assert.equal(h.store.get(KEY_ENABLED), true);
    assert.equal(h.fetchImpl.calls.length, 1);
    await h.stats.track('limit_hit', { unit: 'questions' });
    assert.equal(h.fetchImpl.calls.length, 2);
    assert.equal(h.fetchImpl.calls[1].body.name, 'limit_hit');
  } finally { h.cleanup(); }
});

test('first_ask once, then ask with its mode', async () => {
  const h = harness();
  try {
    await h.stats.ask('voice');
    await h.stats.ask('text');
    await h.stats.ask('guide');
    await h.stats.ask('nonsense');
    const names = h.fetchImpl.calls.map((c) => [c.body.name, c.body.props.mode]);
    assert.deepEqual(names, [['first_ask', 'voice'], ['ask', 'text'], ['ask', 'guide'], ['ask', undefined]]);
    assert.equal(h.store.get(KEY_FIRST_ASK_SENT), true);
  } finally { h.cleanup(); }
});

test('the source question is asked once, Skip counts as an answer, and bad values become skipped', async () => {
  const h = harness();
  try {
    assert.equal(h.stats.status().askSource, true);
    await h.stats.answerSource('<script>');
    assert.equal(h.stats.status().askSource, false);
    assert.equal(h.store.get(KEY_SOURCE_ASKED), true);
    assert.deepEqual(h.fetchImpl.calls[0].body.props, { source: 'skipped' });
    const again = harness();
    try {
      await again.stats.answerSource('friend');
      assert.deepEqual(again.fetchImpl.calls[0].body.props, { source: 'friend' });
    } finally { again.cleanup(); }
  } finally { h.cleanup(); }
});

test('props are sanitized to allowed keys, scalar values, 80 chars and 1 KB', () => {
  const clean = sanitizeProps({ unit: 'x'.repeat(200), minutes: 12, mode: 'voice', ok: true, course: 'Linear Algebra', nested: { a: 1 }, bad: NaN, locale: true });
  assert.deepEqual(Object.keys(clean), ['unit', 'minutes', 'mode', 'locale']);
  assert.equal(clean.unit.length, 80);
  const fat = sanitizeProps(Object.fromEntries(['acq_action_id', 'utm_source', 'utm_medium', 'utm_campaign', 'source', 'mode', 'provider', 'method', 'unit', 'reason', 'os_version', 'locale'].map((k) => [k, 'y'.repeat(80)])));
  assert.ok(Buffer.byteLength(JSON.stringify(fat), 'utf8') <= 1024);
  assert.deepEqual(sanitizeProps(null), {});
});

test('a deleted install id file means a fresh install next time', async () => {
  const h = harness({ store: memoryStore({ [KEY_INSTALL_SENT]: true }) });
  try {
    const first = h.stats.getInstallId();
    assert.equal(h.store.get(KEY_INSTALL_SENT), false, 'a new id resets the install flag');
    fs.rmSync(path.join(h.dir, INSTALL_ID_FILE));
    const next = createStats({ userData: h.dir, config: CONFIG, store: h.store, packaged: true, env: {}, fetchImpl: h.fetchImpl });
    assert.notEqual(next.getInstallId(), first);
  } finally { h.cleanup(); }
});

// Static contract checks: the schema CHECK list, the Edge Function's allow
// lists, the client vocabulary, the gateway config and the user-facing copy
// all have to say the same thing, and nothing at runtime tells you when they
// stop.
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const quotedList = (text, regex) => {
  const match = text.match(regex);
  assert.ok(match, `found ${regex}`);
  return [...match[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
};

test('schema, track function and client agree on event names and props keys', () => {
  const { EVENT_NAMES, PROP_KEYS } = require('./stats');
  const schema = read('supabase/schema.sql');
  const track = read('supabase/functions/track/index.ts');
  const section = schema.slice(schema.indexOf('create table if not exists public.install_events'));
  const schemaNames = quotedList(section, /name\s+text not null\s+check \(name in \(([\s\S]*?)\)\)/);
  const tsNames = quotedList(track, /const NAMES = new Set\(\[([\s\S]*?)\]\)/);
  const tsKeys = quotedList(track, /const PROP_KEYS = new Set\(\[([\s\S]*?)\]\)/);
  // The server is shared with the Companion, which sends names and keys the
  // desktop never does (update channel 2026-11-04, Companion 0.1.16): schema and
  // track agree exactly, and every desktop name and key is one they accept.
  assert.deepEqual(schemaNames, tsNames);
  for (const name of EVENT_NAMES) assert.ok(tsNames.includes(name), `server accepts desktop name ${name}`);
  for (const key of PROP_KEYS) assert.ok(tsKeys.includes(key), `server accepts desktop key ${key}`);
  assert.match(section, /alter table public\.install_events enable row level security/);
  assert.doesNotMatch(section, /create policy[^;]*on public\.install_events/, 'no client policies, service role only');
  assert.match(section, /create unique index if not exists \w+\s+on public\.install_events \(install_id, name, day\)\s+where name in \('app_open'\)/);
  assert.match(section, /pg_column_size\(new\.props\) > 1024/);
  assert.match(section, /create index if not exists \w+\s+on public\.install_events \(name, day\)/);
  assert.match(section, /create index if not exists \w+\s+on public\.install_events \(install_id, day\)/);
});

test('both stats functions skip the JWT gate and daily-metrics checks METRICS_TOKEN', () => {
  const config = read('supabase/config.toml');
  assert.match(config, /\[functions\.track\]\s+verify_jwt = false/);
  assert.match(config, /\[functions\.daily-metrics\]\s+verify_jwt = false/);
  const metrics = read('supabase/functions/daily-metrics/index.ts');
  assert.match(metrics, /Deno\.env\.get\('METRICS_TOKEN'\)/);
  assert.match(metrics, /day < current_date|install_daily_metrics/, 'completed days come from the SQL rollup');
  const track = read('supabase/functions/track/index.ts');
  assert.match(track, /RATE_LIMIT_PER_DAY = 200/);
  assert.match(track, /MAX_PROPS_BYTES = 1024/);
  assert.match(track, /reply\(204\)/);
  assert.match(track, /reply\(429/);
});

test('the words that had to change, changed', () => {
  const appJs = read('renderer/app.js');
  const html = read('renderer/index.html');
  const readme = read('README.md');
  assert.doesNotMatch(appJs, /Supabase only holds your email and plan/);
  assert.doesNotMatch(readme, /Supabase holds only your email and plan/);
  assert.match(appJs, /Nūs sends anonymous usage stats \(which features get used, never your coursework or what you type\)\. Turn off in Settings\./);
  assert.match(html, /Send anonymous usage stats/);
  assert.match(html, /Anonymous usage stats \(which features get used, on a random install id\) help us see what works\. Your coursework and what you type stay on your device\./);
  assert.match(readme, /Anonymous usage stats \(which features get used, on a random install id\) help\s+us see what works\. Your coursework and what you type stay on your device\. Turn\s+it off in Settings\./);
  for (const label of ['Instagram', 'A friend', 'Reddit', 'X', 'YouTube', 'Search', 'Other', 'Skip']) {
    assert.match(html, new RegExp(`data-source="[a-z]+">${label}<`), `source button ${label}`);
  }
  // No em dashes in anything user-facing that this change touched.
  for (const file of ['docs/stats.md', 'src/stats.js', 'supabase/functions/track/index.ts', 'supabase/functions/daily-metrics/index.ts']) {
    assert.doesNotMatch(read(file), /\u2014/, `${file} has no em dash`);
  }
});

test('the desktop wires stats through the preload and main like every other setting', () => {
  const preload = read('src/preload.js');
  const main = read('src/main.js');
  assert.match(preload, /statsStatus: \(\) => ipcRenderer\.invoke\('stats:status'\)/);
  assert.match(preload, /statsSetEnabled: \(enabled\) => ipcRenderer\.invoke\('stats:set-enabled', Boolean\(enabled\)\)/);
  assert.match(preload, /statsSourceAnswer: \(source\) => ipcRenderer\.invoke\('stats:source-answer', source\)/);
  for (const channel of ['stats:status', 'stats:set-enabled', 'stats:source-answer']) assert.match(main, new RegExp(`'${channel}'`));
  assert.doesNotMatch(main, /licenseManager\.track\(/, 'nothing routes through the retired license.track');
  assert.match(main, /stats\.start\(withAcquisitionDims\('app_open'/);
  assert.match(main, /acquisition\.hasFirstImport\(userData\)\) trackEvent\('import'/);
  assert.match(main, /trackEvent\('companion_session', \{ minutes:/);
  assert.match(main, /trackEvent\('key_connected', \{ provider: 'anthropic' \}\)/);
  assert.match(read('companion/index.js'), /hooks\.onAsk\(mode\)/);
});
