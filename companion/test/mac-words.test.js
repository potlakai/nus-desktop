'use strict';
// The Mac's words: what the model is told about the computer (companion/src/computer-words.js),
// the dashboard's text pass (companion/renderer/mac-words.js), and the TextEdit hello
// (companion/src/mac-hello.js). Windows must stay exactly as it was.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');
const CW = require('../src/computer-words');
const MH = require('../src/mac-hello');

test('Windows requests are untouched: same instructions, same object', () => {
  const params = { system: 'You are the Knot.', turns: [] };
  assert.equal(CW.paramsWithComputer(params, 'win32'), params);
  assert.equal(CW.withComputer('You are the Knot.', 'win32'), 'You are the Knot.');
  assert.equal(CW.withComputer(undefined, 'win32'), undefined);
  assert.equal(CW.computerLine('win32'), '');
});

test('a Mac request says macOS, with Mac keys and places, after the original instructions', () => {
  const out = CW.paramsWithComputer({ system: 'You are the Knot.', turns: [1] }, 'darwin');
  assert.ok(out.system.startsWith('You are the Knot.\n\n'));
  for (const w of ['macOS', 'Command', 'Option', 'Finder', 'menu bar', 'System Settings', 'Control-click']) assert.match(out.system, new RegExp(w));
  assert.match(out.system, /never Ctrl\+C/);
  assert.deepEqual(out.turns, [1]);
  assert.equal(CW.withComputer('', 'darwin'), CW.MAC_LINE, 'no instructions: the line alone');
});

test('llm.js adds the line in every stream and complete path, and only through paramsWithComputer', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'llm.js'), 'utf8');
  assert.equal((src.match(/\.\.\.paramsWithComputer\(params\)/g) || []).length, 4);
  assert.doesNotMatch(src, /\.\.\.params[,} ]/, 'no path spreads the raw params any more');
});

function loadMacWords(platform) {
  const ctx = { window: {}, navigator: { platform, userAgent: '' }, document: { readyState: 'loading', addEventListener() {} } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'renderer', 'mac-words.js'), 'utf8'), ctx);
  return ctx.window.NusMacWords;
}
test('the dashboard text pass: Mac words on a Mac, nothing changed on Windows', () => {
  const mac = loadMacWords('MacIntel'), win = loadMacWords('Win32');
  assert.equal(mac.mac, true); assert.equal(win.mac, false);
  const line = 'Off, the Windows voice speaks.';
  assert.equal(mac.text(line), 'Off, the Mac voice speaks.');
  assert.equal(win.text(line), line);
  assert.equal(mac.text('Allow it in Windows Settings > Privacy > Microphone'), 'Allow it in System Settings > Privacy & Security > Microphone');
  assert.match(mac.text('Ctrl+Alt held together is the default. Typed chords also work: Ctrl+Alt+Space, Ctrl+Shift+M, Alt+Shift+Space, Ctrl+Alt+M.'), /Control\+Option\+Space/);
  assert.doesNotMatch(mac.text('the Windows default, with the app version and Windows version'), /Windows/);
});

test('the TextEdit hello: one osascript, the text as its last argument, no keystrokes', () => {
  const a = MH.args('Hi\nthere');
  assert.equal(a[a.length - 1], 'Hi\nthere');
  const script = MH.SCRIPT.join('\n');
  assert.match(script, /tell application "TextEdit"/);
  assert.match(script, /make new document/);
  assert.doesNotMatch(script, /System Events|keystroke|key code/, 'no Accessibility-only commands');
  assert.match(script, /frontmost is false/);
});

test('the hello reads osascript: typed, stopped, refused, and anything else is a quiet skip', () => {
  assert.deepEqual(MH.readResult(0, 'typed 64\n', ''), { outcome: 'typed', why: '', typed: 64 });
  assert.equal(MH.readResult(0, 'stopped 12 front', '').why, 'TextEdit left the front');
  assert.equal(MH.readResult(0, 'stopped 3 typed', '').typed, 3);
  assert.equal(MH.readResult(1, '', 'execution error: Not authorized to send Apple events to TextEdit. (-1743)').why, 'Automation for TextEdit not allowed');
  assert.equal(MH.readResult(1, '', 'something odd').outcome, 'skipped');
});

function fakeSpawn(behave) {
  const calls = [];
  const spawn = (cmd, args) => { const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.kill = () => { c.killed = true; setImmediate(() => c.emit('close', null)); }; calls.push({ cmd, args, c }); setImmediate(() => behave(c)); return c; };
  return { spawn, calls };
}
test('runMacHello: a refused Automation prompt skips quietly; Esc and the time limit stop it', async () => {
  let f = fakeSpawn((c) => { c.stderr.emit('data', 'Not authorized to send Apple events to TextEdit. (-1743)'); c.emit('close', 1); });
  let r = await MH.runMacHello('Hi', { spawn: f.spawn });
  assert.equal(r.outcome, 'skipped'); assert.equal(f.calls[0].cmd, 'osascript');
  f = fakeSpawn((c) => { c.stdout.emit('data', 'typed 2'); c.emit('close', 0); });
  r = await MH.runMacHello('Hi', { spawn: f.spawn });
  assert.equal(r.outcome, 'typed');
  f = fakeSpawn(() => {});
  let esc = false; setTimeout(() => { esc = true; }, 30);
  r = await MH.runMacHello('Hi', { spawn: f.spawn, aborted: () => esc });
  assert.equal(r.outcome, 'stopped'); assert.ok(f.calls[0].c.killed);
  f = fakeSpawn(() => {});
  r = await MH.runMacHello('Hi', { spawn: f.spawn, limitMs: 500 });
  assert.equal(r.outcome, 'skipped'); assert.match(r.why, /no answer/);
});

