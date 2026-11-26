// Is the Knot's window really on top?
//
// The older guard (index.js reassertTopmost) trusts the always-on-top flag:
// it acts only when Windows has taken the flag away. Found 2026-11-20 on
// Pranav's PC, Companion 0.1.30: the flag was still on, and the window sat
// under eleven ordinary windows. The app was running, the Knot was drawn, and
// nothing of it was on screen until the next restart. The flag is a proxy;
// what the person sees is whether other windows are drawn over the Knot.
//
// So this asks the Windows probe that question every few seconds
// (probe.ps1 'win.covered') and has it lift the window when the answer is
// yes. A lift that does not get above a window is not repeated while that
// same window is on top, so a window Windows ranks higher never causes a
// lift every few seconds.
//
// Plain functions and injected calls, so the tests run it in Node.
'use strict';

const CHECK_EVERY_MS = 3500;    // the caller ticks about every 2 s; this passes every second tick
const LOG_EVERY_MS = 60000;     // a window we cannot get above is named at most this often

function line(r) {
  const n = Number(r.above) || 0;
  return 'the Knot was under ' + n + ' window' + (n === 1 ? '' : 's') + ' with its on-top flag ' + (r.topmost ? 'still on' : 'off')
    + (r.firstClass ? ' (first: ' + r.firstClass + ')' : '');
}

// check({ raise, unless }) resolves to the probe's answer, or null when the
// probe is not there. log(text) writes one line. Returns { tick, status }.
function createOnTopGuard({ check, log = () => {}, now = () => Date.now(), everyMs = CHECK_EVERY_MS, logEveryMs = LOG_EVERY_MS } = {}) {
  let busy = false, lastAt = -Infinity, lifts = 0, checks = 0, outranked = 0, outrankedLogAt = -Infinity;

  async function tick() {
    if (busy || now() - lastAt < everyMs) return null;
    busy = true; lastAt = now();
    try {
      const r = await check({ raise: true, unless: outranked });
      if (!r || !(r.above >= 0)) return null;
      checks++;
      if (r.above === 0) { outranked = 0; return r; }
      if (!r.raised) return r;                       // still under the window a lift could not pass
      if (r.left > 0) {
        outranked = Number(r.leftFirst) || 0;
        if (now() - outrankedLogAt >= logEveryMs) { outrankedLogAt = now(); log(line(r) + '; lifted, ' + r.left + ' still over it'); }
        return r;
      }
      outranked = 0; lifts++;
      log(line(r) + '; lifted');
      return r;
    } catch (e) {
      return null;                                   // a busy or restarting probe: the next tick asks again
    } finally { busy = false; }
  }

  return { tick, status: () => ({ checks, lifts, outranked }) };
}

module.exports = { createOnTopGuard, line, CHECK_EVERY_MS, LOG_EVERY_MS };
