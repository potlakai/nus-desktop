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
