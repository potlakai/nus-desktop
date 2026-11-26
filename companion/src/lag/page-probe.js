'use strict';
// What the lag recorder runs inside each window (the overlay, the dashboard, the
// sign-in window). It only watches: the browser's own long-task, long-frame and
// input-delay reports, and how long each frame the page itself asked for took to
// arrive. It never asks for a frame of its own, because a watcher that does
// makes the frames it is counting (measured 2026-11-07).
//
// Main reads it every few seconds with webContents.executeJavaScript, so no IPC
// channel and no preload change is needed. Names of our own scripts and
// functions, and numbers; nothing from the page's text.

function probe() {
  if (window.__nusLag) return 'already';
  const BOUNDS = [20, 34, 50, 100, 200, 500];
  const fresh = () => ({ lt: { n: 0, sum: 0, max: 0 }, loaf: { n: 0, sum: 0, max: 0, blk: 0, top: [] }, fr: { n: 0, sum: 0, max: 0, b: [0, 0, 0, 0, 0, 0, 0] }, ev: { n: 0, max: 0, delay: 0, what: '' } });
  let acc = fresh();
  const base = (u) => { try { return String(u || '').split(/[\\/]/).pop().split('?')[0].slice(0, 40); } catch (_) { return ''; } };
  const watch = (type, opts, fn) => { try { new PerformanceObserver((list) => { for (const e of list.getEntries()) fn(e); }).observe(Object.assign({ type, buffered: false }, opts || {})); } catch (_) { /* not in this browser */ } };
  watch('longtask', null, (e) => { acc.lt.n++; acc.lt.sum += e.duration; if (e.duration > acc.lt.max) acc.lt.max = e.duration; });
  watch('long-animation-frame', null, (e) => {
    acc.loaf.n++; acc.loaf.sum += e.duration; acc.loaf.blk += e.blockingDuration || 0;
    if (e.duration > acc.loaf.max) acc.loaf.max = e.duration;
    let worst = null;
    for (const s of e.scripts || []) if (!worst || s.duration > worst.duration) worst = s;
    acc.loaf.top.push({ ms: Math.round(e.duration), fn: worst ? String(worst.sourceFunctionName || worst.invoker || '').slice(0, 50) : '', src: worst ? base(worst.sourceURL) : '', js: worst ? Math.round(worst.duration) : 0, style: Math.round((e.styleAndLayoutStart ? e.startTime + e.duration - e.styleAndLayoutStart : 0)) });
    acc.loaf.top.sort((a, b) => b.ms - a.ms); if (acc.loaf.top.length > 3) acc.loaf.top.length = 3;
  });
  watch('event', { durationThreshold: 16 }, (e) => {
    if (!/^(pointerdown|pointerup|click|keydown|mousedown|mouseup)$/.test(e.name)) return;
    acc.ev.n++;
    const delay = e.processingStart - e.startTime;
    if (delay > acc.ev.delay) acc.ev.delay = delay;
    if (e.duration > acc.ev.max) { acc.ev.max = e.duration; acc.ev.what = e.name; }
  });
  // Frames the page asked for: the wait from the first request to the callback.
  const raf = window.requestAnimationFrame.bind(window);
  let askedAt = 0;
  window.requestAnimationFrame = function (cb) {
    if (!askedAt) askedAt = performance.now();
    return raf(function (ts) {
      if (askedAt) {
        const waited = performance.now() - askedAt; askedAt = 0;
        const f = acc.fr; f.n++; f.sum += waited; if (waited > f.max) f.max = waited;
        let i = 0; while (i < BOUNDS.length && waited > BOUNDS[i]) i++; f.b[i]++;
      }
      return cb(ts);
    });
  };
  window.__nusLag = {
    drain() {
      const out = acc; acc = fresh();
      const r = (n) => Math.round(n * 10) / 10;
      out.lt.sum = r(out.lt.sum); out.lt.max = r(out.lt.max); out.loaf.sum = r(out.loaf.sum); out.loaf.max = r(out.loaf.max); out.loaf.blk = r(out.loaf.blk);
      out.fr.sum = r(out.fr.sum); out.fr.max = r(out.fr.max); out.ev.max = r(out.ev.max); out.ev.delay = r(out.ev.delay);
      out.vis = document.visibilityState;
      const orb = document.getElementById('orb');
      if (orb) out.knot = (orb.dataset.state || '') + (document.querySelector('.knot-asleep') ? ' asleep' : '');
      return out;
    },
  };
  return 'on';
}

const SOURCE = '(' + probe.toString() + ')()';
const DRAIN = 'window.__nusLag ? window.__nusLag.drain() : null';

module.exports = { probe, SOURCE, DRAIN };
