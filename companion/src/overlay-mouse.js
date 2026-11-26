'use strict';
// Whether the overlay takes the mouse. It covers the whole screen, so while it
// does, every click anywhere lands on it, and the way back used to run through
// the page: probe tick in main, answer from the renderer, call in main. A page
// held up left the mouse taken for as long as it lasted (sampled live 2026-11-03:
// 1 to 3 s per Knot flight, with the pointer nowhere near a control).
//
// So main is the one owner of the window's state: every change goes through set,
// which calls the window only when the state differs. The page answers every
// probe tick with what it wants, so a change made here or there cannot leave the
// two apart for longer than a tick. And if the overlay is taking the mouse and the
// page has not answered for WAIT_MS, main lets go by itself and tells the page.
//
// None of this can help while main itself is held up: nothing here runs then.
//
// Electron is injected, so this runs in tests.

const WAIT_MS = 400;
// A tick this late means main was the one held up. The answers are queued behind
// it, so the page is not the one to blame, and the wait starts over.
const LATE_TICK_MS = 300;

function createOverlayMouse({ apply, forced, log = () => {}, now = () => Date.now(), waitMs = WAIT_MS, lateTickMs = LATE_TICK_MS }) {
  let last = null;      // what was last set; null: not set yet on this window
  let askedAt = 0;      // the oldest probe tick not answered yet
  let tickedAt = 0;

  function set(v) {
    v = !!v;
    if (v === last) return false;
    last = v;
    // Taking the mouse starts a fresh wait, whatever came before.
    if (!v) askedAt = 0;
    apply(v);
    return true;
  }

  // Every probe tick. asking: the page is being asked this tick (false when the
  // pointer is off this window, so no answer is due).
  function tick(asking) {
    const t = now(), gap = t - tickedAt;
    tickedAt = t;
    if (!asking) { askedAt = 0; return; }
    if (!askedAt || gap > lateTickMs) { askedAt = t; return; }
    if (last !== true && t - askedAt >= waitMs) {
      const waited = t - askedAt;
      askedAt = t;
      set(true);
      log('click-through forced: the page did not answer for ' + waited + ' ms');
      forced();
    }
  }

  return {
    set, tick,
    // Anything from the page, taken or not, says it is alive.
    answered() { askedAt = 0; },
    // A new window starts as Electron makes it.
    reset() { last = null; askedAt = 0; },
    state: () => last,
  };
}

// A line for route.log from the page's note. The page may only name an element and
// give numbers, so no words on the screen can reach the log.
function mouseNoteLine(note) {
  const n = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);
  const by = String((note && note.by) || '');
  if (!/^[#.\w-]{1,60}$/.test(by)) return null;
  const x = n(note.x), y = n(note.y), kx = n(note.knotX), ky = n(note.knotY);
  if ([x, y, kx, ky].includes(null)) return null;
  if (by === 'dragged') return 'the Knot was dragged to ' + kx + ',' + ky;
  return 'overlay took the mouse at ' + x + ',' + y + ', ' + Math.round(Math.hypot(x - kx, y - ky)) + ' px from the Knot at ' + kx + ',' + ky + ': ' + by;
}

module.exports = { createOverlayMouse, mouseNoteLine, WAIT_MS, LATE_TICK_MS };
