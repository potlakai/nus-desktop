'use strict';
// A click on the pointed control, seen without a click watcher. On Windows the probe reports every
// mouse click (GuideSession.startWatch). A Mac has no probe, and watching other apps' clicks there
// needs Input Monitoring or Accessibility, so a walk never moved on (a tester's real Mac, 2026-11-15: the
// thread landed on Safari's History, his click was not noticed). Two things a Mac gives with no new
// permission are enough: the cursor position (Electron's screen.getCursorScreenPoint), and the
// screen itself (the small fingerprint the guide already grabs to see a screen settle, under the
// Screen Recording permission pointing needs anyway).
//
// The rule: the cursor was over the target (with a little room around it) within the last NEAR_MS,
// and then the screen changed. A change with the cursor elsewhere (a page scrolling, a video) is the
// new baseline, not a click. The bubble's Next button stays as the sure way on.
//
// Pure: the cursor, the grab, the clock and the sleep are injected.
const { difference, CHANGE_THRESHOLD } = require('./settle');

const INTERVAL_MS = 300;    // cursor every tick; a screen fingerprint every other tick
const NEAR_MS = 1500;       // a click lands within this long of the cursor being on the control
const PAD = 14;             // physical pixels of room around the control
const LIMIT_MS = 15 * 60000;

function near(point, rect, pad = PAD) {
  return !!(point && rect) && point.x >= rect.x - pad && point.x <= rect.x + rect.w + pad && point.y >= rect.y - pad && point.y <= rect.y + rect.h + pad;
}

// -> Promise<{ clicked: boolean, why }>
// cursor(): the cursor in the same space as rect (physical pixels). grab(): a fingerprint, or null.
async function guessClick({ rect, cursor, grab, isStale = () => false, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  interval = INTERVAL_MS, nearMs = NEAR_MS, threshold = CHANGE_THRESHOLD, limitMs = LIMIT_MS }) {
  const t0 = now();
  let base = null, lastNear = -Infinity, tick = 0;
  while (now() - t0 < limitMs) {
    if (isStale()) return { clicked: false, why: 'stale' };
    let p = null; try { p = cursor(); } catch (_) { p = null; }
    if (near(p, rect)) lastNear = now();
    if (tick++ % 2 === 0) {
      let frame = null; try { frame = await grab(); } catch (_) { frame = null; }
      if (isStale()) return { clicked: false, why: 'stale' };
      if (frame) {
        if (!base) base = frame;
        else if (difference(base, frame) >= threshold) {
          if (now() - lastNear <= nearMs) return { clicked: true, why: 'the cursor was on it, then the screen changed' };
          base = frame;   // something else moved: the new screen is the baseline
        }
      }
    }
    await sleep(interval);
  }
  return { clicked: false, why: 'time' };
}

module.exports = { guessClick, near, INTERVAL_MS, NEAR_MS, PAD };
