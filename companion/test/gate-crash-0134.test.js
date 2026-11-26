'use strict';
// 0.1.34. On 2026-11-21 publik answered every new computer "This app has reached its daily
// provisioning cap" (POST /installs, 429 mint_cap_reached). Three things went wrong on our side:
//   1. the gate window treated that answer like "no internet" and stayed hidden for a minute;
//   2. the person started Nūs again, and that second start opened the dashboard before the
//      database existed, which ended Nūs: db.js "Cannot read properties of undefined (reading
//      'prepare')";
// 0.1.34 fixed 1 and 2, and gave the cap its own "Full for today" screen. publik removed the cap the
// same evening, so that screen was taken out again: any answer from publik is drawn at once, in
// publik's own words. Nothing here lets anyone past the gate.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const mod = require('../src/publik/publik');
const G = require('../src/publik/gate-window');

const CAP = 'This app has reached its daily provisioning cap.';
const capScreen = () => mod.gateScreen('unreachable', null, null, CAP);
const offScreen = () => mod.gateScreen('unreachable', null);

test('no answer and an answer are told apart', () => {
  assert.equal(offScreen().body, G.NOT_REACHABLE, 'the module\'s own sentence for no answer');
  assert.equal(G.noAnswer(offScreen()), true);
  assert.equal(G.noAnswer(capScreen()), false, 'publik answered: that is not "no answer"');
  assert.equal(G.noAnswer(mod.gateScreen('unreachable', null, null, 'publik could not set up this computer (500).')), false);
  assert.equal(G.noAnswer(mod.gateScreen('sign_in', null)), false);
});

test('an answer from publik is drawn in its own words, with its Retry button', () => {
  for (const words of [CAP, 'publik could not set up this computer (500).']) {
    const v = G.view(mod.gateScreen('unreachable', null, null, words));
    assert.equal(v.state, 'unreachable'); assert.equal(v.line, words);
    assert.equal(v.headline, '', 'no words of ours on top');
    assert.deepEqual(v.buttons.map((x) => x.label), ['Retry']);
    assert.equal(v.buttons[0].caption, '');
  }
  const off = G.view(offScreen());
  assert.equal(off.state, 'unreachable'); assert.equal(off.line, G.NOT_REACHABLE);
  for (const gone of ['capReached', 'reopensAt', 'FULL']) assert.equal(G[gone], undefined, gone + ' went with the cap');
});

// The window itself, with Electron stood in for. Only what the gate uses.
function fakeElectron() {
  const made = [];
  class BrowserWindow {
    constructor(o) { this.o = o; this.calls = []; this.destroyed = false; this.top = false; this.listeners = {}; made.push(this);
      this.webContents = { isLoading: () => false, send: (ch, v) => { this.calls.push('send:' + ch); this.last = v; }, once() {} }; }
    loadFile() {} on(n, f) { this.listeners[n] = f; } once() {}
    isDestroyed() { return this.destroyed; } destroy() { this.destroyed = true; }
    show() { this.calls.push('show'); } focus() { this.calls.push('focus'); } moveTop() { this.calls.push('moveTop'); }
    isMinimized() { return false; } restore() {} minimize() {} isFocused() { return true; } isVisible() { return true; }
    setAlwaysOnTop(v) { this.top = v; this.calls.push('top:' + v); } isAlwaysOnTop() { return this.top; } flashFrame() {}
  }
  const ipcMain = { on() {}, removeListener() {} };
  return { made, electron: { BrowserWindow, ipcMain, shell: { openExternal() {} }, app: { quit() {}, focus() {} } } };
}
function gateWith(opts) {
  const fake = fakeElectron();
  const id = require.resolve('electron');
  const before = require.cache[id];
  require.cache[id] = { id, filename: id, loaded: true, exports: fake.electron };
  try { return { ui: G.createGateUI(Object.assign({ sleep: async () => {} }, opts)), made: fake.made }; }
  finally { if (before) require.cache[id] = before; else delete require.cache[id]; }
}

test('publik answered with the cap at start: the window is up at once, not after a minute', async () => {
  const seen = [];
  const { ui, made } = gateWith({ now: () => 0, onScreen: (s) => seen.push(s) });
  const answer = ui.show(capScreen());
  await new Promise((r) => setImmediate(r));
  assert.equal(made.length, 1, 'the window was made on the first answer');
  assert.ok(made[0].calls.includes('show'));
  assert.equal(made[0].last.state, 'unreachable');
  assert.equal(made[0].last.line, CAP, 'the sentence publik sent');
  assert.deepEqual(seen, ['unreachable'], 'counted as before');
  assert.equal(await Promise.race([answer, new Promise((r) => setTimeout(() => r('still up'), 20))]), 'still up', 'it waits for the person, it does not retry by itself');
  ui.close();
});

test('no answer at start is still retried quietly, with no window', async () => {
  const { ui, made } = gateWith({ now: () => 0 });
  assert.equal(await ui.show(offScreen()), 'retry');
  assert.equal(made.length, 0);
  ui.close();
});

test('starting Nūs again: a window that is up comes forward; with none yet the next screen is drawn', async () => {
  const a = gateWith({ now: () => 0 });
  assert.equal(a.ui.front(), false, 'nothing to bring forward yet');
  a.ui.show(offScreen());
  await new Promise((r) => setImmediate(r));
  assert.equal(a.made.length, 1, 'the person asked twice: no more quiet waiting');
  assert.equal(a.made[0].last.state, 'unreachable');
  a.made[0].calls.length = 0;
  assert.equal(a.ui.front(), true);
  assert.ok(a.made[0].calls.includes('show') && a.made[0].calls.includes('focus'), 'brought to the front');
  a.ui.close();
});

test('the wiring: a second start before the database is open never opens the dashboard', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main-companion.js'), 'utf8');
  const handler = /app\.on\('second-instance', \(_event, argv\) => \{([\s\S]*?)\n\}\);/.exec(main);
  assert.ok(handler, 'the second-instance handler');
  const body = handler[1];
  const guard = body.indexOf('if (!databaseReady) {'), open = body.indexOf('openHome()');
  assert.ok(guard > -1 && open > -1 && guard < open, 'the database check comes before openHome()');
  assert.match(body, /if \(!databaseReady\) \{[^\n]*gateUi\.front\(\);[^\n]*return; \}/, 'the sign-in window comes forward instead');
  assert.match(main, /const ui = gateUi = require\('\.\.\/companion\/src\/publik\/gate-window'\)\.createGateUI\(/);
  assert.match(main, /ui\.close\(\); gateUi = null;/);
  assert.match(main, /app\.on\('activate', \(\) => \{ if \(databaseReady\) openHome\(\); \}\);/, 'the Mac path was already guarded');
});