// Round 3 (2026-11-16): the same words in the Knot's overlay, the main process's messages and the
// model's app guide, from one list (renderer/mac-words.js); Windows still untouched.
const MW = require('../renderer/mac-words.js');
test('the main process loads the same list, and its text pass knows the Mac keys and places', () => {
  const cases = [
    ['Press Ctrl+Shift+Space to bring it back, or use the tray icon.', 'Press Control+Shift+Space to bring it back, or use the Nūs icon in the menu bar.'],
    ['That is the dashboard. The tray icon opens it any time.', 'That is the dashboard. The Nūs icon in the menu bar opens it any time.'],
    ['You can change this later from the tray or on the dashboard.', 'You can change this later from the Nūs icon in the menu bar or on the dashboard.'],
    ['Hold Ctrl+Alt+Space to talk.', 'Hold Control+Option+Space to talk.'],
    ['Ctrl+Shift+T selects what is under the cursor.', 'Control+Shift+T selects what is under the cursor.'],
    ['My voice did not download. The Windows voice stays for now.', 'My voice did not download. The Mac voice stays for now.'],
    ['Windows is blocking the microphone. Allow it in Windows Settings, Privacy, Microphone, then press Try again.', 'macOS is blocking the microphone. Allow it in System Settings, Privacy & Security, Microphone, then press Try again.'],
    ['Check it is not muted: Windows Settings, System, Sound, Input.', 'Check it is not muted: System Settings, Sound, Input.'],
    ['It runs on this PC with no AI model.', 'It runs on this Mac with no AI model.'],
  ];
  for (const [win, mac] of cases) assert.equal(MW.macText(win), mac);
  for (const [, mac] of cases) assert.doesNotMatch(mac, /Windows|\bCtrl\b|\bPC\b|tray/, mac);
  assert.equal(MW.macText('Command+Shift+M works too.'), 'Command+Shift+M works too.', 'Mac words stay as they are');
  // The Mac default line names the Mac's real fallbacks (CommandOrControl is Command there).
  assert.match(MW.macText('Ctrl+Alt held together is the default. Typed chords also work: Ctrl+Alt+Space, Ctrl+Shift+M, Alt+Shift+Space, Ctrl+Alt+M.'), /Control\+Option\+K, Command\+Shift\+M\./);
});

test('the message pass changes words only: ids, urls and other fields stay, nested labels change', () => {
  const data = { text: 'Use the tray icon.', id: 'tray-icon', url: 'https://x/tray', actions: [{ id: 'rt-ok', label: 'Open from the tray' }], n: 3 };
  const out = MW.uiText(data);
  assert.equal(out.text, 'Use the menu bar icon.'.replace('the menu bar icon', 'the Nūs icon in the menu bar'));
  assert.equal(out.id, 'tray-icon'); assert.equal(out.url, 'https://x/tray'); assert.equal(out.n, 3);
  assert.equal(out.actions[0].label, 'Open from the Nūs icon in the menu bar'); assert.equal(out.actions[0].id, 'rt-ok');
  assert.equal(data.text, 'Use the tray icon.', 'the original is not changed');
  const plain = { text: 'Nothing to change here.' };
  assert.equal(MW.uiText(plain), plain, 'nothing to change: the same object back');
});

test('the overlay loads the Mac words first, and the main process passes its messages through them on a Mac only', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  const at = (s) => html.indexOf(s);
  assert.ok(at('mac-words.js') > 0 && at('mac-words.js') < at('renderer.js'));
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.match(src, /if \(IS_MAC && data && typeof data === 'object' && channel !== 'llm:token' && channel !== 'llm:done'\) data = MacWords\.uiText\(data\);/);
  assert.match(src, /return IS_MAC \? MacWords\.macText\(guide\) : guide;/);
  const guide = src.slice(src.indexOf('function appGuide('), src.indexOf('function appGuide(') + 400);
  assert.doesNotMatch(guide, /\x08/, 'no stray backspace characters in its key regexes');
});

test('a Mac is never offered start-at-login, which only works on Windows', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const fn = src.slice(src.indexOf('function rtTryAutostart('), src.indexOf('function rtTryAutostart(') + 300);
  assert.match(fn, /if \(IS_MAC\) \{ rtAutostartPending = false; return false; \}/);
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main-companion.js'), 'utf8');
  // Since 0.1.30 the login item lives in src/autostart.js, which only acts on a packaged Windows build.
  assert.match(main, /const autostart = createAutostart\(\{ app, log: /);
  const as = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'autostart.js'), 'utf8');
  assert.match(as, /const live = \(\) => !!app\.isPackaged && platform === 'win32';/, 'start-at-login is still Windows only');
});

test('the Mac tour says hold and let go, with Mac key names', () => {
  const T = require('../src/tour');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'tour.js'), 'utf8');
  assert.doesNotMatch(src, /press them again|again to send/);
  assert.deepEqual(T.keycaps('Control+Alt+Space', true), ['Control', 'Option', 'Space']);
  assert.deepEqual(T.keycaps('Control+Alt', false), ['Ctrl', 'Alt'], 'Windows unchanged');
});
