'use strict';
// The Mac beta's tour rules (companion/src/tour.js): which cards a Mac skips, the
// key names it shows, and the typed wording when it cannot hear words.
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../src/tour');

test('a Mac skips the microphone card and the Hands card; Windows skips nothing', () => {
  const mac = { mac: true, macTyped: true };
  assert.equal(T.skipStep(T.STEP.mic, mac), true);
  assert.equal(T.skipStep(T.STEP.hands, mac), true);
  assert.equal(T.skipStep(T.STEP.key, mac), false);
  assert.equal(T.skipStep(T.STEP.mic, { mac: true, macTyped: false }), true, 'a Mac that can hear still skips it: macOS asks at the first talk-key press');
  for (const step of Object.values(T.STEP)) assert.equal(T.skipStep(step, { whisper: false }), false);
});

test('key names: Option and Cmd on a Mac, Ctrl and Alt on Windows', () => {
  assert.deepEqual(T.keycaps('Control+Alt+Space', true), ['Control', 'Option', 'Space']);
  assert.deepEqual(T.keycaps('CommandOrControl+Shift+M', true), ['Command', 'Shift', 'M']);
  assert.deepEqual(T.keycaps('Control+Alt', false), ['Ctrl', 'Alt']);
  assert.deepEqual(T.keycaps('CommandOrControl+Alt+Space', false), ['Ctrl', 'Alt', 'Space']);
});

test('a typed-only Mac is told to click and type, never to hold keys', () => {
  const caps = { mac: true, macTyped: true, whisper: false, source: true, keyReady: true, ptt: 'Control+Alt+Space' };
  for (const step of [T.STEP.guide, T.STEP.done]) {
    const c = T.card(step, { caps });
    assert.match(c.body, /type/i);
    assert.doesNotMatch(c.body + ' ' + c.spoken, /\bhold\b/i);
  }
});

test('a Mac does not offer the feed guard (it needs the Windows probe)', () => {
  const picks = T.firstWins({ mac: true, keyReady: true }).map((w) => w.struggle);
  assert.ok(!picks.includes('feeds') && !picks.includes('homework_start'));
  assert.ok(picks.length >= 1);
  assert.ok(T.firstWins({ keyReady: true }).some((w) => w.struggle === 'feeds'), 'Windows still offers it');
});

// Round 3 (2026-11-16): the Mac hears the keys let go (src/voice/mac-release.js), so its cards say
// hold and let go, like Windows; a quick tap still toggles.
test('a Mac that can hear is told to hold the keys and let go, never to press them again', () => {
  const caps = { mac: true, macTyped: false, whisper: true, source: true, keyReady: true, ptt: 'Control+Alt+Space' };
  for (const step of [T.STEP.key, T.STEP.questions, T.STEP.guide, T.STEP.done]) {
    const c = T.card(step, { caps });
    assert.match(c.body, /\bhold\b/i, 'card ' + step);
    assert.doesNotMatch(c.body + ' ' + c.spoken + ' ' + (c.status || ''), /press (them|the keys) again|again to send/i, 'card ' + step);
  }
  assert.deepEqual(T.card(T.STEP.key, { caps }).keys, ['Control', 'Option', 'Space']);
  assert.match(T.card(T.STEP.key, { caps }).body, /microphone/);
});

test('the lines Fable makes ahead on a Mac are the Mac cards, and Windows keeps its own list', () => {
  const mac = T.cachedLines(true), win = T.cachedLines(false);
  assert.ok(!mac.some((l) => /press them again|press the keys/i.test(l)), 'no press-again line is made on a Mac');
  assert.ok(mac.some((l) => /hold the keys/i.test(l)));
  assert.ok(win.some((l) => /hold the keys/i.test(l)), 'Windows still makes its hold lines');
  assert.ok(!win.some((l) => /press the keys, say your name/i.test(l)));
});

test('the hello card says "That was me" only when the hello typed something', () => {
  assert.match(T.card(T.STEP.hello, { caps: { helloTyped: true } }).body, /That was me/);
  for (const caps of [{ helloTyped: false }, {}, { mac: true }]) assert.doesNotMatch(T.card(T.STEP.hello, { caps }).body + ' ' + T.card(T.STEP.hello, { caps }).spoken, /That was me/i, JSON.stringify(caps));
});
