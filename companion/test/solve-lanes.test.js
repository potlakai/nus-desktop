const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runLanes, fastHedged, equivalent } = require('../src/guide/solve-lanes');
const tick = () => new Promise(r => setImmediate(r));
const checked = answer => JSON.stringify({ found: true, problem: 'P', steps: [{ title: 'Step', body: 'Compute.' }], answer, check: 'Substituted.', confidence: 0.9 });

test('both lanes start together, publish closed fast answer and first step, then visibly correct', async () => {
  const requests = [], paints = [];
  let release;
  const job = runLanes({ fastModel: 'haiku', cap: {}, input: {}, hedgeAfterMs: 0, compare: async () => false, call: async p => {
    requests.push(p.lane);
    if (p.lane === 'fast') { p.onToken('{"found":true,"problem":"P","answer":"4",'); return '{"found":true,"problem":"P","answer":"4","confidence":0.8}'; }
    await new Promise(r => { release = r; });
    p.onToken('{"found":true,"problem":"P","steps":[{"title":"Step","body":"Compute."},');
    return checked('5');
  }, onFast: p => paints.push(p.answer), onSteps: p => paints.push(p.steps[0].body), onChecked: (p, agrees) => paints.push([p.answer, agrees]) });
  await tick(); assert.deepEqual(requests, ['fast', 'checker']); assert.deepEqual(paints, ['4']);
  release(); const r = await job;
  assert.deepEqual(paints, ['4', 'Compute.', ['5', false]]); assert.equal(r.timing.agreed, false);
});
test('checker-first result cannot be overwritten by late fast tokens', async () => {
  let release; const paints = [];
  const job = runLanes({ fastModel: 'haiku', cap: {}, input: {}, hedgeAfterMs: 0, compare: async () => false, call: async p => {
    if (p.lane === 'checker') return checked('7');
    await new Promise(r => { release = r; }); p.onToken('{"found":true,"answer":"6",'); return '{"found":true,"answer":"6"}';
  }, onFast: p => paints.push(p.answer), onChecked: p => paints.push(p.answer) });
  await tick(); release(); const r = await job;
  assert.deepEqual(paints, ['7']); assert.equal(r.timing.agreed, null, 'cancelled fast work is not a completed answer comparison');
});
test('hedge buffers never mix and the losing request is aborted', async () => {
  let calls = 0, aborted = false; const output = [];
  const r = await fastHedged(async p => {
    if (++calls === 1) { p.onToken('{"found":true,"answer":"unfinished'); await new Promise((resolve, reject) => p.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); })); }
    p.onToken('{"found":true,"answer":"second",'); return '{"found":true,"answer":"second"}';
  }, {}, { hedgeAfterMs: 5, onToken: t => output.push(t) });
  assert.match(r, /second/); assert.equal(aborted, true); assert.equal(output.join('').includes('unfinished'), false);
});
test('429 is never retried and equivalence fails closed on Jev outage', async () => {
  let calls = 0;
  await assert.rejects(fastHedged(async () => { calls++; throw Object.assign(new Error('rate limit'), { status: 429 }); }, {}, { hedgeAfterMs: 5 }));
  assert.equal(calls, 1);
  assert.equal(await equivalent('x', 'y', { client: { ready: () => false } }), false);
  assert.equal(await equivalent(' x − 2 ', 'x-2', { client: { ready() { throw new Error('no Jev'); } } }), true);
});
