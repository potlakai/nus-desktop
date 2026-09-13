const test = require('node:test');
const assert = require('node:assert/strict');
const { registerInspectionShortcut, resolveInspectionHit, usableHit, pointContext, INSPECT_SHORTCUT } = require('../src/inspection-input');
const bounds = { width: 1200, height: 800 };
const control = { name: 'Settings', bbox: { x: 100, y: 100, w: 80, h: 30 } };

test('an occupied Ctrl+Shift+T reports failure instead of pretending it registered', () => {
  const r = registerInspectionShortcut({ isRegistered: () => false, register: () => false }, () => {});
  assert.equal(r.ok, false); assert.match(r.error, /another app or another Nūs build/);
});
test('registration can recover after the other app releases the shortcut', () => {
  let available = false, captured;
  const api = { isRegistered: () => false, register: (key, handler) => { captured = { key, handler }; return available; } };
  const handler = () => {};
  assert.equal(registerInspectionShortcut(api, handler).ok, false);
  available = true;
  assert.equal(registerInspectionShortcut(api, handler).ok, true);
  assert.equal(captured.key, INSPECT_SHORTCUT); assert.equal(captured.handler, handler);
});
test('own registered shortcut is not replaced and registration exceptions are surfaced', () => {
  assert.equal(registerInspectionShortcut({ isRegistered: () => true, register: () => assert.fail('duplicate registration') }, () => {}).ok, true);
  assert.equal(registerInspectionShortcut({ isRegistered: () => { throw new Error('OS failure'); } }, () => {}).ok, false);
});
test('cold accessibility lookup retries the same hotkey point, not a later cursor position', async () => {
  const point = { x: 120, y: 115 }; const seen = []; let count = 0;
  const result = await resolveInspectionHit({ point, bounds, sleep: async () => { point.x = 999; }, lookup: async p => { seen.push(p); return ++count === 1 ? { bbox: { x: 0, y: 0, w: 1200, h: 800 } } : control; } });
  assert.equal(result, control); assert.deepEqual(seen, [{ x: 120, y: 115 }, { x: 120, y: 115 }]);
});
test('a valid control points without retry; missing controls stop after two attempts', async () => {
  assert.equal(await resolveInspectionHit({ point: { x: 0, y: 0 }, bounds, lookup: async () => control, sleep: () => assert.fail('unnecessary retry') }), control);
  let calls = 0;
  assert.equal(await resolveInspectionHit({ point: { x: 0, y: 0 }, bounds, lookup: async () => { calls++; return null; }, sleep: async () => {} }), null);
  assert.equal(calls, 2);
});
test('cancelled control lookup never publishes a late target', async () => {
  const abort = new AbortController();
  const result = await resolveInspectionHit({ point: { x: 0, y: 0 }, bounds, signal: abort.signal, lookup: async () => { abort.abort(); return control; } });
  assert.equal(result, null);
});
test('invalid or out-of-display controls are never treated as precise targets', () => {
  assert.equal(usableHit({ bbox: { x: 1190, y: 10, w: 100, h: 30 } }, bounds), false);
  assert.equal(usableHit({ bbox: { x: NaN, y: 10, w: 100, h: 30 } }, bounds), false);
  assert.equal(usableHit(control, bounds), true);
});

test('a non-control spot gets bounded nearby context and an independent point marker', () => {
  const nearby = pointContext({ x: 600, y: 400 }, { x: 0, y: 0, ...bounds });
  assert.deepEqual(nearby.bbox, { x: 360, y: 240, w: 480, h: 320 });
  assert.deepEqual(nearby.marker, { x: 596, y: 396, w: 8, h: 8 });
  assert.deepEqual(nearby.point, { x: 600, y: 400 });
});

test('nearby context stays on screen at every edge, including negative monitor origins', () => {
  const display = { x: -1200, y: 40, ...bounds };
  for (const point of [{ x: -1200, y: 40 }, { x: -1, y: 839 }, { x: -1200, y: 839 }, { x: -1, y: 40 }]) {
    const nearby = pointContext(point, display);
    assert.equal(usableHit({ bbox: nearby.bbox }, display), true);
    assert.equal(usableHit({ bbox: nearby.marker }, display), true);
    assert.ok(nearby.point.x >= nearby.bbox.x && nearby.point.x <= nearby.bbox.x + nearby.bbox.w);
    assert.ok(nearby.point.y >= nearby.bbox.y && nearby.point.y <= nearby.bbox.y + nearby.bbox.h);
  }
});

test('nearby context never silently captures another display or the whole display', () => {
  assert.throws(() => pointContext({ x: 1200, y: 10 }, { x: 0, y: 0, ...bounds }), /display/);
  assert.throws(() => pointContext({ x: NaN, y: 10 }, { x: 0, y: 0, ...bounds }), /display/);
  const tiny = pointContext({ x: 10, y: 10 }, { x: 0, y: 0, width: 100, height: 100 });
  assert.equal(tiny.bbox.w * tiny.bbox.h, 2500);
});

test('a protected field stops inspection instead of becoming nearby-area context', async () => {
  const blocked = { blocked: true };
  const hit = await resolveInspectionHit({ point: { x: 1, y: 1 }, bounds, lookup: async () => blocked, sleep: () => assert.fail('must not retry a protected field') });
  assert.equal(hit, blocked);
});
