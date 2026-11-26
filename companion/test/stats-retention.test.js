// Contract amendment 2026-11-06 (e): the honest retention ladder. first_win is
// the first ask that worked and was more than a hello; engaged is once a day on
// a real action, never just the process being alive; ai_ready once; hook
// counts; app_open carries via and the pop-up holdout group.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStats, HOOKS, AI_PATHS, STRUGGLES, VIAS } = require('../src/stats');

function rig(opts = {}) {
  const dir = opts.dir || fs.mkdtempSync(path.join(os.tmpdir(), 'nus-stats-e-'));
  const calls = [];
  let settings = { sendStats: true };
  const fetch = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return (opts.responder || (() => ({ status: 204 })))(calls.length); };
  const clock = { t: Date.parse('2026-11-06T10:00:00Z') };
  const stats = createStats({ userData: dir, settings: { get: () => settings, set: p => { settings = { ...settings, ...p }; } },
    appVersion: '0.1.16', platform: 'win32', packaged: true, env: {}, fetch, now: () => clock.t, random: opts.random,
    setInterval: () => ({ unref() {} }), clearInterval() {}, dev: opts.dev });
  const named = name => calls.filter(c => c.body.name === name);
  return { dir, calls, stats, clock, named, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const settle = () => new Promise(r => setImmediate(r));

test('the amendment (e) lists, with what amendment (f) added, are the contract lists', () => {
  assert.deepEqual(HOOKS, ['checkin', 'morning_line', 'continue_project', 'reminder_toast', 'autostart_offer', 'my_nus', 'knot_report', 'notice',
    'winback_d3', 'winback_d7', 'winback_d30', 'share_card', 'quiet_mode', 'contact_card', 'contact_declined', 'dictation_news']);
  assert.deepEqual(AI_PATHS, ['key', 'claude_code', 'none', 'publik']);
  assert.deepEqual(STRUGGLES, ['homework_start', 'feeds', 'find_in_apps', 'writing', 'remember', 'other']);
  assert.deepEqual(VIAS, ['login', 'manual', 'relaunch']);
});

test('only win() makes a first win: asks never do, a greeting or unknown feature never does; once', async () => {
  const r = rig();
  await r.stats.ask('voice', 'greeting', 'ok');
  await r.stats.ask('voice', 'guide', 'ok');
  await r.stats.win('greeting');
  await r.stats.win('what the user typed');
  assert.equal(r.named('first_win').length, 0);
  assert.equal(r.stats.status().firstWinAt, null);
  await r.stats.win('focus_guard');
  await r.stats.win('guide');
  assert.equal(r.named('first_win').length, 1);
  assert.deepEqual(r.named('first_win')[0].body.props, { feature: 'focus_guard' });
  assert.equal(r.stats.status().firstWinFeature, 'focus_guard');
  r.done();
});

test('an offline first win is owed to the next win', async () => {
  let fail = true;
  const r = rig({ responder: () => { if (fail) throw new Error('offline'); return { status: 204 }; } });
  await r.stats.win('reminder');
  fail = false;
  await r.stats.win('guide');
  const sent = r.named('first_win');
  assert.deepEqual(sent[sent.length - 1].body.props, { feature: 'guide' });
  assert.equal(r.stats.status().firstWinFeature, 'reminder', 'the local time and feature stay the first one');
  await r.stats.win('hands');
  assert.equal(r.named('first_win').length, sent.length, 'nothing more once the server took it');
  r.done();
});

test('the first win is kept locally even with stats off', async () => {
  const r = rig();
  await r.stats.setEnabled(false);
  await r.stats.win('reminder');
  assert.equal(r.named('first_win').length, 0);
  assert.ok(r.stats.status().firstWinAt, 'My Nus can still show it');
  r.done();
});

test('a one-click relaunch reads as relaunch', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nus-stats-e-'));
  fs.writeFileSync(path.join(dir, 'stats-state.json'), JSON.stringify({ installed: true, lastVersion: '0.1.15', oneClickFor: '0.1.16' }));
  const r = rig({ dir });
  await r.stats.boot({ via: 'manual' });
  assert.equal(r.named('app_open')[0].body.props.via, 'relaunch');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('engaged goes out once per UTC day, and again the next day', async () => {
  const r = rig();
  await r.stats.engaged();
  await r.stats.engaged();
  assert.equal(r.named('engaged').length, 1);
  r.clock.t += 24 * 3600 * 1000;
  await r.stats.engaged();
  assert.equal(r.named('engaged').length, 2);
  assert.deepEqual(r.named('engaged')[0].body.props, {});
  r.done();
});

test('engaged survives a restart the same day', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nus-stats-e-'));
  const a = rig({ dir });
  await a.stats.engaged();
  const b = rig({ dir });
  await b.stats.engaged();
  assert.equal(b.named('engaged').length, 0, 'already said today');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ai_ready once per install, only a known path', async () => {
  const r = rig();
  await r.stats.aiReady('my key is sk-123');
  await r.stats.aiReady('claude_code');
  await r.stats.aiReady('key');
  assert.equal(r.named('ai_ready').length, 1);
  assert.deepEqual(r.named('ai_ready')[0].body.props, { path: 'claude_code' });
  r.done();
});

test('hooks carry only a known hook name', async () => {
  const r = rig();
  await r.stats.hookShown('checkin');
  await r.stats.hookUsed('checkin');
  await r.stats.hookShown('Continue essay draft');
  assert.deepEqual(r.calls.map(c => [c.body.name, c.body.props]), [['hook_shown', { hook: 'checkin' }], ['hook_used', { hook: 'checkin' }]]);
  r.done();
});

test('struggle_picked carries the struggle; other steps never do', async () => {
  const r = rig();
  await r.stats.onboardingStep('struggle_picked', { struggle: 'feeds' });
  await r.stats.onboardingStep('tour_voice', { struggle: 'feeds' });
  assert.deepEqual(r.named('onboarding_step').map(c => c.body.props), [{ step: 'struggle_picked', struggle: 'feeds' }, { step: 'tour_voice' }]);
  r.done();
});

test('an unknown struggle is dropped, the step still counts', async () => {
  const r = rig();
  await r.stats.onboardingStep('struggle_picked', { struggle: 'my essay on Hamlet' });
  assert.deepEqual(r.named('onboarding_step')[0].body.props, { step: 'struggle_picked' });
  r.done();
});

test('app_open at boot carries via and the holdout group; the day check carries no via', async () => {
  const r = rig({ random: () => 0.5 });
  await r.stats.boot({ via: 'login' });
  const boot = r.named('app_open')[0].body.props;
  assert.deepEqual(boot, { via: 'login', nudge_group: 'on' });
  r.clock.t += 24 * 3600 * 1000;
  await r.stats.tick();
  assert.deepEqual(r.named('app_open')[1].body.props, { nudge_group: 'on' });
  r.done();
});

test('an unknown via reads as manual', async () => {
  const r = rig();
  await r.stats.boot({ via: 'hacked' });
  assert.equal(r.named('app_open')[0].body.props.via, 'manual');
  r.done();
});

test('the holdout is chosen once and kept; dev installs always count as on', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nus-stats-e-'));
  const a = rig({ dir, random: () => 0.05 });
  assert.equal(a.stats.nudgeGroup(), 'off');
  const b = rig({ dir, random: () => 0.9 });
  assert.equal(b.stats.nudgeGroup(), 'off', 'kept from the first choice');
  const d = rig({ dir, dev: true });
  assert.equal(d.stats.nudgeGroup(), 'on');
  fs.rmSync(dir, { recursive: true, force: true });
});
