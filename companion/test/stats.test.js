const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStats, TRACK_URL, NOTICE } = require('../src/stats');

const root = path.resolve(__dirname, '../..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

// A stats instance on a throwaway folder with a recording fetch. `packaged`
// defaults to true so the default case is the one a real install sees.
function rig(opts = {}) {
  const dir = opts.dir || fs.mkdtempSync(path.join(os.tmpdir(), 'nus-stats-'));
  const calls = [];
  let settings = { sendStats: true, ...(opts.settings || {}) };
  const responder = opts.responder || (() => ({ status: 204 }));
  const fetch = async (url, init) => { calls.push({ url, body: JSON.parse(init.body), init }); return responder(calls.length); };
  const clock = { t: Date.parse('2026-10-05T10:00:00Z') };
  const stats = createStats({ userData: dir, settings: { get: () => settings, set: p => { settings = { ...settings, ...p }; } },
    appVersion: '0.1.3', platform: 'win32', packaged: opts.packaged !== false, env: opts.env || {}, fetch,
    now: () => clock.t, setInterval: () => ({ unref() {} }), clearInterval: () => {} });
  return { dir, calls, stats, clock, settings: () => settings, names: () => calls.map(c => c.body.name) };
}

test('install id is a uuid v4, written once and stable across instances', async () => {
  const r = rig();
  const id = r.stats.installId();
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(fs.readFileSync(path.join(r.dir, 'install_id.txt'), 'utf8').trim(), id);
  const again = rig({ dir: r.dir });
  assert.equal(again.stats.installId(), id);
  await r.stats.track('app_open');
  assert.equal(r.calls[0].body.install_id, id);
  fs.rmSync(r.dir, { recursive: true, force: true });
});

test('every send has the contract shape and goes only to the track URL', async () => {
  const r = rig();
  await r.stats.track('key_connected', { provider: 'gemini', secret: 'never', mode: 42 });
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].url, TRACK_URL);
  assert.equal(r.calls[0].init.method, 'POST');
  assert.deepEqual(r.calls[0].init.headers, { 'Content-Type': 'application/json' });
  assert.deepEqual(Object.keys(r.calls[0].body).sort(), ['app_version', 'install_id', 'name', 'platform', 'product', 'props']);
  assert.equal(r.calls[0].body.product, 'companion');
  assert.equal(r.calls[0].body.app_version, '0.1.3');
  assert.deepEqual(r.calls[0].body.props, { provider: 'gemini', mode: 42 }, 'unknown prop keys are dropped');
  await r.stats.track('first_import');
  await r.stats.track('made_up');
  assert.equal(r.calls.length, 1, 'desktop-only and unknown names never leave');
  fs.rmSync(r.dir, { recursive: true, force: true });
});

test('disabled in settings: no fetch at all', async () => {
  const r = rig({ settings: { sendStats: false } });
  await r.stats.boot(); await r.stats.ask('voice'); await r.stats.keyConnected('gemini'); await r.stats.sourceAnswer('reddit');
  assert.equal(r.calls.length, 0);
  assert.equal(r.stats.status().active, false);
  fs.rmSync(r.dir, { recursive: true, force: true });
});

test('NUS_STATS=0 wins over the switch; unpackaged needs NUS_STATS=1', async () => {
  const off = rig({ env: { NUS_STATS: '0' } });
  await off.stats.boot(); await off.stats.ask('text');
  assert.equal(off.calls.length, 0);
  fs.rmSync(off.dir, { recursive: true, force: true });
  const dev = rig({ packaged: false });
  await dev.stats.boot(); await dev.stats.ask('text');
  assert.equal(dev.calls.length, 0);
  fs.rmSync(dev.dir, { recursive: true, force: true });
  const devOn = rig({ packaged: false, env: { NUS_STATS: '1' } });
  await devOn.stats.boot();
  assert.deepEqual(devOn.names(), ['install', 'app_open']);
  fs.rmSync(devOn.dir, { recursive: true, force: true });
});

