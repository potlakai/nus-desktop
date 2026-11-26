// Contract amendment (f), 2026-11-11: the sign-in door in Nūs's own anonymous
// stats. What is covered: an install that never gets through is still an
// install; the door's rows (shown, clicked, signed in, closed, not reachable,
// who answers) carry an install id and fixed words only; and a row written just
// before the app quits at the door is not lost.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStats, EVENTS, PROP_KEYS, COHORTS, GATE_SCREENS, AI_SOURCES, AI_PATHS, HOOKS, QUEUE_MAX_TRIES } = require('../src/stats');

const root = path.resolve(__dirname, '../..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const DOOR = ['signin_shown', 'signin_clicked', 'signin', 'signin_closed', 'signin_unreachable', 'ai_source'];

// One process on a profile folder. `net` decides what the server does with each
// send: a status number, or 'down' for no network at all.
function rig(opts = {}) {
  const dir = opts.dir || fs.mkdtempSync(path.join(os.tmpdir(), 'nus-signin-'));
  const calls = [];
  let settings = { sendStats: true, ...(opts.settings || {}) };
  const net = { mode: opts.net === undefined ? 204 : opts.net };
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const mode = typeof net.mode === 'function' ? net.mode(body) : net.mode;
    if (mode === 'down') throw new TypeError('fetch failed');
    calls.push({ url, body });
    return { status: mode };
  };
  const clock = { t: opts.t || Date.parse('2026-11-12T10:00:00Z') };
  const stats = createStats({ userData: dir, settings: { get: () => settings, set: p => { settings = { ...settings, ...p }; } },
    appVersion: opts.version || '0.1.19', platform: 'win32', packaged: true, env: opts.env || {}, fetch,
    now: () => clock.t, setInterval: () => ({ unref() {} }), clearInterval: () => {} });
  const state = () => JSON.parse(fs.readFileSync(path.join(dir, 'stats-state.json'), 'utf8'));
  return { dir, calls, stats, clock, net, state, names: () => calls.map(c => c.body.name), named: n => calls.filter(c => c.body.name === n),
    done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('the door names, keys and lists are in the client allowlists', () => {
  for (const n of DOOR) assert.ok(EVENTS.has(n), n);
  assert.ok(PROP_KEYS.has('cohort') && PROP_KEYS.has('screen') && PROP_KEYS.has('method') && PROP_KEYS.has('path') && PROP_KEYS.has('seconds'));
  assert.deepEqual(COHORTS, ['new', 'update']);
  assert.deepEqual(GATE_SCREENS, ['sign_in', 'waiting', 'choose', 'unreachable']);
  assert.deepEqual(AI_SOURCES, ['publik', 'own_key']);
  assert.ok(AI_PATHS.includes('publik'));
  assert.ok(HOOKS.includes('contact_card') && HOOKS.includes('contact_declined'));
});

test('an install that never gets past the door is still counted as an install', async () => {
  const r = rig();
  await r.stats.boot({ via: 'manual' });          // the host calls boot before the door
  await r.stats.gateScreen('sign_in');
  await r.stats.stop();                           // the window was closed: the app quits
  assert.deepEqual(r.names(), ['install', 'app_open', 'signin_shown', 'signin_closed']);
  assert.equal(r.named('first_run_end').length, 0, 'first_run_end keeps its meaning: a first run that got in');
  r.done();
});

test('the door shown: once per process, with new or update', async () => {
  const fresh = rig();
  await fresh.stats.boot();
  await fresh.stats.gateScreen('sign_in');
  await fresh.stats.gateScreen('sign_in');
  await fresh.stats.gateScreen('waiting');
  assert.equal(fresh.named('signin_shown').length, 1);
  assert.deepEqual(fresh.named('signin_shown')[0].body.props, { cohort: 'new' });
  // The next launch of the same new install is still new, and says shown again.
  const again = rig({ dir: fresh.dir });
  await again.stats.boot();
  await again.stats.gateScreen('sign_in');
  assert.deepEqual(again.named('signin_shown')[0].body.props, { cohort: 'new' });
  fresh.done();

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nus-signin-'));
  fs.writeFileSync(path.join(dir, 'stats-state.json'), JSON.stringify({ installed: true, lastVersion: '0.1.16', firstAskSent: true }));
  const up = rig({ dir });
  await up.stats.boot();
  await up.stats.gateScreen('sign_in');
  assert.deepEqual(up.named('signin_shown')[0].body.props, { cohort: 'update' });
  assert.equal(up.named('install').length, 0);
  assert.deepEqual(up.named('update_installed')[0].body.props, { from: '0.1.16' });
  up.done();
});

test('the button, the wait, and where the door stood when it was closed', async () => {
  const r = rig();
  await r.stats.boot();
  await r.stats.gateScreen('sign_in');
  await r.stats.gatePress('sign_in');
  await r.stats.gatePress('sign_in');
  await r.stats.gatePress('retry');
  await r.stats.gateScreen('waiting');
  r.clock.t += 95 * 1000;
  await r.stats.stop();
  assert.equal(r.named('signin_clicked').length, 1);
  assert.deepEqual(r.named('signin_clicked')[0].body.props, {});
  assert.deepEqual(r.named('signin_closed')[0].body.props, { screen: 'waiting', seconds: 95 });
  r.done();
});

test('signed in: once per install, then who answers, and nothing at quit', async () => {
  const r = rig();
  await r.stats.boot();
  await r.stats.gateScreen('sign_in');
  r.clock.t += 40 * 1000;
  await r.stats.gateScreen('choose');             // publik said "claimed": the plan screen is up
  await r.stats.gatePassed('own_key');
  assert.deepEqual(r.named('signin').map(c => c.body.props), [{ method: 'publik', seconds: 40 }]);
  assert.deepEqual(r.named('ai_source').map(c => c.body.props), [{ path: 'own_key' }]);
  await r.stats.aiSource('own_key');
  await r.stats.aiSource('publik');               // flipped in Settings
  await r.stats.aiSource('gemini');               // not a known word: dropped
  assert.deepEqual(r.named('ai_source').map(c => c.body.props.path), ['own_key', 'publik']);
  await r.stats.stop();
  assert.equal(r.named('signin_closed').length, 0, 'the door was passed');
  assert.equal(r.named('first_run_end').length, 1, 'got in and never asked: the old row, as before');
  // A later launch: the door does not show, and nothing is said twice.
  const next = rig({ dir: r.dir });
  await next.stats.boot();
  await next.stats.gatePassed('publik');
  assert.deepEqual(next.names().filter(n => DOOR.includes(n)), []);
  r.done();
});

test('quit on the plan screen: signed in, and closed at choose', async () => {
  const r = rig();
  await r.stats.boot();
  await r.stats.gateScreen('sign_in');
  await r.stats.gateScreen('choose');
  await r.stats.stop();
  assert.equal(r.named('signin').length, 1);
  assert.equal(r.named('signin_closed')[0].body.props.screen, 'choose');
  r.done();
});

test('already signed in before this version: signin once, with no seconds and no door', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nus-signin-'));
  fs.writeFileSync(path.join(dir, 'stats-state.json'), JSON.stringify({ installed: true, lastVersion: '0.1.18' }));
  const r = rig({ dir });
  await r.stats.boot();
  await r.stats.gatePassed('publik');
  assert.equal(r.named('signin_shown').length, 0);
  assert.deepEqual(r.named('signin')[0].body.props, { method: 'publik' });
  assert.deepEqual(r.named('ai_source')[0].body.props, { path: 'publik' });
  r.done();
});

test('publik not reachable: once per process, and not a sign-in shown', async () => {
  const r = rig();
  await r.stats.boot();
  await r.stats.gateScreen('unreachable');
  await r.stats.gateScreen('unreachable');
  assert.equal(r.named('signin_unreachable').length, 1);
  assert.equal(r.named('signin_shown').length, 0);
  await r.stats.stop();
  assert.equal(r.named('signin_closed')[0].body.props.screen, 'unreachable');
  r.done();
});

test('no network at the door: the rows wait on disk and go out at the next launch, in order', async () => {
  const r = rig({ net: 'down' });
  await r.stats.boot();
  await r.stats.gateScreen('unreachable');
  await r.stats.gateScreen('sign_in');
  await r.stats.stop();
  assert.equal(r.calls.length, 0);
  assert.deepEqual(r.state().queue.map(i => i.name), ['signin_unreachable', 'signin_shown', 'signin_closed']);
  assert.equal(r.state().installed, undefined, 'install waits too, by its own old rule');
  const next = rig({ dir: r.dir });
  await next.stats.boot();
  await next.stats.flush();
  assert.deepEqual(next.names().filter(n => DOOR.includes(n)), ['signin_unreachable', 'signin_shown', 'signin_closed']);
  assert.deepEqual(next.names().filter(n => !DOOR.includes(n)), ['install', 'app_open']);
  assert.deepEqual(next.state().queue, []);
  r.done();
});

test('quit at the door on a network too slow for the quit: nothing is lost', async () => {
  const r = rig();
  await r.stats.boot();
  await r.stats.gateScreen('sign_in');
  r.net.mode = 'down';                            // from here every send fails
  const started = Date.now();
  await r.stats.stop();
  assert.ok(Date.now() - started < 1500, 'the quit is held for about a second at most');
  assert.deepEqual(r.state().queue.map(i => i.name), ['signin_closed']);
  assert.equal(r.state().gate, null);
  const next = rig({ dir: r.dir });
  await next.stats.boot();
  await next.stats.flush();
  assert.equal(next.named('signin_closed').length, 1);
  r.done();
});

test('killed at the door (no quit at all): the next launch says it closed', async () => {
  const r = rig();
  await r.stats.boot();
  await r.stats.gateScreen('sign_in');
  r.clock.t += 20 * 1000;
  await r.stats.gateScreen('waiting');
  // No stop(): the process is gone. The mark is on disk.
  assert.deepEqual(r.state().gate.screen, 'waiting');
  const next = rig({ dir: r.dir, t: r.clock.t + 3600 * 1000 });
  await next.stats.boot();
  await next.stats.flush();
  assert.deepEqual(next.named('signin_closed').map(c => c.body.props), [{ screen: 'waiting', seconds: 20 }]);
  assert.equal(next.state().gate, null);
  r.done();
});

test('a server that does not know the names yet (400): the rows wait, one try per launch, then go', async () => {
  const old = body => (DOOR.includes(body.name) && body.name !== 'signin' ? 400 : 204);
  const r = rig({ net: old });
  await r.stats.boot();
  await r.stats.gateScreen('sign_in');
  await r.stats.gatePress('sign_in');
  await r.stats.gateScreen('choose');
  await r.stats.gatePassed('publik');
  // signin is a name the server already takes; the new ones are refused and kept.
  assert.equal(r.calls.filter(c => c.body.name === 'signin').length, 1);
  assert.deepEqual(r.state().queue.map(i => [i.name, i.tries]), [['signin_shown', 1], ['signin_clicked', 1], ['ai_source', 1]]);
  assert.equal(r.calls.filter(c => c.body.name === 'signin_shown').length, 1, 'asked once this launch, not in a loop');
  // The server is patched before the next launch: everything arrives.
  const next = rig({ dir: r.dir });
  await next.stats.boot();
  await next.stats.flush();
  assert.deepEqual(next.names().filter(n => DOOR.includes(n)), ['signin_shown', 'signin_clicked', 'ai_source']);
  assert.deepEqual(next.state().queue, []);
  r.done();
});

test('a row refused eight times, or two weeks old, is dropped', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nus-signin-'));
  const t = Date.parse('2026-11-12T10:00:00Z');
  fs.writeFileSync(path.join(dir, 'stats-state.json'), JSON.stringify({ installed: true, lastVersion: '0.1.19', cohort: 'new', queue: [
    { k: 'a', name: 'signin_shown', props: { cohort: 'new' }, at: t - 1000, tries: QUEUE_MAX_TRIES },
    { k: 'b', name: 'signin_clicked', props: {}, at: t - 15 * 24 * 3600 * 1000, tries: 0 },
    { k: 'c', name: 'not_a_name', props: {}, at: t - 1000, tries: 0 },
    { k: 'd', name: 'signin_closed', props: { screen: 'sign_in', seconds: 4 }, at: t - 1000, tries: 2 }] }));
  const r = rig({ dir, t });
  await r.stats.flush();
  assert.deepEqual(r.names(), ['signin_closed']);
  assert.deepEqual(r.state().queue, []);
  r.done();
});

