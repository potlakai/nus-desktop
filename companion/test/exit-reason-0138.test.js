// 0.1.38: how a run of Nūs ended (app_exit {reason}), the uninstall row and question,
// and the one line that tells an updated install about dictation.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStats, EVENTS, EXIT_REASONS, HOOKS } = require('../src/stats');
const { createRetention } = require('../src/retention');

const root = path.join(__dirname, '..', '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8').replace(/\r\n/g, '\n');
const index = read('companion/index.js');
const main = read('src/main-companion.js');

function statsRig(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nus-stats-exit-'));
  const calls = [];
  let settings = { sendStats: opts.off ? false : true };
  let status = opts.status ?? 204;
  const stats = createStats({ userData: dir, settings: { get: () => settings, set: (p) => { settings = { ...settings, ...p }; } }, appVersion: '0.1.38', platform: 'win32', packaged: true, env: {},
    fetch: async (url, init) => { const b = JSON.parse(init.body); calls.push(b); if (status === 0) throw new Error('offline'); return { status }; },
    now: () => Date.parse('2026-11-24T10:00:00Z'), setInterval: () => ({ unref() {} }), clearInterval() {}, idleSeconds: () => 0 });
  return { stats, calls, dir, setStatus: (s) => { status = s; }, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('app_exit is a stats event with a fixed list of reasons', () => {
  assert.ok(EVENTS.has('app_exit'));
  assert.deepEqual(EXIT_REASONS, ['quit', 'shutdown', 'update', 'uninstall', 'exam', 'other']);
  assert.ok(HOOKS.includes('dictation_news'));
});

test('exit sends one row per run, a reason off the list becomes other', async () => {
  const r = statsRig();
  await r.stats.exit('quit');
  await r.stats.exit('shutdown');
  assert.deepEqual(r.calls.map((c) => [c.name, c.props]), [['app_exit', { reason: 'quit' }]], 'the first reason stands');
  r.done();
  const r2 = statsRig();
  await r2.stats.exit('rage quit');
  assert.deepEqual(r2.calls[0].props, { reason: 'other' });
  r2.done();
});

test('an exit with no network is kept on disk and told at the next start', async () => {
  const r = statsRig({ status: 0 });
  await r.stats.exit('quit');
  assert.equal(r.stats.queued().length, 1, 'kept');
  assert.equal(r.stats.queued()[0].name, 'app_exit');
  r.setStatus(204);
  await r.stats.flush();
  assert.equal(r.stats.queued().length, 0, 'sent and dropped');
  assert.equal(r.calls.filter((c) => c.name === 'app_exit' && c.props.reason === 'quit').length, 3, 'two tries offline, then the send that landed');
  r.done();
});

test('stop(reason) sends the exit with the session; stop() with no reason sends none; stats off sends nothing', async () => {
  const r = statsRig();
  await r.stats.stop('update');
  assert.ok(r.calls.some((c) => c.name === 'app_exit' && c.props.reason === 'update'));
  r.done();
  const r2 = statsRig();
  await r2.stats.stop();
  assert.ok(!r2.calls.some((c) => c.name === 'app_exit'), 'a test run passes no reason');
  r2.done();
  const r3 = statsRig({ off: true });
  await r3.stats.exit('uninstall');
  await r3.stats.stop('quit');
  assert.equal(r3.calls.filter((c) => c.name === 'app_exit').length, 0);
  assert.equal(r3.stats.queued().length, 0, 'nothing kept when stats are off');
  r3.done();
});

test('the host gives a reason for each way out: Quit Nūs, an update, an exam, Windows shutting down', () => {
  assert.match(index, /function userQuit\(\) \{\n  try \{ if \(typeof hooks\.onExit === 'function'\) hooks\.onExit\('quit'\); \}/);
  assert.match(index, /\{ label: 'Quit Nūs', click: \(\) => userQuit\(\) \}/, 'the tray');
  assert.match(index, /p\.action === 'menu-quit'\) \{ userQuit\(\); return; \}/, 'the Knot menu');
  assert.doesNotMatch(index, /label: 'Quit Nūs', click: \(\) => app\.quit\(\)/);
  assert.match(main, /onExit: reason => noteExit\(reason\),/);
  assert.match(main, /quit: \(\) => \{ noteExit\('update'\); app\.quit\(\); \},/, 'the one-click update');
  assert.match(main, /is open, standing down'\);\n  noteExit\('exam'\);/);
  assert.match(main, /w\.on\('session-end', \(\) => \{ noteExit\('shutdown'\); stats\.exit\('shutdown'\)/, 'sent at once: the process may not reach will-quit');
  assert.match(main, /stats\.stop\(SMOKE \? '' : exitReason \|\| 'other'\)/, 'a smoke test sends no exit');
  assert.match(main, /function noteExit\(reason\) \{ if \(!exitReason\) exitReason = String\(reason \|\| ''\); \}/, 'the first reason stands');
});

test('the uninstall run sends one row and ends: no window, no sign-in, at most 4 s', () => {
  assert.match(main, /const UNINSTALLED = process\.argv\.includes\('--uninstalled'\);/);
  const ready = main.slice(main.indexOf('app.whenReady().then(async () => {'));
  const block = ready.slice(0, ready.indexOf('const exam = await examGuard.check();'));
  assert.match(block, /if \(UNINSTALLED\) \{/);
  assert.match(block, /setTimeout\(done, 4000\);/);
  assert.match(block, /stats\.exit\('uninstall'\)\.catch\(\(\) => \{\}\)\.finally\(done\);\n    return;/);
});

test('the uninstaller: only on a real uninstall, the app once with --uninstalled, stopped after 8 s, then the one question', () => {
  const nsh = read('companion/installer/uninstall.nsh');
  const cfg = read('electron-builder.companion.config.js');
  assert.match(cfg, /include: 'companion\/installer\/uninstall\.nsh'/);
  assert.match(cfg, /'!companion\/installer\/\*\*'/, 'kept out of the app package');
  assert.match(nsh, /!macro customUnInstall\n  \$\{ifNot\} \$\{isUpdated\}/, 'never on an update');
  assert.match(nsh, /\$\{GetOptions\} \$R8 "\/S" \$R9\n    \$\{if\} \$\{Errors\}/, 'never on a scripted silent uninstall');
  assert.match(nsh, /-ArgumentList '--uninstalled'/);
  assert.match(nsh, /WaitForExit\(8000\)\) \{ Stop-Process/);
  assert.match(nsh, /ExecShell "open" "https:\/\/potlakai\.github\.io\/nus\/feedback\.html\?why=uninstall"/);
  assert.doesNotMatch(nsh, /install_id|installId/, 'nothing from this computer goes with the question');
});

test('dictation news: due once, never after the tour card or a landed dictation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nus-rt-dict-'));
  const R = createRetention({ file: path.join(dir, 'retention.json') });
  assert.equal(R.dictationNewsDue(), true);
  R.dictationNewsShown();
  assert.equal(R.dictationNewsDue(), false);
  const R2 = createRetention({ file: path.join(dir, 'r2.json') });
  R2.dictationKnown();
  assert.equal(R2.dictationNewsDue(), false, 'already knew');
  const R3 = createRetention({ file: path.join(dir, 'r2.json') });
  assert.equal(R3.dictationNewsDue(), false, 'kept on disk');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the host: the news line only for the on half by install id, in the shared pop-up budget, once', () => {
  const fn = index.slice(index.indexOf('function rtTryDictationNews()'), index.indexOf('function rtTryQuietMoment()'));
  assert.match(fn, /if \(!dictationOn\(\) \|\| dictWhy\(\) !== 'arm-on'\) return false;/, 'not the off half, not a person who switched it on');
  assert.match(fn, /rtShow\('dictation_news', 'new', DICTATION_NEWS/, 'rtShow spends the shared budget and counts hook_shown');
  assert.match(fn, /if \(shown\) R\.dictationNewsShown\(\);/);
  assert.match(index, /const DICTATION_NEWS = 'New: I can type for you\. Click into a text box, hold Ctrl and Win, say it, and let go\.';/);
  assert.doesNotMatch(index.match(/const DICTATION_NEWS = '[^']*'/)[0], /[—–]/, 'no dashes');
  const quiet = index.slice(index.indexOf('function rtTryQuietMoment()'));
  assert.ok(quiet.indexOf('rtTryDictationNews()') > quiet.indexOf("rtShow('knot_report'") && quiet.indexOf('rtTryDictationNews()') < quiet.indexOf('R.winback('), 'after the weekly report, before the win-back lines');
  assert.match(index, /function tourDictateCard\(\) \{\n  tour\.dictateShown = true;\n  try \{ getRetention\(\)\.dictationKnown\(\); \}/);
  assert.match(index, /if \(outcome === 'ok'\) \{\n      try \{ getRetention\(\)\.dictationKnown\(\); \}/);
});
