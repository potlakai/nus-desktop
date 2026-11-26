'use strict';
// The key helpers that outlived Get started (companion/src/get-started.js):
// the Gemini key shape check, plain-words provider errors, the answer source
// order. The first screen of a new install is the tour now (companion/src/tour.js,
// tour.test.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const gs = require('../src/get-started');
const { createStats, EVENTS } = require('../src/stats');

const root = path.resolve(__dirname, '../..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

test('a Gemini key is shape-checked before any network call, in plain words', () => {
  const good = 'AIza' + 'B'.repeat(35);
  assert.deepEqual(gs.geminiKeyShape('  ' + good + '\n'), { ok: true, key: good, message: '' });
  assert.equal(gs.geminiKeyShape('"' + good + '"').ok, true, 'quotes from a copy are dropped');
  for (const bad of ['', 'sk-ant-api03-abc', 'hello world', 'AIzaShort', 'ya29.' + 'x'.repeat(40)]) {
    const r = gs.geminiKeyShape(bad);
    assert.equal(r.ok, false, bad);
    assert.ok(r.message.length > 10 && r.message.length < 140, bad);
    assert.doesNotMatch(r.message, /[{}]/);
  }
  assert.match(gs.geminiKeyShape('sk-ant-api03-abc').message, /Anthropic key/);
  assert.match(gs.geminiKeyShape('AIzaShort').message, /cut off/);
  // AI Studio's new auth keys start with "AQ." and must not be turned away.
  const aq = 'AQ.Ab8RN6' + 'x_Y-z9'.repeat(8);
  assert.deepEqual(gs.geminiKeyShape(' ' + aq + ' '), { ok: true, key: aq, message: '' });
  assert.match(gs.geminiKeyShape('AQ.Ab8').message, /cut off/);
  assert.equal(gs.geminiKeyShape('AQAb8RN6' + 'x'.repeat(40)).ok, false, 'no dot, not a key');
});

test('provider failures become one sentence a person can act on (Apple review fix 4)', () => {
  const raw400 = 'got status: 400 Bad Request. {"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT","details":[{"@type":"type.googleapis.com/google.rpc.ErrorInfo","reason":"API_KEY_INVALID"}]}}';
  assert.equal(gs.plainKeyError('gemini', raw400), 'Google did not accept this key. Copy it again from AI Studio; it starts with AQ. or AIza.');
  assert.match(gs.plainKeyError('gemini', '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}'), /out of free asks/);
  assert.match(gs.plainKeyError('gemini', 'TypeError: fetch failed'), /could not reach Google/);
  assert.match(gs.plainKeyError('gemini', 'network timed out'), /could not reach Google/);
  assert.match(gs.plainKeyError('gemini', '{"error":{"code":403,"status":"PERMISSION_DENIED"}}'), /AI Studio, not in Google Cloud/);
  assert.match(gs.plainKeyError('cli', 'cli_not_logged_in'), /not signed in/);
  assert.match(gs.plainKeyError('cli', 'cli_timeout'), /too long/);
  assert.match(gs.plainKeyError('cli', 'not installed'), /not on this computer/);
  assert.match(gs.plainKeyError('anthropic', '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'), /did not accept/);
  assert.match(gs.plainKeyError('typesafe', '401 Unauthorized'), /did not accept/);
  for (const p of ['gemini', 'cli', 'anthropic', 'typesafe', 'other']) {
    const m = gs.plainKeyError(p, '{"weird":"thing"}');
    assert.doesNotMatch(m, /[{}"]/, p);
    assert.ok(m.length < 160, p);
  }
});

test('the answer source follows the Knot order; Claude Code counts only once it answered', () => {
  assert.equal(gs.answerSource({ keys: { gemini: 'x', anthropic: 'y' }, cli: true, cliOk: true }), 'gemini');
  assert.equal(gs.answerSource({ keys: { anthropic: 'y' } }), 'anthropic');
  assert.equal(gs.answerSource({ keys: { nvidia: 'n' } }), 'nvidia');
  assert.equal(gs.answerSource({ cli: true, cliOk: false }), null, 'installed is not enough: it must have answered');
  assert.equal(gs.answerSource({ cli: true, cliOk: true }), 'claude-code');
});

test('launch to first ask is kept on this computer, once, even with stats off, and nothing new is sent', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nus-gs-'));
  const calls = [];
  const clock = { t: Date.parse('2026-10-20T10:00:00Z') };
  const make = (packaged, sendStats) => createStats({ userData: dir, settings: { get: () => ({ sendStats }), set: () => {} }, appVersion: '0.1.7', platform: 'win32', packaged, env: {},
    fetch: async (url, init) => { calls.push(JSON.parse(init.body)); return { status: 204 }; }, now: () => clock.t, setInterval: () => ({ unref() {} }), clearInterval: () => {} });
  const stats = make(false, false);   // a dev run with stats off: sends nothing
  await stats.boot();
  clock.t += 42400;
  await stats.ask('text', 'chat', 'ok');
  clock.t += 30000;
  await stats.ask('voice', 'chat', 'ok');
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'stats-state.json'), 'utf8'));
  assert.equal(state.firstAskSeconds, 42.4);
  assert.equal(stats.status().firstAskSeconds, 42.4);
  assert.equal(calls.length, 0);
  // Packaged and on: the same first_ask as before, with no extra props.
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'nus-gs-'));
  const sent = [];
  const on = createStats({ userData: dir2, settings: { get: () => ({ sendStats: true }), set: () => {} }, appVersion: '0.1.7', platform: 'win32', packaged: true, env: {},
    fetch: async (url, init) => { sent.push(JSON.parse(init.body)); return { status: 204 }; }, now: () => clock.t, setInterval: () => ({ unref() {} }), clearInterval: () => {} });
  await on.boot();
  await on.ask('text', 'chat', 'ok');
  const first = sent.find(b => b.name === 'first_ask');
  assert.deepEqual(first.props, { mode: 'text', outcome: 'ok', feature: 'chat' });
  for (const b of sent) assert.ok(EVENTS.has(b.name), b.name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(dir2, { recursive: true, force: true });
});

