// The guide's first read, done early. While the person is still saying "help
// me make a pivot table", Jev already knows it is a guide ask, so the front
// window, its controls and the screenshot are fetched then; the session picks
// them up the moment the sentence ends instead of starting from nothing.
//
// Rules (2026-09-21):
//   - Only kicked once Jev says guide/ask. A blind control walk can hold the
//     single-threaded probe for 1.2 s and time out the reflex layer's own
//     "did the window land" check, which loses the person's typed text.
//   - Ids are positional per walk, so fg + list + capture travel together.
//   - Up to FRESH_MS old: used as is. Up to maxAgeMs: only if the same window
//     (hwnd and title) is still in front. Older: thrown away.
//   - One in flight at a time, single use, and the session awaits an in-flight
//     snapshot rather than walking beside it.
'use strict';

const FRESH_MS = 1500;
const MAX_AGE_MS = 4000;
const REKICK_MS = 2000;

function createSnapshotter({ probe, capture, selfPid, now, log }) {
  const clock = now || (() => Date.now());
  const say = log || (() => {});
  let snap = null;       // { at, fg, cap, list }
  let inflight = null;

  function live() { const p = typeof probe === 'function' ? probe() : probe; return p && p.available ? p : null; }

  async function foreground() {
    const p = live();
    if (!p) return null;
    let fg = null;
    try { fg = await p.request('fg', { ignorePid: selfPid }, 2500); } catch (e) { say('snapshot fg failed: ' + e.message); }
    if (fg && fg.pid === selfPid) fg = null;
    return fg && fg.hwnd ? fg : null;
  }

  async function read() {
    const t0 = clock();
    // The window first, then the capture and the control walk together: the
    // PNG encode blocks this process, so the walk must already be with the
    // probe when it starts (see readAndPoint in session.js).
    const fg = await foreground();
    const fgMs = clock() - t0;
    let uiaMs = 0, capMs = 0;
    const p = live();
    const tu = clock();
    const listP = p && fg
      ? p.request('uia.list', { hwnd: fg.hwnd, max: 150, budgetMs: 1200 }, 3000).then((r) => { uiaMs = clock() - tu; return r; }, (e) => { say('snapshot uia.list failed: ' + e.message); return null; })
      : Promise.resolve(null);
    const tc = clock();
    const cap = await Promise.resolve().then(() => capture()).then((c) => { capMs = clock() - tc; return c; }, (e) => { say('snapshot capture failed: ' + e.message); return null; });
    const list = await listP;
    if (!cap || !cap.dataUrl) return null;
    say('snapshot read ' + (clock() - t0) + 'ms (capture ' + capMs + ', fg ' + fgMs + ', controls ' + uiaMs + ')');
    return { at: clock(), fg, cap, list, readMs: clock() - t0, capMs, fgMs, uiaMs };
  }

  // Start a read unless one is running or a recent one is still good.
  function kick(reason) {
    if (inflight) return false;
    if (snap && clock() - snap.at < REKICK_MS) return false;
    say('snapshot kick (' + (reason || '') + ')');
    const mine = read().then((s) => { snap = s; return s; }, () => { snap = null; return null; }).finally(() => { if (inflight === mine) inflight = null; });
    inflight = mine;
    return true;
  }

  // -> { fg, cap, list, age } or null. Single use.
  async function take(opts) {
    const maxAge = (opts && opts.maxAgeMs) || MAX_AGE_MS;
    if (inflight) { try { await inflight; } catch (_) { /* read() never throws */ } }
    const s = snap;
    snap = null;
    if (!s) return null;
    const age = clock() - s.at;
    if (age > maxAge) { say('snapshot stale (' + age + 'ms)'); return null; }
    if (age > FRESH_MS) {
      const fg = await foreground();
      const same = (!fg && !s.fg) || (fg && s.fg && fg.hwnd === s.fg.hwnd && (fg.title || '') === (s.fg.title || ''));
      if (!same) { say('snapshot dropped: a different window is in front'); return null; }
    }
    return { fg: s.fg, cap: s.cap, list: s.list, age, readMs: s.readMs, capMs: s.capMs, fgMs: s.fgMs, uiaMs: s.uiaMs };
  }

  function clear() { snap = null; }
  function pending() { return Boolean(inflight || snap); }

  return { kick, take, clear, pending };
}

module.exports = { createSnapshotter, FRESH_MS, MAX_AGE_MS, REKICK_MS };
