const { test } = require('node:test');
const assert = require('node:assert');
const { formatFailure, isIgnorablePipeError } = require('./crash');

test('crash log includes diagnostics and a useful stack without user content', () => {
  const text = formatFailure('test-crash', new Error('boom'), { reason: 'crashed' });
  assert.match(text, /test-crash/);
  assert.match(text, /platform=/);
  assert.match(text, /reason=crashed/);
  assert.match(text, /Error: boom/);
});

test('a detached launch losing stdout is logged but is not treated as an app crash', () => {
  assert.equal(isIgnorablePipeError(Object.assign(new Error('broken pipe'), { code: 'EPIPE', syscall: 'write' })), true);
  assert.equal(isIgnorablePipeError(Object.assign(new Error('disk'), { code: 'EIO', syscall: 'write' })), false);
});
