// The hedged model call: same request again when the first is slow or the
// provider is busy; the first good answer wins.
const test = require('node:test');
const assert = require('node:assert/strict');
const { hedged, transient } = require('../src/guide/hedge');

const later = (ms, v, fail) => new Promise((res, rej) => setTimeout(() => (fail ? rej(v) : res(v)), ms));
const busy = () => Object.assign(new Error('{"error":{"code":503,"message":"This model is currently experiencing high demand.","status":"UNAVAILABLE"}}'), { status: 503 });

test('a fast answer is one call, passed through untouched', async () => {
  const seen = [];
  const complete = hedged(async (p) => { seen.push(p); return '{"ok":1}'; }, { hedgeAfterMs: 50 });
  const params = { system: 's', turns: [{ role: 'user', text: 't' }], imageDataUrl: 'data:x', json: true, maxTokens: 400 };
  assert.equal(await complete(params), '{"ok":1}');
  assert.equal(seen.length, 1);
  assert.equal(seen[0], params, 'the very same request object');
});

test('a stuck call is hedged with the same request and the first good answer wins', async () => {
  const seen = [], logs = [];
  let n = 0;
  const complete = hedged((p) => { seen.push(p); n += 1; return n === 1 ? later(400, '{"slow":1}') : later(10, '{"fast":1}'); }, { hedgeAfterMs: 40, log: (m) => logs.push(m) });
  const params = { turns: [] };
  const t0 = Date.now();
  assert.equal(await complete(params), '{"fast":1}');
  assert.ok(Date.now() - t0 < 300, 'did not wait for the stuck call');
  assert.equal(seen.length, 2);
  assert.equal(seen[1], params);
  assert.ok(logs.some((l) => /sending the same request again/.test(l)));
});

test('an overloaded provider or an empty reply is retried at once, not reported', async () => {
  let n = 0;
  const a = hedged(async () => { n += 1; if (n === 1) throw busy(); return '{"ok":1}'; }, { hedgeAfterMs: 5000, retryDelayMs: 5 });
  assert.equal(await a({}), '{"ok":1}');
  assert.equal(n, 2);

  let m = 0;
  const b = hedged(async () => { m += 1; return m === 1 ? '' : '{"ok":2}'; }, { hedgeAfterMs: 5000, retryDelayMs: 5 });
  assert.equal(await b({}), '{"ok":2}');
});

test('it gives up after two tries, and at once on an error that a retry cannot fix', async () => {
  let n = 0;
  const a = hedged(async () => { n += 1; throw busy(); }, { hedgeAfterMs: 5000, retryDelayMs: 5 });
  await assert.rejects(() => a({}), /high demand/);
  assert.equal(n, 2);

  let k = 0;
  const b = hedged(async () => { k += 1; throw Object.assign(new Error('API key not valid'), { status: 400 }); }, { hedgeAfterMs: 5000, retryDelayMs: 5 });
  await assert.rejects(() => b({}), /API key not valid/);
  assert.equal(k, 1);
});

test('a failure does not end it while a hedge is still out', async () => {
  let n = 0;
  const complete = hedged(() => { n += 1; return n === 1 ? later(80, Object.assign(new Error('bad request'), { status: 400 }), true) : later(140, '{"late":1}'); }, { hedgeAfterMs: 30 });
  assert.equal(await complete({}), '{"late":1}');
});

test('hedgeAfterMs 0 turns it off; transient() knows busy from broken', () => {
  const f = async () => 'x';
  assert.equal(hedged(f, { hedgeAfterMs: 0 }), f);
  assert.equal(transient(busy()), true);
  assert.equal(transient(new Error('model timed out')), true);
  assert.equal(transient(new Error('fetch failed')), true);
  assert.equal(transient(Object.assign(new Error('API key not valid'), { status: 400 })), false);
  assert.equal(transient(new Error('blocked by safety settings')), false);
  // Out of quota: every retry is a wasted request (the free tier is 20 a day).
  const quota = Object.assign(new Error('{"error":{"code":429,"message":"You exceeded your current quota","status":"RESOURCE_EXHAUSTED"}}'), { status: 429 });
  assert.equal(transient(quota), false);
  assert.equal(transient(new Error('Quota exceeded for metric generate_content_free_tier_requests')), false);
});
