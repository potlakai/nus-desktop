'use strict';
// The bare Ctrl+Alt talk key (2026-11-02): the chord tracker, the probe's part,
// and the Companion's wiring.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { VK, MOD_VKS, modifierChord, createChordTracker } = require('../src/voice/ptt-chord');
const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

test('a modifier chord is two or more modifiers and nothing else', () => {
  assert.deepEqual(modifierChord('Control+Alt'), ['control', 'alt']);
  assert.deepEqual(modifierChord('CommandOrControl+Alt'), ['control', 'alt']);
  assert.deepEqual(modifierChord('ctrl + alt'), ['control', 'alt']);
  assert.deepEqual(modifierChord('Control+Shift'), ['control', 'shift']);
  assert.equal(modifierChord('CommandOrControl+Alt+Space'), null, 'a real key makes it a hotkey');
  assert.equal(modifierChord('Control'), null, 'one modifier is not a chord');
  assert.equal(modifierChord(''), null);
});

test('hold Ctrl then Alt is one down; letting either go is one up; repeats and order do not matter', () => {
  const t = createChordTracker('Control+Alt');
  assert.equal(t.onKey(VK.lcontrol, true), null);
  assert.equal(t.onKey(VK.lalt, true), 'down');
  assert.equal(t.onKey(VK.lalt, true), null, 'a repeat is not a second press');
  assert.equal(t.held, true);
  assert.equal(t.onKey(VK.lcontrol, false), 'up');
  assert.equal(t.onKey(VK.lalt, false), null, 'the second release is not a second up');
  // Alt first works the same, with the generic codes the probe may send.
  assert.equal(t.onKey(VK.alt, true), null);
  assert.equal(t.onKey(VK.control, true), 'down');
  assert.equal(t.onKey(VK.alt, false), 'up');
  t.reset();
  assert.equal(t.held, false);
});

test('AltGr (left Ctrl plus right Alt) is typing, never the talk key; the other pairs still are', () => {
  const t = createChordTracker('Control+Alt');
  assert.equal(t.onKey(VK.lcontrol, true), null);
  assert.equal(t.onKey(VK.ralt, true), null, 'AltGr');
  assert.equal(t.onKey(VK.lalt, true), 'down', 'left Alt joins: a real chord');
  assert.equal(t.onKey(VK.lalt, false), 'up');
  assert.equal(t.onKey(VK.ralt, false), null);
  assert.equal(t.onKey(VK.lcontrol, false), null);
  assert.equal(t.onKey(VK.rcontrol, true), null);
  assert.equal(t.onKey(VK.ralt, true), 'down', 'right Ctrl plus right Alt is not AltGr');
  assert.equal(t.onKey(VK.rcontrol, false), 'up');
});

test('keys outside the chord are ignored by the tracker, and the watch list is the modifier codes only', () => {
  const t = createChordTracker('Control+Alt');
  assert.equal(t.onKey(32, true), null);
  assert.equal(t.onKey(27, false), null);
  assert.deepEqual(MOD_VKS.slice().sort((a, b) => a - b), [16, 17, 18, 160, 161, 162, 163, 164, 165], 'nothing but the modifiers is ever watched for the talk key');
});

