'use strict';
// A busy Gemini (503 "high demand") gets one quiet second try, and only when that is safe.
const test = require('node:test');
const assert = require('node:assert');
const { withBusyRetry, isBusy } = require('../src/llm');

const busy = () => Object.assign(new Error('{"error":{"code":503,"message":"This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.","status":"UNAVAILABLE"}}'), { status: 503 });

test('isBusy reads the status and the words, and leaves other errors alone', () => {
  assert.strictEqual(isBusy(busy()), true);
  assert.strictEqual(isBusy(new Error('The model is overloaded. Please try again later.')), true);
  assert.strictEqual(isBusy({ status: 529 }), true);
  assert.strictEqual(isBusy(new Error('API key not valid. Please pass a valid API key.')), false);
  assert.strictEqual(isBusy(Object.assign(new Error('quota'), { status: 429 })), false);
  assert.strictEqual(isBusy(null), false);
});

test('a busy first try is asked once more and the second answer is returned', async () => {
  let calls = 0;
  const run = withBusyRetry(async () => { calls += 1; if (calls === 1) throw busy(); return 'Click Save.'; }, 1);
  assert.strictEqual(await run({}), 'Click Save.');
  assert.strictEqual(calls, 2);
});

test('busy twice is thrown as it is, after exactly two tries', async () => {
  let calls = 0;
  const run = withBusyRetry(async () => { calls += 1; throw busy(); }, 1);
  await assert.rejects(run({}), (e) => e.status === 503);
  assert.strictEqual(calls, 2);
});

test('an error that is not busy is never tried again', async () => {
  let calls = 0;
  const run = withBusyRetry(async () => { calls += 1; throw new Error('API key not valid. Please pass a valid API key.'); }, 1);
  await assert.rejects(run({}));
  assert.strictEqual(calls, 1);
});

test('no second try once words have reached the person', async () => {
  let calls = 0;
  const seen = [];
  const run = withBusyRetry(async (a) => { calls += 1; a.onToken('Click '); throw busy(); }, 1);
  await assert.rejects(run({ onToken: (t) => seen.push(t) }));
  assert.strictEqual(calls, 1);
  assert.deepStrictEqual(seen, ['Click ']);
});

test('the streamed-reply callback counts as words too', async () => {
  let calls = 0;
  const run = withBusyRetry(async (a) => { calls += 1; a.onDelta('Open '); throw busy(); }, 1);
  await assert.rejects(run({ onDelta: () => {} }));
  assert.strictEqual(calls, 1);
});

test('no second try after stop, and none for an assignment lane', async () => {
  let calls = 0;
  const stop = new AbortController();
  const run = withBusyRetry(async () => { calls += 1; stop.abort(); throw busy(); }, 1);
  await assert.rejects(run({ signal: stop.signal }));
  assert.strictEqual(calls, 1);

  let lane = 0;
  const assignment = withBusyRetry(async () => { lane += 1; throw busy(); }, 1);
  await assert.rejects(assignment({ assignment: true }));
  assert.strictEqual(lane, 1);
});

test('the second try gets the same callbacks, so its words still arrive', async () => {
  let calls = 0;
  const seen = [];
  const run = withBusyRetry(async (a) => { calls += 1; if (calls === 1) throw busy(); a.onToken('Done.'); return 'Done.'; }, 1);
  assert.strictEqual(await run({ onToken: (t) => seen.push(t) }), 'Done.');
  assert.deepStrictEqual(seen, ['Done.']);
});