test('install fires on the first run only, app_open every boot and once per UTC day after', async () => {
  const r = rig();
  await r.stats.boot();
  assert.deepEqual(r.names(), ['install', 'app_open']);
  await r.stats.tick(); await r.stats.tick();
  assert.deepEqual(r.names(), ['install', 'app_open'], 'same day: the 15 minute check sends nothing');
  r.clock.t += 20 * 60 * 60 * 1000;   // 06:00 UTC next day
  await r.stats.tick(); await r.stats.tick();
  assert.deepEqual(r.names(), ['install', 'app_open', 'app_open']);
  const second = rig({ dir: r.dir });
  await second.stats.boot();
  assert.deepEqual(second.names(), ['app_open'], 'a later launch never repeats install');
  fs.rmSync(r.dir, { recursive: true, force: true });
});

test('a network miss leaves install for the next launch; one retry at most', async () => {
  let attempts = 0;
  const r = rig({ responder: () => { attempts++; throw new Error('offline'); } });
  await r.stats.track('ask', { mode: 'text' });
  assert.equal(attempts, 2);
  await r.stats.boot();
  const stateFile = path.join(r.dir, 'stats-state.json');
  assert.equal((fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {}).installed, undefined);
  const back = rig({ dir: r.dir });
  await back.stats.boot();
  assert.deepEqual(back.names(), ['install', 'app_open']);
  const rejected = rig({ responder: () => ({ status: 400 }) });
  await rejected.stats.track('ask', { mode: 'text' });
  assert.equal(rejected.calls.length, 1, 'a 4xx is never retried');
  fs.rmSync(r.dir, { recursive: true, force: true }); fs.rmSync(rejected.dir, { recursive: true, force: true });
});

test('first_ask once, then ask with the mode', async () => {
  const r = rig();
  await r.stats.ask('voice'); await r.stats.ask('text'); await r.stats.ask('guide'); await r.stats.ask('nonsense');
  assert.deepEqual(r.names(), ['first_ask', 'ask', 'ask', 'ask']);
  assert.deepEqual(r.calls.map(c => c.body.props.mode), ['voice', 'text', 'guide', 'text']);
  const later = rig({ dir: r.dir });
  await later.stats.ask('voice');
  assert.deepEqual(later.names(), ['ask'], 'the first-ask flag survives a restart');
  fs.rmSync(r.dir, { recursive: true, force: true });
});

test('source_answer takes the contract values and marks the first run done', async () => {
  const r = rig();
  assert.equal(r.stats.status().firstRun, true);
  assert.equal(r.stats.status().notice, NOTICE);
  await r.stats.sourceAnswer('friend');
  assert.deepEqual(r.calls[0].body.props, { source: 'friend' });
  assert.equal(r.stats.status().firstRun, false);
  assert.equal(rig({ dir: r.dir }).stats.status().firstRun, false);
  await r.stats.sourceAnswer('<script>');
  assert.equal(r.calls[1].body.props.source, 'skipped');
  fs.rmSync(r.dir, { recursive: true, force: true });
});

test('turning stats off sends stats_off once and then nothing, ever, until turned back on', async () => {
  const r = rig();
  const st = await r.stats.setEnabled(false);
  assert.deepEqual(r.names(), ['stats_off']);
  assert.equal(st.enabled, false);
  assert.equal(r.settings().sendStats, false);
  await r.stats.setEnabled(false);
  await r.stats.boot(); await r.stats.ask('voice'); await r.stats.keyConnected('anthropic'); await r.stats.tick();
  assert.deepEqual(r.names(), ['stats_off']);
  await r.stats.setEnabled(true);
  await r.stats.ask('voice');
  // Contract (c): a first ask that could not be sent is still owed, so the
  // first ask after the switch comes back is the install's first_ask.
  assert.deepEqual(r.names(), ['stats_off', 'first_ask']);
  await r.stats.ask('voice');
  assert.deepEqual(r.names(), ['stats_off', 'first_ask', 'ask']);
  fs.rmSync(r.dir, { recursive: true, force: true });
});

