// Verification: everything between "the model said" and "the thread moves".
// Coordinate mapping (normalized <-> physical <-> overlay window DIPs),
// reconciling a model target with what Windows UI Automation reports, the
// "did the screen change" hash, and the "was that click on the target" test.
// Pure functions; Electron's screen conversions are injected.
'use strict';
const { sensitiveTarget } = require('./sensitive');

const CHANGE_THRESHOLD = 6;      // hamming bits out of 256

// Physical-pixel rect -> fractions of the captured display.
function normRectFromPhys(rect, capture, originPhys) {
  return {
    x: (rect.x - originPhys.x) / capture.pxWidth,
    y: (rect.y - originPhys.y) / capture.pxHeight,
    w: rect.w / capture.pxWidth,
    h: rect.h / capture.pxHeight,
  };
}

function physRectFromNorm(box, capture, originPhys) {
  return {
    x: Math.round(originPhys.x + box.x * capture.pxWidth),
    y: Math.round(originPhys.y + box.y * capture.pxHeight),
    w: Math.round(box.w * capture.pxWidth),
    h: Math.round(box.h * capture.pxHeight),
  };
}

// Physical rect -> overlay window coordinates (DIPs relative to the window).
function physRectToWindow(rect, winBounds, screenToDip) {
  const a = screenToDip({ x: rect.x, y: rect.y });
  const b = screenToDip({ x: rect.x + rect.w, y: rect.y + rect.h });
  return { x: a.x - winBounds.x, y: a.y - winBounds.y, w: Math.max(1, b.x - a.x), h: Math.max(1, b.y - a.y) };
}

function tokens(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter((t) => t.length > 1);
}

// Fraction of the shorter token set found in the other.
function tokenOverlap(a, b) {
  const ta = new Set(tokens(a)), tb = new Set(tokens(b));
  if (!ta.size || !tb.size) return 0;
  const [small, big] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  let hit = 0;
  for (const t of small) if (big.has(t)) hit++;
  return hit / small.size;
}

function iou(a, b) {
  if (!a || !b) return 0;
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

// Turn a validated model target into a physical rect, or null.
//   target:   { kind:'element', id } | { kind:'bbox', x,y,w,h,label }
//   elements: probe list, each { id, name, type, rect (physical) }
//   bboxPhys: the bbox converted to physical px (for kind bbox)
//   fromPoint: probe element under the bbox centre, or null
//   found:    probe uia.find result for the label, or null
//   verified: false when no probe exists (model-only pointing, marked so)
function reconcile({ target, elements, bboxPhys, fromPoint, found, verified = true }) {
  if (sensitiveTarget(target) || sensitiveTarget(fromPoint) || sensitiveTarget(found)) return null;
  if (!target) return null;
  if (target.kind === 'element') {
    const el = (elements || []).find((e) => Number(e.id) === Number(target.id));
    return el && el.rect && !sensitiveTarget(el) ? { rect: el.rect, name: el.name || '', type: el.type || '', source: 'element', verified: true } : null;
  }
  if (target.kind !== 'bbox' || !bboxPhys) return null;
  const label = target.label || '';
  if (fromPoint && fromPoint.rect) {
    const nameOk = label && tokenOverlap(fromPoint.name, label) >= 0.5;
    const boxOk = iou(fromPoint.rect, bboxPhys) >= 0.3;
    if (nameOk && boxOk) return { rect: fromPoint.rect, name: fromPoint.name || label, type: fromPoint.type || '', source: 'frompoint-name', verified: true };
  }
  if (found && found.rect && tokenOverlap(found.name, label) >= 0.5 && iou(found.rect, bboxPhys) >= 0.3) {
    return { rect: found.rect, name: found.name || label, type: found.type || '', source: 'find', verified: true };
  }
  if (!verified) {
    // No probe on this machine: the model's box, flagged as unverified.
    return { rect: bboxPhys, name: label, type: '', source: 'model', verified: false };
  }
  return null;
}

// 16x16 grayscale mean hash of a BGRA bitmap -> 32 bytes (256 bits).
function bitmapHash(buf, w = 16, h = 16) {
  const n = w * h;
  const gray = new Float32Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const g = 0.114 * buf[o] + 0.587 * buf[o + 1] + 0.299 * buf[o + 2];
    gray[i] = g; sum += g;
  }
  const mean = sum / n;
  const out = new Uint8Array(Math.ceil(n / 8));
  for (let i = 0; i < n; i++) if (gray[i] > mean) out[i >> 3] |= 1 << (i & 7);
  return out;
}

function hamming(a, b) {
  if (!a || !b || a.length !== b.length) return 256;
  let d = 0;
  for (let i = 0; i < a.length; i++) { let x = a[i] ^ b[i]; while (x) { d += x & 1; x >>= 1; } }
  return d;
}

// { whole, crop } hashes before and after a click.
function screenChanged(prev, next, threshold = CHANGE_THRESHOLD) {
  if (!prev || !next) return true;
  if (prev.crop && next.crop && hamming(prev.crop, next.crop) > threshold) return true;
  return hamming(prev.whole, next.whole) > threshold;
}

// Keep slack close to each edge; a wide control must not accept distant clicks.
function clickHits(point, rect) {
  if (!point || !rect) return false;
  return point.x >= rect.x - 12 && point.x <= rect.x + rect.w + 12 &&
    point.y >= rect.y - 12 && point.y <= rect.y + rect.h + 12;
}

module.exports = { normRectFromPhys, physRectFromNorm, physRectToWindow, tokenOverlap, iou, reconcile, bitmapHash, hamming, screenChanged, clickHits, CHANGE_THRESHOLD };