test('every door row is an install id and fixed words: nothing else can ride along', async () => {
  const r = rig();
  await r.stats.boot();
  await r.stats.gateScreen('sign_in');
  await r.stats.gateScreen('someone@example.com');             // not a screen: dropped whole
  await r.stats.gatePress('sign_in');
  await r.stats.gateScreen('choose');
  await r.stats.gatePassed('pk_live_secret');                   // not a source: no ai_source row
  await r.stats.track('signin', { method: 'publik', email: 'someone@example.com', handle: '@someone', key: 'pk_live_x' });
  const id = r.stats.installId();
  for (const c of r.calls.filter(x => DOOR.includes(x.body.name))) {
    assert.deepEqual(Object.keys(c.body).sort(), ['app_version', 'install_id', 'name', 'platform', 'product', 'props']);
    assert.equal(c.body.install_id, id);
    for (const [k, v] of Object.entries(c.body.props)) {
      assert.ok(PROP_KEYS.has(k), k);
      assert.ok(typeof v === 'number' || ['new', 'update', 'publik', 'own_key', ...GATE_SCREENS].includes(v), k + '=' + v);
    }
    assert.doesNotMatch(JSON.stringify(c.body), /example\.com|pk_live|@someone/);
  }
  assert.equal(r.named('ai_source').length, 0);
  r.done();
});

