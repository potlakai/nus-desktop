const { test } = require('node:test');
const assert = require('node:assert/strict');
const { partialReply, parseFast, normalizeAnswer } = require('../src/guide/solve-stream');
test('stream parser only publishes closed strings and complete step objects across every split', () => {
  const raw = JSON.stringify({ found: true, problem: 'P', steps: [{ title: 'quote', body: 'Say "x", then use {a:2} and \\.' }, { title: 'two', body: 'Finish.' }], answer: 'x = "4"', confidence: 0.9 });
  for (let i = 0; i < raw.length; i++) {
    const v = partialReply(raw.slice(0, i));
    if (v.answer) assert.equal(v.answer, 'x = "4"');
    if (v.steps && v.steps.length) assert.equal(v.steps[0].body, 'Say "x", then use {a:2} and \\.');
  }
  assert.equal(partialReply(raw).steps.length, 2);
  assert.equal(parseFast('{"found":true,"problem":"P","answer":"3",').answer, '3');
  assert.equal(partialReply('{"found":true,"answer":"unfinished').answer, undefined);
});
test('answer normalization preserves mathematically meaningful signs and numbers', () => {
  assert.equal(normalizeAnswer(' X − 2 '), 'x-2');
  assert.notEqual(normalizeAnswer('x+2'), normalizeAnswer('x-2'));
});
