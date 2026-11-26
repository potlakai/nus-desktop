// One guide step is one model call, and on a bad day that one call is the
// whole wait: live 2026-09-21, Gemini Flash held a pointing request for 24 s,
// then answered a second one with a 503 after 16 s, while its normal is 2 to 4 s.
//
// A hedge: when the call has been out longer than a normal answer takes, the
// SAME request (same model, same prompt, same screenshot) is sent again and the
// first good answer wins. An overloaded/unavailable error or an empty reply is
// retried at once instead of becoming "I could not reach the model". Nothing
// about the request changes, so nothing about the answer's quality does.
//
// Every extra request is paid for. The free Gemini tier allows 20 requests a
// day per model (seen live the same day: a 429 "quota exceeded ... limit: 20"),
// so the hedge only fires on a real stall, never on a merely slow answer, at
// most once, and a quota or rate-limit error is never retried.
'use strict';

const DEFAULTS = { hedgeAfterMs: 9000, maxAttempts: 2, retryDelayMs: 250 };

// Worth another try: the provider is busy or the connection dropped. Not worth
// it: out of quota, rate limited, a bad key, a bad request, a blocked prompt.
function transient(err) {
  if (!err) return false;
  const msg = String(err.message || err);
  const status = Number(err.status || err.code || (err.error && err.error.code));
  if (status === 429 || /\b429\b|quota|rate.?limit|resource_exhausted|billing/i.test(msg)) return false;
  if ([408, 425, 500, 502, 503, 504, 529].includes(status)) return true;
  return /\b(503|502|504|529)\b|unavailable|overloaded|high demand|timed? ?out|econnreset|etimedout|socket hang up|fetch failed|network|empty reply/i.test(msg);
}

function hedged(complete, options) {
  const o = Object.assign({}, DEFAULTS, options || {});
  const say = o.log || (() => {});
  if (!(o.hedgeAfterMs > 0)) return complete;
  return function hedgedComplete(params) {
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      let started = 0, running = 0, settled = false, lastErr = null, timer = null;
      const finish = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); fn(v); };
      const arm = () => {
        clearTimeout(timer);
        if (settled || started >= o.maxAttempts) return;
        timer = setTimeout(() => { if (!settled && running > 0) { say('model slow (' + (Date.now() - t0) + 'ms): sending the same request again'); launch(); } }, o.hedgeAfterMs);
        if (timer.unref) timer.unref();
      };
      // Streamed text: the first attempt to produce any owns the stream, so a
      // hedge that lands later never speaks the same sentence twice.
      let owner = 0;
      const forward = (n) => (text) => { if (!owner) owner = n; if (owner === n && typeof params.onDelta === 'function') params.onDelta(text); };
      function launch() {
        if (settled || started >= o.maxAttempts) return;
        const n = ++started;
        running += 1;
        arm();
        const attempt = params && params.onDelta ? Object.assign({}, params, { onDelta: forward(n) }) : params;
        Promise.resolve().then(() => complete(attempt)).then((text) => {
          running -= 1;
          if (typeof text === 'string' && text.trim()) {
            if (n > 1) say('model answered on attempt ' + n + ' after ' + (Date.now() - t0) + 'ms');
            finish(resolve, text);
            return;
          }
          failed(new Error('empty reply from the model'));
        }, (err) => { running -= 1; failed(err); });
      }
      function failed(err) {
        if (settled) return;
        lastErr = err;
        if (transient(err) && started < o.maxAttempts) {
          say('model attempt failed (' + String(err.message || err).slice(0, 80) + '): trying again');
          setTimeout(launch, o.retryDelayMs);
          return;
        }
        // Another attempt may still be out: let it have its say.
        if (running === 0) finish(reject, lastErr);
      }
      launch();
    });
  };
}

module.exports = { hedged, transient, DEFAULTS };
