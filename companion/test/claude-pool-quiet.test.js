'use strict';
// Claude Code gives no word in time: the pool waits while the model is visibly working, and when
// it does give up it says why (0.1.32). Until then every case was "no answer started within 45 s".
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { createClaudePool, createParser, quietEnd } = require('../../src/claude-pool');
const { plainAskError, ownKeyStuck } = require('../src/ask-error');

function fakeChild() {
  const c = new EventEmitter();
  c.pid = 4242; c.exitCode = null; c.killed = false;
  c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
  c.stdin = new EventEmitter(); c.stdin.write = () => {}; c.stdin.end = () => {};
  c.kill = () => { c.killed = true; c.exitCode = 1; };
  c.say = (obj) => c.stdout.emit('data', JSON.stringify(obj) + '\n');
  return c;
}
const promptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nus-pool-quiet-'));
function rig() {
  const spawned = [];
  const spawn = () => { const c = fakeChild(); spawned.push(c); return c; };
  return { pool: createClaudePool({ cliPath: 'C:\\fake\\claude.exe', spawn, promptDir, prewarm: false, log: () => {} }), spawned };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const INIT = { type: 'system', subtype: 'init' };
const OPEN = { type: 'stream_event', event: { type: 'message_start' } };
const THINK = { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hm' } } };
const WORD = (t) => ({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: t } } });
const DONE = (t) => ({ type: 'result', subtype: 'success', result: t });
const retry = (error, attempt, status, max = 10) => ({ type: 'system', subtype: 'api_retry', attempt, max_retries: max, retry_delay_ms: 1000, error_status: status, error });
const say = (provider, r) => plainAskError(provider, r.error + (r.detail ? ': ' + r.detail : ''));

test('the parser notes the start, the model working, and the last retry notice', () => {
  const p = createParser();
  assert.equal(p.started, false); assert.equal(p.beats, 0); assert.equal(p.retry, null);
  p.feed(JSON.stringify(INIT)); assert.equal(p.started, true);
  p.feed(JSON.stringify(retry('overloaded', 1, 529)));
  p.feed(JSON.stringify(retry('overloaded', 2, 529)));
  assert.deepEqual(p.retry, { attempt: 2, max: 10, error: 'overloaded', status: 529 });
  p.feed(JSON.stringify(OPEN)); p.feed(JSON.stringify(THINK));
  assert.equal(p.beats, 2); assert.equal(p.produced, false, 'thinking is not a word');
  p.feed(JSON.stringify({ type: 'system', subtype: 'api_retry', attempt: 3, error_status: null, error: 'C:\\Users\\someone\\secret path!' }));
  assert.equal(p.retry.error, 'CUserssomeonesecretpath'.slice(0, 40), 'only letters and underscores are kept from the cause');
  assert.equal(p.retry.status, null);
});

test('long thinking is not cut off: the wait restarts while the model is working', async () => {
  const { pool, spawned } = rig();
  const run = pool.run({ system: 'S', content: 'q', firstOutputMs: 150, timeoutMs: 4000 });
  const c = spawned[0];
  c.say(INIT); c.say(OPEN);
  for (let i = 0; i < 12; i++) { await wait(50); c.say(THINK); }     // 600 ms of thinking, four times the limit
  assert.equal(c.killed, false, 'still alive after 600 ms of thinking');
  c.say(WORD('Click Save.')); c.say(DONE('Click Save.'));
  const r = await run;
  assert.equal(r.text, 'Click Save.'); assert.equal(r.error, undefined);
});

test('thinking that stops is still given up on, and the reason says the reply had started', async () => {
  const { pool, spawned } = rig();
  const run = pool.run({ system: 'S', content: 'q', firstOutputMs: 50, timeoutMs: 2000 });
  spawned[0].say(INIT); spawned[0].say(OPEN); spawned[0].say(THINK);
  const r = await run;
  assert.equal(r.error, 'cli_timeout'); assert.match(r.detail, /^the reply started and then stopped for 0 s$/);
  assert.equal(spawned[0].killed, true);
  assert.match(say('claude (desktop)', r), /Claude Code took too long to answer/);
});

test('a retry loop is not progress: it ends at the limit and names the cause', async () => {
  const { pool, spawned } = rig();
  const run = pool.run({ system: 'S', content: 'q', firstOutputMs: 300, timeoutMs: 3000 });
  const c = spawned[0];
  c.say(INIT);
  for (let i = 1; i <= 5; i++) { c.say(retry('overloaded', i, 529)); await wait(10); }   // well inside the limit
  const r = await run;
  assert.equal(r.error, 'cli_timeout');
  assert.match(r.detail, /^no answer started within 0 s; Claude Code kept retrying: overloaded \(try 5 of 10, status 529\)$/);
  assert.match(say('claude (desktop)', r), /Claude Code is busy right now/);
  assert.equal(ownKeyStuck('claude (desktop)', r.error + ': ' + r.detail), false, 'busy passes; it is not the key\'s fault');
});

