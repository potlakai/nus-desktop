'use strict';
// The warm Claude Code pool with a fake child process: argument shape, the
// stream-json parser, spare reuse and eviction, and error reporting.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { createClaudePool, createParser, userMessage, LOCKED_ARGS } = require('./claude-pool');

function fakeChild() {
  const c = new EventEmitter();
  c.pid = 4242; c.exitCode = null; c.killed = false;
  c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
  c.stdin = new EventEmitter(); c.stdin.written = ''; c.stdin.ended = false;
  c.stdin.write = (s) => { c.stdin.written += s; }; c.stdin.end = () => { c.stdin.ended = true; };
  c.kill = () => { c.killed = true; c.exitCode = 1; };
  c.say = (obj) => c.stdout.emit('data', JSON.stringify(obj) + '\n');
  return c;
}
const promptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nus-pool-test-'));

function rig(opts = {}) {
  const spawned = [];
  const spawn = (file, args, o) => { const c = fakeChild(); c.file = file; c.args = args; c.opts = o; spawned.push(c); return c; };
  const pool = createClaudePool({ cliPath: 'C:\\fake\\claude.exe', spawn, promptDir, idleTtlMs: 1000, now: opts.now, prewarm: opts.prewarm !== false, log: () => {} });
  return { pool, spawned };
}

test('the parser streams text deltas, keeps the first attempt on a mid-reply retry, and reads the result', () => {
  const got = [];
  const p = createParser((t) => got.push(t));
  p.feed(JSON.stringify({ type: 'stream_event', event: { type: 'message_start' } }));
  p.feed(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Click ' } } }));
  p.feed(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'File.' } } }));
  p.feed(JSON.stringify({ type: 'stream_event', event: { type: 'message_start' } }));
  p.feed(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'AGAIN' } } }));
  p.feed(JSON.stringify({ type: 'result', subtype: 'success', result: 'Click File.', usage: { input_tokens: 10 }, total_cost_usd: 0.01, modelUsage: { 'claude-sonnet-5[1m]': {} } }));
  assert.deepEqual(got, ['Click ', 'File.']);
  assert.equal(p.final, 'Click File.'); assert.equal(p.ended, true); assert.equal(p.error, null);
  assert.equal(p.model, 'claude-sonnet-5'); assert.equal(p.costUsd, 0.01);
});

test('the parser drops a reply in which the CLI used a tool, and names the error kinds', () => {
  const p = createParser();
  p.feed(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read' }] } }));
  assert.equal(p.error, 'cli_ran_tools');
  const q = createParser();
  q.feed(JSON.stringify({ type: 'result', is_error: true, result: 'Not logged in. Please run /login' }));
  assert.equal(q.error, 'cli_not_logged_in');
  const r = createParser();
  r.feed(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'whole block' }] } }));
  assert.equal(r.final, 'whole block');
});

test('userMessage turns a data URL into a base64 image block and keeps text', () => {
  const line = userMessage([{ type: 'image', dataUrl: 'data:image/jpeg;base64,QUJD' }, { type: 'text', text: 'where is save' }]);
  const msg = JSON.parse(line);
  assert.equal(msg.type, 'user');
  assert.deepEqual(msg.message.content[0], { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } });
  assert.equal(msg.message.content[1].text, 'where is save');
  assert.equal(JSON.parse(userMessage('plain')).message.content[0].text, 'plain');
});

test('each process runs with the fixed argument set, the system prompt from a file, and the subscription environment', async () => {
  const { pool, spawned } = rig({ prewarm: false });
  const run = pool.run({ model: 'claude-sonnet-5', effort: 'low', system: 'You are the Knot.', content: 'hi' });
  const c = spawned[0];
  for (const a of LOCKED_ARGS) assert.ok(c.args.includes(a), 'missing ' + JSON.stringify(a));
  assert.ok(c.args.includes('--input-format') && c.args.includes('stream-json'));
  const i = c.args.indexOf('--system-prompt-file');
  assert.ok(i > 0); assert.equal(fs.readFileSync(c.args[i + 1], 'utf8'), 'You are the Knot.');
  assert.equal(c.args[c.args.indexOf('--model') + 1], 'claude-sonnet-5');
  assert.equal(c.opts.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(c.opts.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
  assert.equal(c.stdin.ended, true);
  c.say({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } } });
  c.say({ type: 'result', subtype: 'success', result: 'ok' });
  const r = await run;
  assert.equal(r.text, 'ok'); assert.equal(r.warm, false);
});

test('a warmed spare answers the next run without a new spawn, and the run warms the one after', async () => {
  const { pool, spawned } = rig();
  assert.equal(pool.warm({ model: 'm', effort: 'low', system: 'S' }), true);
  assert.equal(pool.warm({ model: 'm', effort: 'low', system: 'S' }), false, 'one spare per key');
  assert.equal(spawned.length, 1);
  const deltas = [];
  const run = pool.run({ model: 'm', effort: 'low', system: 'S', content: 'q', onDelta: (t) => deltas.push(t) });
  assert.equal(spawned.length, 1, 'the spare was taken, nothing new spawned');
  spawned[0].say({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'a' } } });
  spawned[0].say({ type: 'result', subtype: 'success', result: 'a' });
  const r = await run;
  assert.equal(r.warm, true); assert.deepEqual(deltas, ['a']);
  assert.equal(spawned.length, 2, 'the next step\'s process is already started');
  assert.equal(pool.status().spares, 1);
  pool.close();
  assert.equal(spawned[1].killed, true);
});

test('a different prompt or effort is a different spare; the oldest is evicted past the cap', () => {
  const { pool, spawned } = rig();
  pool.warm({ model: 'm', effort: 'low', system: 'A' });
  pool.warm({ model: 'm', effort: 'medium', system: 'A' });
  pool.warm({ model: 'm', effort: 'low', system: 'B' });
  assert.equal(spawned.length, 3);
  assert.equal(spawned[0].killed, true, 'the oldest spare went');
  assert.equal(pool.status().spares, 2);
  pool.close();
});

test('an unsupported flag, a sign-out and silence are reported as errors the caller can act on', async () => {
  const { pool, spawned } = rig({ prewarm: false });
  const r1 = pool.run({ system: 'S', content: 'q' });
  spawned[0].stderr.emit('data', 'error: unknown option --safe-mode');
  spawned[0].emit('close', 1);
  assert.equal((await r1).error, 'cli_unsupported');
  const r2 = pool.run({ system: 'S', content: 'q' });
  spawned[1].stderr.emit('data', 'Not logged in');
  spawned[1].emit('close', 1);
  assert.equal((await r2).error, 'cli_not_logged_in');
  const r3 = pool.run({ system: 'S', content: 'q', firstOutputMs: 20, timeoutMs: 50 });
  const out = await r3;
  assert.equal(out.error, 'cli_timeout'); assert.equal(spawned[2].killed, true);
});
