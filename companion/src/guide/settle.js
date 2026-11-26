'use strict';
// Noticing that the screen has reacted, and settled, after the person's click.
//
// Before: a fixed 450 ms nap after every click, then a 16x16 mean hash of the
// whole screen; six bits out of 256 had to flip for a click to count as "took".
// A checkbox tick or a menu that opened and closed again read as nothing, and a
// slow page read as unchanged because the nap ended before the page did.
//
// Now: small grayscale thumbnails of the display every SETTLE_INTERVAL_MS. A
// click has "taken" once the picture moves away from the one before the click
// (mean gray change >= CHANGE_THRESHOLD) and then holds still (consecutive
// frames within STILL_THRESHOLD). The wait ends the moment that happens, or at
// a cap. The same thumbnails answer "did anything change" far more sensibly
// than the bit hash: GLANCE_LEVEL gray levels across GLANCE_PIXELS pixels beats
// JPEG noise and still catches a tick mark.
//
// Pure JS: thumbnails come in as BGRA bitmaps of any size, grab() is injected.

const FP_W = 64, FP_H = 40;            // whole-screen fingerprint
const GLANCE_W = 160, GLANCE_H = 100;  // "did anything change" look at a region
const GLANCE_LEVEL = 24;               // gray levels a pixel must move to count
const GLANCE_PIXELS = 3;               // pixels that must move (a tick is ~4, JPEG noise 0)
const SETTLE_INTERVAL_MS = 150;
const CHANGE_THRESHOLD = 4.0;          // mean gray change vs the baseline = "something happened"
const STILL_THRESHOLD = 1.5;           // mean gray change between consecutive frames = "still"
const SETTLE_AFTER_CLICK_MS = 1500;    // longest wait for a click to show, then we look anyway

// Box-average downsample of a BGRA bitmap to a gray thumbnail of tw x th.
// rect (optional, in bitmap pixels) crops first.
function grayThumb(buf, w, h, tw = FP_W, th = FP_H, rect = null) {
  let x0 = 0, y0 = 0, x1 = w, y1 = h;
  if (rect) {
    x0 = Math.max(0, Math.floor(rect.x)); y0 = Math.max(0, Math.floor(rect.y));
    x1 = Math.min(w, Math.ceil(rect.x + rect.width)); y1 = Math.min(h, Math.ceil(rect.y + rect.height));
    if (x1 - x0 < 2 || y1 - y0 < 2) { x0 = 0; y0 = 0; x1 = w; y1 = h; }
  }
  const cw = x1 - x0, ch = y1 - y0;
  const out = new Uint8Array(tw * th);
  for (let ty = 0; ty < th; ty++) {
    const sy0 = y0 + Math.floor(ty * ch / th), sy1 = Math.max(sy0 + 1, y0 + Math.floor((ty + 1) * ch / th));
    for (let tx = 0; tx < tw; tx++) {
      const sx0 = x0 + Math.floor(tx * cw / tw), sx1 = Math.max(sx0 + 1, x0 + Math.floor((tx + 1) * cw / tw));
      let sum = 0, n = 0;
      for (let y = sy0; y < sy1; y++) {
        let o = (y * w + sx0) * 4;
        for (let x = sx0; x < sx1; x++, o += 4) { sum += 0.114 * buf[o] + 0.587 * buf[o + 1] + 0.299 * buf[o + 2]; n++; }
      }
      out[ty * tw + tx] = n ? Math.round(sum / n) : 0;
    }
  }
  return out;
}

function fingerprint(buf, w, h) { return grayThumb(buf, w, h, FP_W, FP_H); }
function glance(buf, w, h, rect) { return grayThumb(buf, w, h, GLANCE_W, GLANCE_H, rect); }

// Mean absolute gray difference, 0..255. Unlike sizes count as fully different.
function difference(a, b) {
  if (!a || !b || a.length !== b.length) return 255;
  let d = 0;
  for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]);
  return d / a.length;
}

// True when enough pixels moved to beat JPEG noise.
function changed(a, b, level = GLANCE_LEVEL, pixels = GLANCE_PIXELS) {
  if (!a || !b || a.length !== b.length) return true;
  let moved = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > level) { moved++; if (moved >= pixels) return true; }
  return false;
}

// The control list, reduced to what matters for "has this screen settled":
// names with digits masked (clocks, counters, "2 min ago") and positions
// snapped to a 16 px grid (a scrollbar nudge is not a new screen).
function settleSignature(elements, grid = 16) {
  const rows = (elements || []).filter((e) => e && e.rect).map((e) => {
    const name = String(e.name || '').replace(/\d+/g, '#').trim().toLowerCase();
    const r = e.rect;
    return `${e.type || ''}|${name}|${Math.round(r.x / grid)},${Math.round(r.y / grid)}`;
  });
  rows.sort();
  return rows.join('\n');
}

// grab() -> Promise<Uint8Array fingerprint> (or null when the screen cannot be read).
class ScreenWatcher {
  constructor({ grab, interval = SETTLE_INTERVAL_MS, threshold = CHANGE_THRESHOLD, still = STILL_THRESHOLD, now, sleep }) {
    this.grab = grab;
    this.interval = interval;
    this.threshold = threshold;
    this.still = still;
    this.now = now || (() => Date.now());
    this.sleep = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  // Resolves { changed, settled, frames, ms } once the screen has moved away
  // from `baseline` and then held still, or when timeoutMs runs out. With no
  // baseline the first frame is the baseline.
  async waitForChange(timeoutMs, baseline = null, isStale = () => false, opts = {}) {
    const t0 = this.now();
    let base = baseline, previous = baseline, moved = false, frames = 0;
    const deadline = t0 + timeoutMs;
    // opts.giveUpMs: a screen that has not moved at all by then is reported
    // unchanged at once instead of waiting out the whole cap.
    const giveUp = Number(opts && opts.giveUpMs) > 0 ? t0 + Number(opts.giveUpMs) : null;
    while (this.now() < deadline) {
      if (isStale()) return { changed: moved, settled: false, frames, ms: this.now() - t0, stale: true };
      if (giveUp && !moved && frames > 0 && this.now() >= giveUp) return { changed: false, settled: true, frames, ms: this.now() - t0, gaveUp: true };
      let frame = null;
      try { frame = await this.grab(); } catch (_) { frame = null; }
      frames++;
      if (!frame) { await this.sleep(this.interval); continue; }
      if (!base) { base = frame; previous = frame; await this.sleep(this.interval); continue; }
      if (!moved && difference(base, frame) >= this.threshold) moved = true;
      else if (moved && previous && difference(previous, frame) <= this.still) return { changed: true, settled: true, frames, ms: this.now() - t0 };
      previous = frame;
      await this.sleep(this.interval);
    }
    return { changed: moved, settled: false, frames, ms: this.now() - t0 };
  }
}

module.exports = { grayThumb, fingerprint, glance, difference, changed, settleSignature, ScreenWatcher, FP_W, FP_H, GLANCE_W, GLANCE_H, GLANCE_LEVEL, GLANCE_PIXELS, SETTLE_INTERVAL_MS, CHANGE_THRESHOLD, STILL_THRESHOLD, SETTLE_AFTER_CLICK_MS };