test('each cause gets its own plain line', () => {
  const p = (over) => Object.assign(createParser(), { started: true }, over);
  const cases = [
    [p({ retry: { attempt: 3, max: 10, error: 'rate_limit', status: 429 } }), 'cli_timeout', /hit its usage limit/],
    [p({ retry: { attempt: 2, max: 10, error: 'unknown', status: null } }), 'cli_timeout', /could not reach Claude\. Check your internet/],
    [p({ retry: { attempt: 2, max: 10, error: 'server_error', status: 500 } }), 'cli_timeout', /could not get an answer from Claude just now/],
    [p({ retry: { attempt: 2, max: 3, error: 'authentication_failed', status: 401 } }), 'cli_not_logged_in', /Claude Code is signed out/],
    [p({ retry: { attempt: 2, max: 3, error: 'billing_error', status: 402 } }), 'cli_spend_limit', /out of (usage|credits)/],
    [Object.assign(createParser(), { started: false }), 'cli_timeout', /did not start in time on this computer/],
    [p({}), 'cli_timeout', /took too long to answer/],
  ];
  for (const [parser, code, line] of cases) {
    const r = quietEnd(parser, 45000);
    assert.equal(r.error, code, JSON.stringify(r));
    assert.match(say('claude (desktop)', r), line, JSON.stringify(r));
  }
  assert.equal(quietEnd(Object.assign(createParser(), { started: false }), 45000).detail, 'Claude Code did not start within 45 s');
  assert.equal(quietEnd(p({}), 45000).detail, 'no answer started within 45 s', 'the plain case keeps its old words');
});

test('signed out, said twice: the person hears it at once instead of after the whole wait', async () => {
  const { pool, spawned } = rig();
  const t0 = Date.now();
  const run = pool.run({ system: 'S', content: 'q', firstOutputMs: 5000, timeoutMs: 9000 });
  const c = spawned[0];
  c.say(INIT); c.say(retry('authentication_failed', 1, 401, 3));
  await wait(20); assert.equal(c.killed, false, 'one notice is not enough');
  c.say(retry('authentication_failed', 2, 401, 3));
  const r = await run;
  assert.ok(Date.now() - t0 < 1000, 'ended early');
  assert.equal(r.error, 'cli_not_logged_in'); assert.equal(c.killed, true);
  assert.match(r.detail, /Claude Code could not sign in: authentication_failed \(try 2 of 3, status 401\)/);
});

test('nothing at all from the CLI: it did not start', async () => {
  const { pool, spawned } = rig();
  const r = await pool.run({ system: 'S', content: 'q', firstOutputMs: 30, timeoutMs: 2000 });
  assert.equal(r.error, 'cli_timeout'); assert.equal(r.detail, 'Claude Code did not start within 0 s');
  assert.equal(spawned[0].killed, true);
});

test('a normal answer is untouched, and words after a retry still arrive', async () => {
  const { pool, spawned } = rig();
  const got = [];
  const run = pool.run({ system: 'S', content: 'q', firstOutputMs: 500, timeoutMs: 2000, onDelta: (t) => got.push(t) });
  const c = spawned[0];
  c.say(INIT); c.say(retry('overloaded', 1, 529)); c.say(OPEN); c.say(WORD('Open ')); c.say(WORD('Settings.')); c.say(DONE('Open Settings.'));
  const r = await run;
  assert.equal(r.text, 'Open Settings.'); assert.deepEqual(got, ['Open ', 'Settings.']);
});

test('the whole-answer limit says so when words had started', async () => {
  const { pool, spawned } = rig();
  const run = pool.run({ system: 'S', content: 'q', firstOutputMs: 500, timeoutMs: 60 });
  spawned[0].say(INIT); spawned[0].say(OPEN); spawned[0].say(WORD('Click '));
  const r = await run;
  assert.equal(r.error, 'cli_timeout'); assert.equal(r.detail, 'the answer did not finish within 0 s');
});

test('a lapsed sign-in, in the words Claude Code 2.1.247 really uses, is read as signed out', async () => {
  const { classifyError } = require('../../src/claude-pool');
  assert.equal(classifyError('Failed to authenticate: OAuth session expired and could not be refreshed'), 'cli_not_logged_in');
  assert.equal(classifyError('Not logged in · Please run /login'), 'cli_not_logged_in');
  assert.equal(classifyError('You have hit your usage limit'), 'cli_spend_limit');
  assert.equal(classifyError('something else broke'), 'cli_failed');
  // The same words arriving as the stream's result, which is how the real CLI sends them.
  const { pool, spawned } = rig();
  const run = pool.run({ system: 'S', content: 'q', firstOutputMs: 500, timeoutMs: 2000 });
  spawned[0].say(INIT);
  spawned[0].say({ type: 'result', subtype: 'success', is_error: true, result: 'Failed to authenticate: OAuth session expired and could not be refreshed' });
  const r = await run;
  assert.equal(r.error, 'cli_not_logged_in');
});