test('the Companion build wires stats through the host and keeps the words out', () => {
  const main = read('src/main-companion.js');
  assert.match(main, /require\('\.\.\/companion\/src\/stats'\)/);
  assert.match(main, /onAsk: \(\{ mode, feature, outcome \}\) => \{\s*\n\s*stats\.ask\(mode, feature, outcome\);/);
  assert.match(main, /onFeature: feature => stats\.featureSession\(feature\)/);
  assert.match(main, /onStep: \(step, extra\) => stats\.onboardingStep\(step, extra\)/);
  assert.match(main, /onWin: feature => stats\.win\(feature\)/);
  assert.match(main, /onEngaged: \(\) => stats\.engaged\(\)/);
  assert.match(main, /onCaptureEnd: meta => stats\.featureSession\('voice'/);
  assert.match(main, /crashHandlers\.setOnCrash\(\(\) => stats\.crash\(\)\)/);
  assert.match(main, /stats\.keyConnected\(provider\)/);
  assert.match(main, /home:stats:source/);
  assert.match(main, /stats\.boot\(\{ via: process\.argv\.includes\('--autostart'\) \? 'login' : 'manual' \}\)/);
  const companion = read('companion/index.js');
  assert.match(companion, /hooks\.onAsk\(\{ mode:/);
  assert.match(companion, /function noteAsk\(mode, feature, outcome\)/);
  for (const f of ['hands', 'guide', 'focus_guard']) assert.ok(companion.includes("featureBegin('" + f + "')") && companion.includes("featureEnd('" + f + "')"), f + ' is timed');
  assert.ok((companion.match(/noteNoProvider\(/g) || []).length >= 6, 'every "no AI set up" bubble counts as no_provider');
  assert.doesNotMatch(companion, /noteAsk\('[a-z]+'\)/, 'every ask names its feature');
  assert.doesNotMatch(companion, /onAsk\(\{[^}]*\b(?:text|userText|q):/, 'the hook carries the mode only');
  assert.doesNotMatch(companion, /require\(['"]\.\/src\/stats['"]\)/, 'the shared Companion core never talks to the stats server itself');
  const statsSource = read('companion/src/stats.js');
  assert.doesNotMatch(statsSource, /@supabase|require\(['"]electron['"]\)/);
  assert.equal((statsSource.match(/https:\/\//g) || []).length, 1, 'one URL: the track function');
  assert.match(read('companion/src/store.js'), /sendStats: true/);
  const html = read('companion/home/index.html');
  assert.match(html, /Nūs sends anonymous usage stats \(which features get used, never your coursework or what you type\)\. Turn off in Settings\./);
  for (const s of ['instagram', 'friend', 'reddit', 'x', 'youtube', 'search', 'other', 'skipped']) assert.ok(html.includes('data-source="' + s + '"'), s);
  assert.match(html, /id="send-stats"/);
  assert.match(read('companion/home/preload.js'), /statsSource/);
  for (const f of ['companion/src/stats.js', 'companion/home/index.html', 'companion/home/home.js', 'docs/companion-stats.md']) assert.doesNotMatch(read(f), /—/, f + ' has no em dashes');
});

// Session length and the dev flag (contract amendment 2026-10-15 b).

// A rig whose timers are captured, so a test can run the minute sampler and
// the day check by hand.
function clockRig(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nus-stats-'));
  const calls = [];
  let settings = { sendStats: true };
  const fetch = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return { status: 204 }; };
  const clock = { t: Date.parse('2026-10-14T23:50:00Z'), idle: 0 };
  const timers = [];
  const stats = createStats({ userData: dir, settings: { get: () => settings, set: p => { settings = { ...settings, ...p }; } },
    appVersion: '0.1.7', platform: 'win32', packaged: true, env: opts.env || {}, fetch, now: () => clock.t,
    setInterval: (fn, ms) => { const t = { fn, ms, unref() {} }; timers.push(t); return t; }, clearInterval: t => { t.cleared = true; },
    idleSeconds: opts.noIdle ? undefined : () => clock.idle, dev: opts.dev });
  return { dir, calls, stats, clock, timers, names: () => calls.map(c => c.body.name) };
}

test('active minutes count only while the system is not idle, and go out once at quit', async () => {
  const r = clockRig();
  await r.stats.boot();
  const minute = r.timers.find(t => t.ms === 60 * 1000);
  assert.ok(minute, 'a one-minute sampler is running');
  for (let i = 0; i < 3; i++) minute.fn();
  r.clock.idle = 10 * 60;
  for (let i = 0; i < 4; i++) minute.fn();
  assert.equal(r.stats.activeMinutes(), 3);
  const out = await r.stats.stop();
  assert.equal(out.sent, true);
  const session = r.calls.find(c => c.body.name === 'app_session');
  assert.deepEqual(session.body.props, { minutes: 3 });
  assert.equal(r.stats.activeMinutes(), 0);
  assert.ok(r.timers.every(t => t.cleared), 'both clocks stopped');
  const again = await r.stats.stop();
  assert.equal(again.sent, false, 'nothing under a minute is reported');
  fs.rmSync(r.dir, { recursive: true, force: true });
});

test('a new UTC day reports the minutes so far before the daily app_open', async () => {
  const r = clockRig();
  await r.stats.boot();
  const minute = r.timers.find(t => t.ms === 60 * 1000);
  for (let i = 0; i < 12; i++) minute.fn();
  r.clock.t += 15 * 60 * 1000; // 00:05 the next UTC day
  await r.stats.tick();
  assert.deepEqual(r.names(), ['install', 'app_open', 'app_session', 'app_open']);
  assert.equal(r.calls[2].body.props.minutes, 12);
  fs.rmSync(r.dir, { recursive: true, force: true });
});

test('without an idle reader every minute counts', async () => {
  const r = clockRig({ noIdle: true });
  await r.stats.boot();
  const minute = r.timers.find(t => t.ms === 60 * 1000);
  minute.fn(); minute.fn();
  assert.equal(r.stats.activeMinutes(), 2);
  fs.rmSync(r.dir, { recursive: true, force: true });
});

test('the founder flag marks every event dev: true, by env or by file, and is off by default', async () => {
  const plain = clockRig();
  await plain.stats.track('app_open');
  assert.equal(plain.stats.dev(), false);
  assert.deepEqual(plain.calls[0].body.props, {});
  fs.rmSync(plain.dir, { recursive: true, force: true });

  const byEnv = clockRig({ env: { NUS_STATS_DEV: '1' } });
  await byEnv.stats.ask('voice');
  assert.equal(byEnv.stats.dev(), true);
  assert.deepEqual(byEnv.calls[0].body.props, { mode: 'voice', outcome: 'ok', dev: true });
  assert.equal(byEnv.stats.status().dev, true);
  fs.rmSync(byEnv.dir, { recursive: true, force: true });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nus-stats-'));
  fs.writeFileSync(path.join(dir, 'dev-install.txt'), 'pranav laptop\n');
  const calls = [];
  const byFile = createStats({ userData: dir, settings: { get: () => ({ sendStats: true }), set() {} }, appVersion: '0.1.7',
    platform: 'win32', packaged: true, env: {}, fetch: async (u, i) => { calls.push(JSON.parse(i.body)); return { status: 204 }; },
    setInterval: () => ({ unref() {} }), clearInterval() {} });
  await byFile.track('app_open');
  assert.deepEqual(calls[0].props, { dev: true });
  fs.rmSync(dir, { recursive: true, force: true });
});