test('stats off: the door says nothing and keeps nothing', async () => {
  const off = rig({ settings: { sendStats: false } });
  await off.stats.boot();
  await off.stats.gateScreen('sign_in');
  await off.stats.gatePress('sign_in');
  await off.stats.gatePassed('publik');
  await off.stats.stop();
  assert.equal(off.calls.length, 0);
  assert.ok(!off.state().queue || off.state().queue.length === 0);
  off.done();
  // Turned off with rows still waiting: they are thrown away, not sent later.
  const r = rig({ net: body => (body.name === 'signin_shown' ? 400 : 204) });
  await r.stats.boot();
  await r.stats.gateScreen('sign_in');
  assert.equal(r.state().queue.length, 1);
  await r.stats.setEnabled(false);
  assert.deepEqual(r.state().queue, []);
  r.done();
  const env = rig({ env: { NUS_STATS: '0' } });
  await env.stats.gateScreen('sign_in');
  assert.equal(env.calls.length, 0);
  env.done();
});

test('ai_ready says publik when publik answers, once', async () => {
  const r = rig();
  await r.stats.aiReady('publik');
  await r.stats.aiReady('key');
  assert.deepEqual(r.named('ai_ready').map(c => c.body.props), [{ path: 'publik' }]);
  r.done();
  const core = read('companion/index.js');
  assert.match(core, /hooks\.onAiReady\(a && a\.publik \? 'publik' : a && a\.key \? 'key' : a && a\.cli \? 'claude_code' : 'none'\)/);
});

