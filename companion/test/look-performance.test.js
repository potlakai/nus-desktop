const { test } = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { observeLook } = require('../src/guide/look-performance');
test('look observer includes a synchronous native-style stall before returning', () => {
  const logs = [], finish = observeLook(m => logs.push(m), 'test');
  const until = performance.now() + 55;
  while (performance.now() < until) { /* emulate blocking native work */ }
  const r = finish();
  assert.ok(r.maxMainThreadGapMs >= 50);
  assert.equal(logs.length, 1);
});
