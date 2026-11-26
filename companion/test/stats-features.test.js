// Contract amendment 2026-10-17 (c): feature and outcome on asks, feature
// timers, first-run steps, first_run_end, crash and update_installed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStats, FEATURES, OUTCOMES, STEPS } = require('../src/stats');

function rig(opts = {}) {
  const dir = opts.dir || fs.mkdtempSync(path.join(os.tmpdir(), 'nus-stats-c-'));
  const calls = [];
  let settings = { sendStats: true };
  const responder = opts.responder || (() => ({ status: 204 }));
  const fetch = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return responder(calls.length); };
  const clock = { t: Date.parse('2026-10-17T10:00:00Z'), idle: 0 };
  const stats = createStats({ userData: dir, settings: { get: () => settings, set: p => { settings = { ...settings, ...p }; } },
    appVersion: opts.version || '0.1.8', platform: 'win32', packaged: true, env: {}, fetch, now: () => clock.t,
    setInterval: () => ({ unref() {} }), clearInterval() {}, idleSeconds: () => clock.idle });
  const named = name => calls.filter(c => c.body.name === name);
  return { dir, calls, stats, clock, names: () => calls.map(c => c.body.name), named, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('the fixed lists are the contract lists', () => {
  assert.deepEqual(FEATURES.slice(0, 9), ['reflex', 'hands', 'memory', 'focus_guard', 'reminder', 'guide', 'plan', 'chat', 'voice']);
  assert.deepEqual(FEATURES.slice(9, 14), ['greeting', 'rewrite', 'page_read', 'recall', 'project'], 'amendment (e) additions');
  assert.deepEqual(FEATURES.slice(14), ['dictation'], '0.1.37: dictation, its own name (seventh edition on the server)');
  assert.deepEqual(OUTCOMES, ['ok', 'failed', 'no_provider', 'cancelled', 'timeout']);
  assert.deepEqual(STEPS.slice(0, 6), ['welcome_seen', 'stats_notice_seen', 'key_prompt_seen', 'key_skipped', 'key_connected', 'first_window_closed']);
  assert.ok(STEPS.includes('tour_done') && STEPS.includes('struggle_picked') && STEPS.includes('autostart_on'), 'amendment (e) additions');
});

test('an ask carries the feature and the outcome; unknown values fall back, never leak', async () => {
  const r = rig();
  await r.stats.ask('voice', 'hands');
  await r.stats.ask('text', 'chat', 'no_provider');
  await r.stats.ask('text', 'what the user typed', 'exploded');
  assert.deepEqual(r.names(), ['first_ask', 'ask', 'ask'], 'an ask that starts is not a win: first_win comes from win()');
  const plain = r.calls;
  assert.deepEqual(plain[0].body.props, { mode: 'voice', outcome: 'ok', feature: 'hands' });
  assert.deepEqual(plain[1].body.props, { mode: 'text', outcome: 'no_provider', feature: 'chat' });
  assert.deepEqual(plain[2].body.props, { mode: 'text', outcome: 'ok' }, 'an unknown feature name is dropped, not sent');
  r.done();
});

test('first_ask is marked done only after the server took it, and one is in flight at a time', async () => {
  let fail = true;
  const r = rig({ responder: () => { if (fail) throw new Error('offline'); return { status: 204 }; } });
  const a = r.stats.ask('voice', 'reflex');
  const b = r.stats.ask('voice', 'reflex');
  await Promise.all([a, b]);
  assert.equal(r.named('first_ask').length, 2, 'one first_ask, plus its one retry');
  assert.equal(r.named('ask').length, 2, 'the second quick ask is a plain ask, plus its one retry');
  assert.equal(r.stats.status().asked, false, 'offline: the first ask is still owed');
  fail = false;
  await r.stats.ask('text', 'chat');
  assert.equal(r.calls[r.calls.length - 1].body.name, 'first_ask', 'the next ask that can send is the first ask');
  assert.equal(r.stats.status().asked, true);
  await r.stats.ask('text', 'chat');
  assert.equal(r.calls[r.calls.length - 1].body.name, 'ask');
  r.done();
});

test('a feature timer reports its seconds once; under a second is nothing; a known length goes out at once', async () => {
  const r = rig();
  const stop = r.stats.featureSession('guide');
  r.clock.t += 42 * 1000;
  const out = await stop();
  assert.equal(out.sent, true);
  assert.deepEqual(r.calls[0].body, { ...r.calls[0].body, name: 'feature_session', props: { feature: 'guide', seconds: 42 } });
  assert.equal((await stop()).sent, false, 'a stopper fires once');
  const quick = r.stats.featureSession('hands');
  r.clock.t += 400;
  assert.equal((await quick()).sent, false);
  await r.stats.featureSession('voice', 90.4);
  assert.deepEqual(r.calls[1].body.props, { feature: 'voice', seconds: 90 });
  assert.equal((await r.stats.featureSession('typing', 5)).sent, false, 'not a feature');
  r.done();
});

test('quit closes the open feature timers before the minutes and first_run_end', async () => {
  const r = rig();
  await r.stats.boot();
  const stopHands = r.stats.featureSession('hands');
  r.clock.t += 30 * 1000;
  await r.stats.stop();
  assert.deepEqual(r.names(), ['install', 'app_open', 'feature_session', 'first_run_end']);
  assert.deepEqual(r.calls[2].body.props, { feature: 'hands', seconds: 30 });
  assert.equal((await stopHands()).sent, false, 'already reported at quit');
  r.done();
});

test('first-run steps count once per install, are marked only after a 204, and the last one is remembered', async () => {
  let ok = false;
  const r = rig({ responder: () => ({ status: ok ? 204 : 500 }) });
  await r.stats.onboardingStep('welcome_seen');
  assert.equal(r.named('onboarding_step').length, 2, 'one retry on a 5xx');
  await r.stats.onboardingStep('welcome_seen');
  assert.equal(r.named('onboarding_step').length, 2, 'one try per process even when it failed');
  ok = true;
  const later = rig({ dir: r.dir });
  await later.stats.onboardingStep('welcome_seen');
  assert.equal(later.named('onboarding_step').length, 1, 'the next launch tries the step again');
  await later.stats.onboardingStep('welcome_seen');
  await later.stats.onboardingStep('not_a_step');
  assert.equal(later.named('onboarding_step').length, 1, 'then never again');
  await later.stats.keyConnected('gemini');
  assert.deepEqual(later.names().slice(-2), ['onboarding_step', 'key_connected']);
  assert.deepEqual(later.named('onboarding_step')[1].body.props, { step: 'key_connected' });
  assert.equal(later.stats.status().lastStep, 'key_connected');
  r.done();
});

test('first_run_end goes out once, at the first quit before any ask, with the step reached and the seconds since first launch', async () => {
  const r = rig();
  await r.stats.boot();
  await r.stats.onboardingStep('welcome_seen');
  await r.stats.onboardingStep('key_prompt_seen');
  r.clock.t += 95 * 1000;
  await r.stats.stop();
  const end = r.named('first_run_end');
  assert.equal(end.length, 1);
  assert.deepEqual(end[0].body.props, { seconds: 95, step: 'key_prompt_seen' });
  const again = rig({ dir: r.dir });
  await again.stats.boot();
  await again.stats.stop();
  assert.equal(again.named('first_run_end').length, 0, 'once per install');
  r.done();

  const asked = rig();
  await asked.stats.boot();
  await asked.stats.ask('voice', 'reflex');
  await asked.stats.stop();
  assert.equal(asked.named('first_run_end').length, 0, 'an install that asked never reports a first-run end');
  asked.done();
});

test('a crash is a count, a few per process at most; a new version reports where it came from', async () => {
  const r = rig({ version: '0.1.7' });
  await r.stats.boot();
  for (let i = 0; i < 5; i++) await r.stats.crash();
  assert.equal(r.named('crash').length, 3);
  assert.deepEqual(r.named('crash')[0].body.props, {});
  assert.equal(r.named('update_installed').length, 0, 'the first launch has nothing to compare');
  const next = rig({ dir: r.dir, version: '0.1.8' });
  await next.stats.boot();
  assert.deepEqual(next.named('update_installed')[0].body.props, { from: '0.1.7' });
  const same = rig({ dir: r.dir, version: '0.1.8' });
  await same.stats.boot();
  assert.equal(same.named('update_installed').length, 0, 'same version, no row');
  r.done();
});

test('the crash handlers expose the hook the host wires, and never pass the error', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../src/crash.js'), 'utf8');
  assert.match(src, /setOnCrash\(fn\)/);
  assert.match(src, /onCrash\?\.\(kind\)/);
  assert.doesNotMatch(src, /onCrash\?\.\(kind, /, 'the kind alone, never the error');
});

// Contract amendment 2026-11-04 (d): enum-only rows for the channel.
test('update_offered goes once per version per surface; a bad surface or id never leaves', async () => {
  const r = rig({ version: '0.1.15' });
  await r.stats.updateOffered('bubble', '0.1.16');
  await r.stats.updateOffered('bubble', '0.1.16');
  await r.stats.updateOffered('card', '0.1.16');
  await r.stats.updateOffered('bubble', '0.1.17');
  await r.stats.updateOffered('toast', '0.1.17');
  assert.deepEqual(r.named('update_offered').map(e => e.body.props), [{ surface: 'bubble' }, { surface: 'card' }, { surface: 'bubble' }]);
  await r.stats.noticeShown('n12');
  await r.stats.noticeClicked('n12');
  await r.stats.noticeShown('free text from a file');
  await r.stats.noticeClicked('');
  assert.deepEqual(r.named('notice_shown').map(e => e.body.props), [{ notice: 'n12' }]);
  assert.deepEqual(r.named('notice_clicked').map(e => e.body.props), [{ notice: 'n12' }]);
  r.done();
});

test('update_installed says oneclick only for the version the one-click installer was started for', async () => {
  const r = rig({ version: '0.1.15' });
  await r.stats.boot();
  r.stats.noteOneClick('0.1.16');
  const next = rig({ dir: r.dir, version: '0.1.16' });
  await next.stats.boot();
  assert.deepEqual(next.named('update_installed')[0].body.props, { from: '0.1.15', via: 'oneclick' });
  const later = rig({ dir: r.dir, version: '0.1.17' });
  await later.stats.boot();
  assert.deepEqual(later.named('update_installed')[0].body.props, { from: '0.1.16' }, 'no via on a manual install: the deployed server refuses a key it does not know');
  const missed = rig({ version: '0.1.15' });
  await missed.stats.boot();
  missed.stats.noteOneClick('0.1.18');
  const other = rig({ dir: missed.dir, version: '0.1.16' });
  await other.stats.boot();
  assert.equal(other.named('update_installed')[0].body.props.via, undefined, 'a different version is not the one-click one');
  r.done(); missed.done();
});

test('stats off: none of the channel rows leave', async () => {
  const r = rig({ version: '0.1.15' });
  await r.stats.setEnabled(false);
  await r.stats.updateOffered('bubble', '0.1.16');
  await r.stats.noticeShown('n1');
  await r.stats.noticeClicked('n1');
  assert.equal(r.named('update_offered').length + r.named('notice_shown').length + r.named('notice_clicked').length, 0);
  r.done();
});
