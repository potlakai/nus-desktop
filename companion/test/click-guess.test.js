'use strict';
// companion/src/guide/click-guess.js: on a Mac (no click watcher) a step counts as clicked when the
// cursor was on the target and then the screen changed. And the screen-read failure line on a Mac.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { guessClick, near } = require('../src/guide/click-guess');

const rect = { x: 100, y: 100, w: 80, h: 30 };
const frame = (v) => new Uint8Array(64).fill(v);
// A fake clock: sleep moves time on at once.
function clock() { let t = 0; return { now: () => t, sleep: async (ms) => { t += ms; } }; }

test('cursor on the control, then the screen changes: a click', async () => {
  const c = clock(); let ticks = 0;
  const r = await guessClick({ rect, ...c, cursor: () => ({ x: 120, y: 110 }), grab: async () => frame(++ticks > 3 ? 200 : 10), limitMs: 20000 });
  assert.equal(r.clicked, true);
});

test('the screen changes with the cursor elsewhere: not a click, and the new screen is the baseline', async () => {
  const c = clock(); let ticks = 0;
  const r = await guessClick({ rect, ...c, cursor: () => ({ x: 900, y: 700 }), grab: async () => frame(++ticks > 3 ? 200 : 10), limitMs: 6000 });
  assert.equal(r.clicked, false); assert.equal(r.why, 'time');
});

test('the cursor passed over the control long before the change: not a click', async () => {
  const c = clock(); let ticks = 0;
  const cursor = () => (c.now() < 600 ? { x: 120, y: 110 } : { x: 900, y: 700 });
  const r = await guessClick({ rect, ...c, cursor, grab: async () => frame(++ticks > 12 ? 200 : 10), limitMs: 9000 });
  assert.equal(r.clicked, false);
});

test('a step that moved on stops the guess; no screen at all never counts as a click', async () => {
  const c = clock(); let stale = false;
  setImmediate(() => { stale = true; });
  let r = await guessClick({ rect, ...c, cursor: () => ({ x: 120, y: 110 }), grab: async () => { await new Promise((z) => setImmediate(z)); return frame(10); }, isStale: () => stale });
  assert.equal(r.why, 'stale');
  r = await guessClick({ rect, ...clock(), cursor: () => ({ x: 120, y: 110 }), grab: async () => null, limitMs: 3000 });
  assert.equal(r.clicked, false);
});

test('near() gives a little room around the control', () => {
  assert.ok(near({ x: 95, y: 98 }, rect));
  assert.ok(!near({ x: 60, y: 98 }, rect));
});

test('the guide uses the guess only where the host says so, and the Mac capture line names System Settings', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'guide', 'session.js'), 'utf8');
  assert.match(src, /if \(!probe\) \{ this\.watchWithoutProbe\(\); return; \}/);
  assert.match(src, /if \(!this\.d\.guessClicks/);
  assert.match(src, /Screen & System Audio Recording/);
  assert.match(src, /'I could not read the screen\. On Windows, allow screen capture for J.A.R.V.I.S and try again\.'/, 'the Windows line is unchanged');
  const main = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.match(main, /guessClicks: IS_MAC,/);
});
