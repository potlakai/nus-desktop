'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { captureForModel, modelCapture, dataUrlBytes, DEFAULT_MAX_SIDE } = require('../src/guide/capture-model');

// A tiny nativeImage stand-in: a BGRA bitmap with a size, resize and JPEG stubs.
function fakeImage(width, height, fill = 0) {
  const buf = Buffer.alloc(width * height * 4, fill);
  const img = {
    getSize: () => ({ width, height }),
    toBitmap: () => Buffer.from(buf),
    resize: ({ width: w, height: h }) => fakeImage(w, h, fill),
    toJPEG: (q) => Buffer.from('jpeg:' + width + 'x' + height + '@' + q),
  };
  return img;
}
const nativeImage = {
  createFromBitmap: (buf, size) => { const img = fakeImage(size.width, size.height); img.toBitmap = () => Buffer.from(buf); img.bits = buf; return img; },
  createFromBuffer: (buf) => ({ decodedFrom: buf.toString() }),
};
const screen = { dipToScreenPoint: (p) => ({ x: p.x * 2, y: p.y * 2 }) };
const display = { id: 7, bounds: { x: 0, y: 0, width: 1280, height: 720 }, scaleFactor: 2 };

test('the model capture is a JPEG no longer than the max side, with the display\'s real pixel size', async () => {
  const calls = [];
  const captureDisplay = async (id, opts) => { calls.push({ id, opts }); const img = fakeImage(2560, 1440); return { image: img, display, blockMs: 5 }; };
  const r = await captureForModel({ displayId: 7, captureDisplay, electron: { screen, nativeImage }, now: () => 0 });
  assert.equal(calls[0].opts.thumb, true);
  assert.equal(calls[0].opts.dataUrl, false);
  assert.equal(calls[0].opts.maxSide, DEFAULT_MAX_SIDE);
  assert.equal(r.width, DEFAULT_MAX_SIDE);
  assert.equal(r.height, Math.round(1440 * DEFAULT_MAX_SIDE / 2560));
  assert.equal(r.pxWidth, 2560);
  assert.equal(r.pxHeight, 1440);
  assert.equal(r.jpeg.toString(), 'jpeg:1568x882@80');
});

test('masks are painted white in image pixels before encoding, and only when given', async () => {
  const img = fakeImage(100, 50, 0);
  const captureDisplay = async () => ({ image: img, display: { id: 1, bounds: { x: 0, y: 0, width: 100, height: 50 }, scaleFactor: 1 }, blockMs: 0 });
  const masked = await captureForModel({ displayId: 1, masks: [{ x: 10, y: 10, w: 20, h: 10 }], maxSide: 200, quality: 70, captureDisplay, electron: { screen: { dipToScreenPoint: (p) => p }, nativeImage } });
  assert.equal(masked.jpeg.toString(), 'jpeg:100x50@70');
  const plain = await captureForModel({ displayId: 1, masks: [], maxSide: 200, captureDisplay, electron: { screen: { dipToScreenPoint: (p) => p }, nativeImage } });
  assert.ok(plain.jpeg);
});

test('applyMasks writes 255 into every channel of the masked rect only', () => {
  const { applyMasks } = require('../src/guide/capture-model');
  const img = fakeImage(4, 4, 0);
  const out = applyMasks(img, [{ x: 1, y: 1, w: 2, h: 2 }], { x: 0, y: 0 }, { width: 4, height: 4 }, nativeImage);
  const bits = out.bits;
  const px = (x, y) => bits[(y * 4 + x) * 4];
  assert.equal(px(1, 1), 255); assert.equal(px(2, 2), 255);
  assert.equal(px(0, 0), 0); assert.equal(px(3, 3), 0);
});

test('modelCapture shapes the worker result like the guide expects, keeping the image off the wire', () => {
  const cap = modelCapture({ jpeg: Buffer.from('abc'), width: 10, height: 5, pxWidth: 20, pxHeight: 10, display, blockMs: 3 }, nativeImage);
  assert.equal(cap.dataUrl, 'data:image/jpeg;base64,' + Buffer.from('abc').toString('base64'));
  assert.equal(cap.format, 'jpeg');
  assert.deepEqual([cap.width, cap.height, cap.pxWidth, cap.pxHeight], [10, 5, 20, 10]);
  assert.equal(cap.image.decodedFrom, 'abc');
  assert.equal(Object.keys(cap).includes('image'), false);
  assert.equal(Object.keys(cap).includes('jpeg'), false);
  assert.equal(modelCapture(null, nativeImage), null);
});

test('dataUrlBytes gives a CLI brain the bytes and the right extension', () => {
  const j = dataUrlBytes('data:image/jpeg;base64,' + Buffer.from('hi').toString('base64'));
  assert.equal(j.ext, 'jpg'); assert.equal(j.mime, 'image/jpeg'); assert.equal(j.bytes.toString(), 'hi');
  assert.equal(dataUrlBytes('data:image/png;base64,AA==').ext, 'png');
  assert.equal(dataUrlBytes('nonsense'), null);
});