test('Get started adds no telemetry: the event list matches the contract and the onboarding steps are unchanged', () => {
  const { STEPS } = require('../src/stats');
  // Amendment (e), 2026-11-06, added ai_ready, engaged, first_win and the two hook events.
  assert.deepEqual([...EVENTS].sort(), ['ai_ready', 'ai_source', 'app_exit', 'app_open', 'app_session', 'ask', 'companion_session', 'crash', 'engaged', 'feature_session', 'first_ask', 'first_run_end', 'first_win', 'hook_shown', 'hook_used', 'install', 'key_connected', 'notice_clicked', 'notice_shown', 'onboarding_step', 'signin', 'signin_clicked', 'signin_closed', 'signin_shown', 'signin_unreachable', 'source_answer', 'stats_off', 'update_installed', 'update_offered']);
  assert.deepEqual(STEPS.slice(0, 6), ['welcome_seen', 'stats_notice_seen', 'key_prompt_seen', 'key_skipped', 'key_connected', 'first_window_closed']);
  assert.doesNotMatch(read('companion/src/get-started.js'), /track\(|onboardingStep\(/);
});

test('an Nvidia key can be pasted, tested and used from Home, without a restart', () => {
  const html = read('companion/home/index.html');
  const home = read('companion/home/home.js');
  const host = read('src/main-companion.js');
  const store = read('companion/src/store.js');
  for (const id of ['key-nvidia-home', 'nvidia-state', 'data-test="nvidia"', 'data-clear="nvidia"']) assert.ok(html.includes(id), id);
  assert.match(home, /\['typesafe','gemini','nvidia','anthropic'\]\)\$\('#key-'\+k\+'-home'\)\.value=''/);
  assert.match(host, /nvidia: \(\) => s\.apiKeys\.nvidia \? timed\(ping\('nvidia'\)\)/);
  assert.match(store, /setSettings\(patch\) \{ load\(\); data = deepMerge\(data, patch \|\| \{\}\); pickKeyedProvider\(data\);/);
  assert.match(gs.plainKeyError('nvidia', '401 Unauthorized'), /starts with nvapi-/);
  assert.match(gs.plainKeyError('nvidia', '429 Too Many Requests'), /free credits/);
  assert.match(gs.plainKeyError('nvidia', 'TypeError: fetch failed'), /could not reach Nvidia/);
});

test('Test on a pasted key saves it first, so it never reads "Not set" (feedback 209, 246)', () => {
  const home = read('companion/home/home.js');
  assert.match(home, /async function saveTyped\(which\)\{/);
  assert.match(home, /api\.settingsSet\(\{apiKeys:\{\[which\]:v\}\}\)/);
  assert.match(home, /\$\$\('\[data-test\]'\)\.forEach\(b=>b\.onclick=\(\)=>run\(async\(\)=>\{await saveTyped\(b\.dataset\.test\);await testKey\(b\.dataset\.test\);\},b\)\);/);
});