test('the contact card rows wait in the queue like the door rows', async () => {
  const r = rig({ net: body => (body.name === 'hook_shown' && body.props.hook === 'contact_card' ? 400 : 204) });
  await r.stats.hookShown('contact_card');
  await r.stats.hookUsed('contact_declined');
  await r.stats.hookShown('morning_line');
  assert.deepEqual(r.state().queue.map(i => [i.name, i.props.hook]), [['hook_shown', 'contact_card']]);
  assert.deepEqual(r.named('hook_used').map(c => c.body.props), [{ hook: 'contact_declined' }]);
  r.done();
});

test('wiring: stats start before the door, the window reports screens, a test run counts nothing', () => {
  const main = read('src/main-companion.js');
  const ready = main.indexOf('app.whenReady().then(');
  const boot = main.indexOf('stats.boot(', ready);
  const gate = main.indexOf('publik.module.ensureSignedIn(', ready);
  assert.ok(boot > ready && boot < gate, 'stats.boot runs before the gate');
  assert.equal(main.split('stats.boot(').length, 2, 'and only once');
  assert.match(main.slice(boot - 20, boot), /if \(!SMOKE\) $/);
  assert.match(main, /onScreen: gateCount\.screen, onPress: gateCount\.press/);
  assert.match(main, /gateCount\.passed\(signed && signed\.choice\)/);
  // 0.1.40 added plan() and noKey() (own-key-0140.test.js); a test run still counts nothing.
  assert.match(main, /const gateCount = SMOKE \? \{ screen\(\) \{\}, press\(\) \{\}, passed\(\) \{\}, plan\(\) \{\}, noKey\(\) \{\} \}/);
  assert.match(main, /publik\.setChoice\(String\(choice \|\| ''\)\); stats\.aiSource\(publik\.choice\(\)\)/);
  // The quit hold that carries signin_closed is the same one as before.
  assert.match(main, /stats\.stop\(SMOKE \? '' : exitReason \|\| 'other'\)\.catch\(\(\) => \{\}\)\.finally\(\(\) => app\.exit\(0\)\)/);

  const { statScreen } = require('../src/publik/gate-window');
  const mod = require('../src/publik/publik');
  assert.equal(statScreen(mod.gateScreen('sign_in', null)), 'sign_in');
  assert.equal(statScreen(mod.gateScreen('sign_in', null, 'Waiting for you to sign in in your browser.')), 'waiting');
  assert.equal(statScreen(mod.gateScreen('sign_in', null, 'No sign-in after 10 minutes. Click Sign in with publik to try again.')), 'sign_in');
  assert.equal(statScreen(mod.gateScreen('unreachable', null)), 'unreachable');
  assert.equal(statScreen(mod.gateScreen('choose', { claim_state: 'claimed', account: { handle: 'someone' }, plan: { kind: 'none', label: null }, balance_micros: 0 })), 'choose');
  assert.equal(statScreen({ id: 'anything_else' }), '');
  // The window hands over a screen name and a button name, never the screen itself.
  const win = read('companion/src/publik/gate-window.js');
  assert.match(win, /tell\(opts\.onScreen, statScreen\(screen\)\)/);
  assert.match(win, /tell\(opts\.onPress, action\)/);
});

test('the stats module reads nothing of publik', () => {
  const src = read('companion/src/stats.js');
  assert.doesNotMatch(src, /require\(['"][^'"]*publik/);
  assert.doesNotMatch(src, /LOCALAPPDATA|credential|wallet|claim_/);
});

test('the server change for these names is written down beside the code', (t) => {
  // The public nus-companion snapshot ships no docs/ folder; there is nothing to check there.
  if (!fs.existsSync(path.join(root, 'docs', 'signin-funnel-server.patch'))) { t.skip('no docs/ in this checkout'); return; }
  const patch = read('docs/signin-funnel-server.patch');
  for (const n of ['signin_shown', 'signin_clicked', 'signin_closed', 'signin_unreachable', 'ai_source', 'contact_card', 'contact_declined', "'cohort'", "'screen'"]) assert.ok(patch.includes(n), n);
});
