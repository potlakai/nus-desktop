'use strict';
const { createScreenPoints } = require('../screen-points');

function sameForeground(a, b) {
  if (!a || !b) return false;
  return a.hwnd === b.hwnd && a.process === b.process && a.title === b.title &&
    (!a.rect || !b.rect || ['x', 'y', 'w', 'h'].every(k => a.rect[k] === b.rect[k]));
}

function imageRect(rect, origin, physicalSize, imageSize) {
  const sx = imageSize.width / physicalSize.width, sy = imageSize.height / physicalSize.height;
  const x = Math.max(0, Math.floor((rect.x - origin.x) * sx));
  const y = Math.max(0, Math.floor((rect.y - origin.y) * sy));
  const right = Math.min(imageSize.width, Math.ceil((rect.x + rect.w - origin.x) * sx));
  const bottom = Math.min(imageSize.height, Math.ceil((rect.y + rect.h - origin.y) * sy));
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}
function maskBitmap(buf, width, height, rect) {
  if (!rect) return buf;
  const x = Math.max(0, rect.x), y = Math.max(0, rect.y);
  const right = Math.min(width, rect.x + rect.width), bottom = Math.min(height, rect.y + rect.height);
  for (let row = y; row < bottom; row++) for (let col = x; col < right; col++) {
    const i = (row * width + col) * 4;
    buf[i] = buf[i + 1] = buf[i + 2] = 255; buf[i + 3] = 255;
  }
  return buf;
}

async function captureAssignment({ foreground, bubbleRect, model = false, captureDisplay, electron, now = () => performance.now() }) {
  const { screen, nativeImage } = electron;
  const points = createScreenPoints(screen);
  const fg = await foreground();
  if (!fg?.rect || fg.rect.w <= 0 || fg.rect.h <= 0) return null;
  const dip = points.screenToDip({ x: Math.round(fg.rect.x + fg.rect.w / 2), y: Math.round(fg.rect.y + fg.rect.h / 2) });
  const display = screen.getDisplayNearestPoint(dip), scale = display.scaleFactor || 1;
  const physicalSize = { width: Math.round(display.bounds.width * scale), height: Math.round(display.bounds.height * scale) };
  const origin = points.dipToScreen({ x: display.bounds.x, y: display.bounds.y });
  // OCR needs near-native pixels: at 960 px a 1776 px Firefox window read as the
  // WeBWorK header only, so every automatic look failed the homework check (2026-09-28).
  const maxSide = model ? 1568 : 2048;
  const ratio = Math.min(1, Math.max(fg.rect.w, fg.rect.h) / Math.max(physicalSize.width, physicalSize.height));
  const cap = await captureDisplay(display.id, { maxSide: Math.ceil(maxSide / Math.max(0.25, ratio)), dataUrl: false, thumb: true });
  // The worker can finish after a tab navigation or Alt+Tab. Never label that
  // new screenshot with the foreground window from before capture started.
  if (!sameForeground(fg, await foreground())) return { invalidated: true, foreground: fg };
  if (!cap?.image) return null;
  const blockedAt = now();
  const size = cap.image.getSize();
  let image = cap.image;
  if (bubbleRect) {
    const p = points.dipToScreen({ x: Math.round(bubbleRect.x), y: Math.round(bubbleRect.y) });
    const q = points.dipToScreen({ x: Math.round(bubbleRect.x + bubbleRect.w), y: Math.round(bubbleRect.y + bubbleRect.h) });
    const mask = imageRect({ x: p.x, y: p.y, w: q.x - p.x, h: q.y - p.y }, origin, physicalSize, size);
    if (mask) image = nativeImage.createFromBitmap(maskBitmap(image.toBitmap(), size.width, size.height, mask), size);
  }
  const crop = imageRect(fg.rect, origin, physicalSize, size);
  if (!crop) return null;
  image = image.crop(crop);
  const cropped = image.getSize(), longest = Math.max(cropped.width, cropped.height);
  if (longest > maxSide) image = image.resize({ width: Math.round(cropped.width * maxSide / longest), height: Math.round(cropped.height * maxSide / longest), quality: 'good' });
  const jpeg = image.toJPEG(model ? 82 : 72), out = image.getSize();
  const mouse = points.dipToScreen(screen.getCursorScreenPoint());
  const cursor = { x: Math.max(0, Math.min(1, (mouse.x - fg.rect.x) / fg.rect.w)), y: Math.max(0, Math.min(1, (mouse.y - fg.rect.y) / fg.rect.h)) };
  const result = { jpeg, ...out, display: cap.display, foreground: fg, cursor, blockMs: (cap.blockMs || 0) + now() - blockedAt, dataUrl: model ? 'data:image/jpeg;base64,' + jpeg.toString('base64') : null };
  return result;
}
module.exports = { imageRect, maskBitmap, captureAssignment, sameForeground };
