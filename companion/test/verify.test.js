const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../src/guide/verify');

const cap = { width: 1280, height: 720, pxWidth: 2560, pxHeight: 1440, display: { bounds: { x: 0, y: 0, width: 2048, height: 1152 }, scaleFactor: 1.25 } };
const origin = { x: 0, y: 0 };

test('normalized <-> physical <-> window mapping holds at 125% scale', () => {
  const phys = { x: 640, y: 720, w: 256, h: 72 };
  const n = V.normRectFromPhys(phys, cap, origin);
  assert.deepEqual(n, { x: 0.25, y: 0.5, w: 0.1, h: 0.05 });
  assert.deepEqual(V.physRectFromNorm(n, cap, origin), phys);
  const screenToDip = (p) => ({ x: p.x / 1.25, y: p.y / 1.25 });
  const round = (r) => ({ x: +r.x.toFixed(3), y: +r.y.toFixed(3), w: +r.w.toFixed(3), h: +r.h.toFixed(3) });
  const win = V.physRectToWindow(phys, { x: 0, y: 0, width: 2048, height: 1152 }, screenToDip);
  assert.deepEqual(round(win), { x: 512, y: 576, w: 204.8, h: 57.6 });
  const shifted = V.physRectToWindow(phys, { x: 100, y: 50, width: 1, height: 1 }, screenToDip);
  assert.deepEqual(round(shifted), { x: 412, y: 526, w: 204.8, h: 57.6 });
});

test('element targets take the UIA rect verbatim', () => {
  const r = V.reconcile({ target: { kind: 'element', id: 3 }, elements: [{ id: 3, name: 'Submit', type: 'Button', rect: { x: 1, y: 2, w: 3, h: 4 } }] });
  assert.deepEqual(r, { rect: { x: 1, y: 2, w: 3, h: 4 }, name: 'Submit', type: 'Button', source: 'element', verified: true });
  assert.equal(V.reconcile({ target: { kind: 'element', id: 4 }, elements: [] }), null);
});

test('bbox targets need Windows to agree on both name and location; otherwise no thread', () => {
  const bboxPhys = { x: 100, y: 100, w: 100, h: 40 };
  const byName = V.reconcile({ target: { kind: 'bbox', label: 'Submit assignment' }, bboxPhys, fromPoint: { name: 'Submit Assignment', type: 'Button', rect: { x: 400, y: 400, w: 10, h: 10 } } });
  assert.equal(byName, null, 'same name somewhere else is not agreement');
  const byBox = V.reconcile({ target: { kind: 'bbox', label: 'zzz' }, bboxPhys, fromPoint: { name: 'Save', rect: { x: 105, y: 100, w: 100, h: 40 } } });
  assert.equal(byBox, null, 'overlap with a different control is not agreement');
  const agreed = V.reconcile({ target: { kind: 'bbox', label: 'Save' }, bboxPhys, fromPoint: { name: 'Save', rect: { x: 105, y: 100, w: 100, h: 40 } } });
  assert.equal(agreed.source, 'frompoint-name');
  const byFind = V.reconcile({ target: { kind: 'bbox', label: 'Save' }, bboxPhys, fromPoint: null, found: { name: 'Save', rect: { x: 110, y: 105, w: 90, h: 35 } } });
  assert.equal(byFind.source, 'find');
  assert.equal(V.reconcile({ target: { kind: 'bbox', label: 'Save' }, bboxPhys, fromPoint: { name: 'Cancel', rect: { x: 900, y: 900, w: 10, h: 10 } }, found: null }), null);
  const unverified = V.reconcile({ target: { kind: 'bbox', label: 'Save' }, bboxPhys, fromPoint: null, found: null, verified: false });
  assert.equal(unverified.verified, false);
  assert.equal(unverified.source, 'model');
});

test('token overlap and IoU behave', () => {
  assert.equal(V.tokenOverlap('Submit Assignment', 'submit'), 1);
  assert.equal(V.tokenOverlap('Add a Non-Steam Game', 'Browse'), 0);
  assert.equal(V.tokenOverlap('', 'x'), 0);
  assert.equal(V.iou({ x: 0, y: 0, w: 10, h: 10 }, { x: 0, y: 0, w: 10, h: 10 }), 1);
  assert.equal(V.iou({ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 0, w: 10, h: 10 }), 0);
});

test('hashes flag a real change and ignore noise', () => {
  const a = Buffer.alloc(16 * 16 * 4, 0);
  for (let i = 0; i < 16 * 16 * 4; i += 4) { const v = ((i / 4) % 16) < 8 ? 40 : 220; a[i] = a[i + 1] = a[i + 2] = v; a[i + 3] = 255; }
  const b = Buffer.from(a);
  b[0] = 60; b[1] = 60; b[2] = 60;                       // one pixel nudged
  const c = Buffer.from(a);
  for (let i = 0; i < 16 * 16 * 4; i += 4) { const v = ((i / 4) % 16) < 8 ? 220 : 40; c[i] = c[i + 1] = c[i + 2] = v; }
  const ha = V.bitmapHash(a), hb = V.bitmapHash(b), hc = V.bitmapHash(c);
  assert.equal(V.hamming(ha, hb) <= 1, true);
  assert.equal(V.hamming(ha, hc) > 100, true);
  assert.equal(V.screenChanged({ whole: ha, crop: null }, { whole: hb, crop: null }), false);
  assert.equal(V.screenChanged({ whole: ha, crop: ha }, { whole: ha, crop: hc }), true, 'a change inside the target crop counts');
  assert.equal(V.screenChanged(null, { whole: ha }), true);
});

test('click tolerance stays close to every edge, including wide buttons', () => {
  const rect = { x: 100, y: 100, w: 80, h: 30 };
  assert.equal(V.clickHits({ x: 140, y: 115 }, rect), true);
  assert.equal(V.clickHits({ x: 190, y: 115 }, rect), true, 'a little slack around the edge');
  assert.equal(V.clickHits({ x: 400, y: 400 }, rect), false);
  assert.equal(V.clickHits(null, rect), false);
  assert.equal(V.clickHits({ x: 500, y: 300 }, { x: 100, y: 100, w: 800, h: 30 }), false);
});