test('the probe watches the chord keys for as long as it runs, under any other watch, and never installs a hook', () => {
  const { createProbe } = require('../src/win/probe');
  const { EventEmitter } = require('node:events');
  const { PassThrough } = require('node:stream');
  let child;
  const spawn = () => {
    child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.written = [];
    child.stdin = { write: (s) => { child.written.push(JSON.parse(s)); return true; }, end: () => {} };
    child.kill = () => child.emit('exit', 0, null);
    child.reply = (o) => child.stdout.write(JSON.stringify(o) + '\n');
    return child;
  };
  const probe = createProbe({ spawn, platform: 'win32', script: 'fake.ps1' });
  probe.start();
  child.reply({ ev: 'ready', pid: 1 });
  const base = probe.setBase([17, 18]);
  assert.ok(base, 'base keys accepted');
  return (async () => {
    await new Promise((r) => setImmediate(r));
    const first = child.written.find((w) => w.op === 'watch.start');
    assert.ok(first && first.keys.includes(17) && first.keys.includes(18) && first.click === false && first.fg === false, 'armed at once, keys only');
    child.reply({ id: first.id, ok: true });
    const p = probe.watch({ keys: [27], click: true, fg: false });
    const w = child.written[child.written.length - 1];
    assert.deepEqual(w.keys.slice().sort((a, b) => a - b), [17, 18, 27], 'a session watch keeps the chord keys');
    child.reply({ id: w.id, ok: true }); await p;
    const u = probe.unwatch();
    const again = child.written[child.written.length - 1];
    assert.equal(again.op, 'watch.start', 'unwatch falls back to the chord keys instead of stopping');
    assert.deepEqual(again.keys.slice().sort((a, b) => a - b), [17, 18]);
    child.reply({ id: again.id, ok: true }); await u;
    assert.ok(probe.status().watching && probe.status().watching.base, 'status says the base watch is on');
    const ps = read('src', 'win', 'probe.ps1');
    assert.doesNotMatch(ps, /SetWindowsHookEx/, 'still no keyboard hook');
    probe.stop();
  })();
});

test('the Companion makes Ctrl+Alt the default, keeps the old chord as a choice, and drops a short empty hold quietly', () => {
  const main = read('index.js');
  assert.match(main, /const DEFAULT_PTT_SHORTCUT = 'Control\+Alt';/);
  assert.match(main, /const LEGACY_PTT_SHORTCUT = 'CommandOrControl\+Alt\+Space';/);
  const reg = main.slice(main.indexOf('function registerPttShortcut()'), main.indexOf('// -------- guide harness'));
  assert.match(reg, /modifierChord\(wanted\)/, 'a modifier chord takes the probe path');
  // 0.1.37: the watch list is set in one place, applyProbeBase, which adds the Win keys only
  // when dictation is on (companion/test/dictate.test.js checks that it asks for MOD_VKS otherwise).
  assert.match(reg, /ptt\.chord = createChordTracker\(wanted\);\n\s+applyProbeBase\(\);/, 'the modifiers are watched for as long as the probe runs');
  assert.match(main, /probe\.setBase\(on \? MOD_VKS\.concat\(Dictate\.WIN_VKS\) : MOD_VKS\)/);
  assert.match(reg, /ptt\.chord = createChordTracker\(/);
  assert.match(reg, /LEGACY_PTT_SHORTCUT/, 'without the probe the old hotkey is registered instead');
  const keys = main.slice(main.indexOf("probe.on('key', (e) => {"), main.indexOf("probe.on('fg'"));
  assert.match(keys, /const r = ptt\.chord\.onKey\(vk, !!e\.down\)/);
  // 0.1.37: the talk key does not start while a dictation (Ctrl + Win) is held or a Win key is down.
  assert.match(keys, /if \(r === 'down' && !dict\.held && !\(dict\.tracker && dict\.tracker\.winDown\)\) pttStart\(\);/);
  assert.match(keys, /if \(r === 'up' && ptt\.held && !OPEN_MIC\) pttStop\('release'\);/);
  const stop = main.slice(main.indexOf('async function pttStop('), main.indexOf('// Reflex first.'));
  assert.match(stop, /PTT_TAP_MS/, 'a hold shorter than a tap with nothing heard is an app shortcut, not an ask');
  const set = main.slice(main.indexOf('function setPttShortcut('), main.indexOf('// -------- IPC'));
  assert.match(set, /modifierChord\(next\)/, 'Settings accepts a modifier-only chord');
  const defaults = read('src', 'store.js');
  assert.match(defaults, /ptt: 'Control\+Alt'/);
});
