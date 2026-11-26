'use strict';
// A screenshot shaped for a vision model: one display, at most MAX_SIDE on the
// long side, JPEG, with our own overlay painted out when the OS is not already
// keeping it out of captures. Meant to run inside the capture worker so neither
// the grab nor the encode touches the UI thread.
//
// Why these numbers: Anthropic resizes anything longer than 1568 px before the
// model sees it, and Gemini tiles at 768 px, so a 2560 px PNG (the guide's old
// capture: several MB of base64 per step, encoded on the main thread) bought no
// accuracy, only wait. A 1568 px JPEG at quality 80 is about 250 KB.
const { imageRect, maskBitmap } = require('./assignment-capture');

const DEFAULT_MAX_SIDE = 1568;
const DEFAULT_QUALITY = 80;

// masks: physical-pixel rects to paint white (our Knot, our bubble).
function applyMasks(image, masks, origin, physicalSize, nativeImage) {
  const rects = (masks || []).map((m) => imageRect(m, origin, physicalSize, image.getSize())).filter(Boolean);
  if (!rects.length) return image;
  const size = image.getSize();
  let buf = image.toBitmap();
  for (const r of rects) buf = maskBitmap(buf, size.width, size.height, r);
  return nativeImage.createFromBitmap(buf, size);
}

// -> { jpeg, width, height, pxWidth, pxHeight, display, blockMs } or null.
// captureDisplay is src/screen.js (or a fake); electron supplies screen and nativeImage.
// enlarge (for reading words, never for the model): a screen smaller than
// maxSide is drawn up to this many times its size, because Windows OCR reads
// small interface text better with more pixels under each letter (measured
// 2026-11-23 on a 1920x1080 screen: 466 words at its own size, 491 at 1.5x,
// for about 50 ms more).
async function captureForModel({ displayId, masks, maxSide, quality, enlarge, captureDisplay, electron, now = () => performance.now() }) {
  const { screen, nativeImage } = electron;
  const side = Number(maxSide) || DEFAULT_MAX_SIDE;
  const q = Number(quality) || DEFAULT_QUALITY;
  const cap = await captureDisplay(displayId, { maxSide: side, thumb: true, dataUrl: false });
  if (!cap || !cap.image) return null;
  const started = now();
  const display = cap.display;
  const scale = (display && display.scaleFactor) || 1;
  // The real pixel size of the display, whatever size the thumbnail came back at.
  const physicalSize = display && display.bounds
    ? { width: Math.round(display.bounds.width * scale), height: Math.round(display.bounds.height * scale) }
    : { width: cap.pxWidth, height: cap.pxHeight };
  const origin = display && display.bounds && screen && typeof screen.dipToScreenPoint === 'function'
    ? screen.dipToScreenPoint({ x: display.bounds.x, y: display.bounds.y })
    : { x: (display && display.bounds && display.bounds.x) || 0, y: (display && display.bounds && display.bounds.y) || 0 };
  let image = applyMasks(cap.image, masks, origin, physicalSize, nativeImage);
  const size = image.getSize();
  const longest = Math.max(size.width, size.height);
  if (longest > side) {
    const f = side / longest;
    image = image.resize({ width: Math.round(size.width * f), height: Math.round(size.height * f), quality: 'good' });
  } else if (Number(enlarge) > 1 && longest > 0) {
    const f = Math.min(Number(enlarge), side / longest);
    if (f > 1.05) image = image.resize({ width: Math.round(size.width * f), height: Math.round(size.height * f), quality: 'best' });
  }
  const out = image.getSize();
  const jpeg = image.toJPEG(q);
  return { jpeg, width: out.width, height: out.height, pxWidth: physicalSize.width, pxHeight: physicalSize.height, display, blockMs: (cap.blockMs || 0) + (now() - started) };
}

// What the guide session expects from capture(): the data URL for the model
// plus a decoded image kept aside for change detection (never serialized).
function modelCapture(result, nativeImage) {
  if (!result || !result.jpeg) return null;
  const jpeg = Buffer.isBuffer(result.jpeg) ? result.jpeg : Buffer.from(result.jpeg);
  const cap = {
    dataUrl: 'data:image/jpeg;base64,' + jpeg.toString('base64'),
    format: 'jpeg',
    width: result.width, height: result.height,
    pxWidth: result.pxWidth, pxHeight: result.pxHeight,
    display: result.display,
    blockMs: result.blockMs || 0,
  };
  Object.defineProperty(cap, 'jpeg', { value: jpeg, enumerable: false });
  Object.defineProperty(cap, 'image', { value: nativeImage.createFromBuffer(jpeg), enumerable: false });
  return cap;
}

// A data URL's bytes and extension, so a CLI brain gets the JPEG as a .jpg
// instead of a re-encoded PNG.
function dataUrlBytes(dataUrl) {
  const m = /^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/i.exec(String(dataUrl || ''));
  if (!m) return null;
  const ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
  return { ext, mime: 'image/' + (ext === 'jpg' ? 'jpeg' : ext), bytes: Buffer.from(m[2], 'base64') };
}

module.exports = { captureForModel, modelCapture, applyMasks, dataUrlBytes, DEFAULT_MAX_SIDE, DEFAULT_QUALITY };
