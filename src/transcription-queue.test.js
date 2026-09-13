const test = require('node:test');
const assert = require('node:assert/strict');
const { createTranscriptionQueue } = require('./transcription-queue');

test('final audio overtakes pending partial work without dropping final results', async () => {
  const q = createTranscriptionQueue(); const order = []; let release;
  const active = q.enqueue(() => new Promise((r) => { release = r; }), { kind: 'partial', sessionId: 'a' });
  const partial = q.enqueue(async () => { order.push('partial'); return { text: 'partial' }; }, { kind: 'partial', sessionId: 'b' });
  const final = q.enqueue(async () => { order.push('final'); return { text: 'whole utterance' }; }, { sessionId: 'a' });
  release({ text: 'early' }); await active;
  assert.equal((await final).text, 'whole utterance'); await partial;
  assert.deepEqual(order, ['final', 'partial']);
});

test('new partial replaces old pending partial and final supersedes its own partial', async () => {
  const q = createTranscriptionQueue(); let release;
  const active = q.enqueue(() => new Promise((r) => { release = r; }));
  const old = q.enqueue(() => assert.fail('obsolete partial ran'), { kind: 'partial', sessionId: 'a' });
  const latest = q.enqueue(() => assert.fail('partial ran after final'), { kind: 'partial', sessionId: 'a' });
  assert.deepEqual(await old, { superseded: true });
  const final = q.enqueue(async () => ({ text: 'all words' }), { sessionId: 'a' });
  assert.deepEqual(await latest, { superseded: true });
  release({ text: '' }); await active;
  assert.equal((await final).text, 'all words');
});

test('queue overflow is an explicit retryable failure, not empty transcription', async () => {
  const q = createTranscriptionQueue(); let release;
  const active = q.enqueue(() => new Promise((r) => { release = r; }));
  const waiting = Array.from({ length: 4 }, () => q.enqueue(async () => ({ text: 'kept' })));
  assert.deepEqual(await q.enqueue(async () => ({})), { error: 'transcription_queue_busy', retryable: true });
  release({}); await active; await Promise.all(waiting);
});

test('cancelling one session removes its queued audio without discarding another session', async () => {
  const q = createTranscriptionQueue(); let release;
  const active = q.enqueue(() => new Promise((r) => { release = r; }), { sessionId: 'active' });
  const final = q.enqueue(() => assert.fail('cancelled final ran'), { sessionId: 'cancelled' });
  const partial = q.enqueue(() => assert.fail('cancelled partial ran'), { kind: 'partial', sessionId: 'cancelled' });
  const other = q.enqueue(async () => ({ text: 'kept' }), { sessionId: 'other' });
  q.cancel('cancelled');
  assert.deepEqual(await final, { cancelled: true });
  assert.deepEqual(await partial, { cancelled: true });
  release({}); await active;
  assert.equal((await other).text, 'kept');
});
