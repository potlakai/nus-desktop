'use strict';
const { performance } = require('node:perf_hooks');

// Maximum main-process scheduling gap during a look, including native capture.
// Unlike image-operation timers this observes stalls inside desktopCapturer too.
function observeLook(log, reason) {
  const started = performance.now();
  let last = started, maxGapMs = 0;
  const sample = () => { const t = performance.now(); maxGapMs = Math.max(maxGapMs, t - last); last = t; };
  const timer = setInterval(sample, 10);
  timer.unref?.();
  return () => {
    sample(); clearInterval(timer);
    const record = { reason, elapsedMs: performance.now() - started, maxMainThreadGapMs: maxGapMs, sampleIntervalMs: 10 };
    log('look-performance ' + JSON.stringify(record));
    return record;
  };
}
module.exports = { observeLook };
