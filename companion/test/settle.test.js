'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('../src/guide/settle');
const V = require('../src/guide/verify');

function bitmap(w, h, fn) {
  const buf = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = fn(x, y); const o = (y * w + x) * 4; buf[o] = buf[o + 1] = buf[o + 2] = v; buf[o + 3] = 255; }
  return buf;
}

test('grayThumb box-averages any bitmap to the fingerprint size, with an optional crop', () => {
  const flat = S.fingerprint(bitmap(640, 400, () => 100), 640, 400);
  assert.equal(flat.length, S.FP_W * S.FP_H);
  assert.ok(flat.every((v) => v === 100));
  const half = S.fingerprint(bitmap(640, 400, (x) => (x < 320 ? 0 : 200)), 640, 400);
  assert.equal(half[0], 0); assert.equal(half[S.FP_W - 1], 200);
  const look = S.glance(bitmap(640, 400, (x) => (x < 320 ? 0 : 200)), 640, 400, { x: 320, y: 0, width: 320, height: 400 });
  assert.ok(look.every((v) => v === 200), 'the crop sees only the right half');
});

test('difference and changed: a tick mark counts, JPEG-grade noise does not', () => {
  const a = S.glance(bitmap(320, 200, () => 90), 320, 200);
  const noisy = S.glance(bitmap(320, 200, (x, y) => 90 + ((x * 7 + y * 3) % 5)), 320, 200);
  assert.equal(S.changed(a, noisy), false, 'a few gray levels everywhere is noise');
  assert.ok(S.difference(a, noisy) < 4);
  const tick = S.glance(bitmap(320, 200, (x, y) => (x >= 150 && x < 162 && y >= 90 && y < 102 ? 0 : 90)), 320, 200);
  assert.equal(S.changed(a, tick), true, 'a 12 px tick inside the glance moves enough pixels');
  assert.equal(S.difference(a, new Uint8Array(3)), 255, 'unlike sizes are fully different');
});

test('settleSignature masks digits and snaps positions to the grid', () => {
  const els = [{ type: 'Button', name: 'Save', rect: { x: 100, y: 50, w: 40, h: 20 } }, { type: 'Text', name: 'Updated 2 min ago', rect: { x: 10, y: 10, w: 100, h: 10 } }];
  const nudged = [{ type: 'Button', name: 'Save', rect: { x: 103, y: 52, w: 40, h: 20 } }, { type: 'Text', name: 'Updated 7 min ago', rect: { x: 10, y: 10, w: 100, h: 10 } }];
  assert.equal(S.settleSignature(els), S.settleSignature(nudged));
  const moved = [{ type: 'Button', name: 'Save', rect: { x: 100, y: 400, w: 40, h: 20 } }];
  assert.notEqual(S.settleSignature(els), S.settleSignature(moved));
});

function clockRig(frames) {
  let t = 0, i = 0;
  const grab = async () => frames[Math.min(i++, frames.length - 1)];
  const sleep = async (ms) => { t += ms; };
  return { grab, sleep, now: () => t, reads: () => i };
}
const flat = (v) => new Uint8Array(S.FP_W * S.FP_H).fill(v);

test('the watcher returns as soon as the screen has moved and then held still', async () => {
  const r = clockRig([flat(10), flat(10), flat(90), flat(90), flat(90)]);
  const w = new S.ScreenWatcher({ grab: r.grab, sleep: r.sleep, now: r.now, interval: 150 });
  const out = await w.waitForChange(4000, flat(10));
  assert.equal(out.changed, true); assert.equal(out.settled, true);
  assert.ok(out.ms < 1000); assert.equal(r.reads(), 4);
});

test('a screen that never changes waits out the cap and says so', async () => {
  const r = clockRig([flat(10)]);
  const w = new S.ScreenWatcher({ grab: r.grab, sleep: r.sleep, now: r.now, interval: 150 });
  const out = await w.waitForChange(1500, flat(10));
  assert.equal(out.changed, false); assert.equal(out.settled, false); assert.equal(out.ms, 1500);
});

test('a screen that keeps moving is reported as moved but not settled; a stale check ends early', async () => {
  let v = 0;
  const grab = async () => flat((v += 30) % 256);
  let t = 0;
  const w = new S.ScreenWatcher({ grab, sleep: async (ms) => { t += ms; }, now: () => t, interval: 150 });
  const out = await w.waitForChange(600, flat(0));
  assert.equal(out.changed, true); assert.equal(out.settled, false);
  let n = 0;
  const early = await w.waitForChange(600, flat(0), () => ++n > 1);
  assert.equal(early.stale, true);
});

test('without a baseline the first frame becomes the baseline', async () => {
  const r = clockRig([flat(10), flat(80), flat(80)]);
  const w = new S.ScreenWatcher({ grab: r.grab, sleep: r.sleep, now: r.now });
  const out = await w.waitForChange(4000, null);
  assert.equal(out.settled, true);
});

test('screenChanged understands gray fingerprints and still the old bit hashes', () => {
  const a = { kind: 'gray', whole: flat(50), crop: S.glance(bitmap(320, 200, () => 90), 320, 200) };
  const same = { kind: 'gray', whole: flat(51), crop: S.glance(bitmap(320, 200, () => 92), 320, 200) };
  assert.equal(V.screenChanged(a, same), false);
  const ticked = { kind: 'gray', whole: flat(51), crop: S.glance(bitmap(320, 200, (x, y) => (x < 20 && y < 20 ? 0 : 90)), 320, 200) };
  assert.equal(V.screenChanged(a, ticked), true, 'a change inside the target crop counts');
  const page = { kind: 'gray', whole: flat(120), crop: a.crop };
  assert.equal(V.screenChanged(a, page), true, 'the whole screen moving counts');
});
