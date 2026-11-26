'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { EventEmitter } = require('events');
const { createWhisperServer, formBody, audioCtxFor, CAREFUL_FIELDS } = require('./whisper-server');

function fakeChild() {
  const c = new EventEmitter();
  c.killed = false;
  c.kill = () => { c.killed = true; setImmediate(() => c.emit('exit', 0)); };
  return c;
}
function harness({ healthyAfter = 1, reply = () => ({ status: 200, text: JSON.stringify({ text: ' hello there\n' }) }) } = {}) {
  const calls = { spawns: [], requests: [] };
  let health = 0;
  const spawn = (exe, args) => { const c = fakeChild(); calls.spawns.push({ exe, args, child: c }); return c; };
  const request = async (r) => {
    calls.requests.push(r);
    if (/\/health$/.test(r.path)) { health++; if (health < healthyAfter) throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }); return { status: 200, text: '{"status":"ok"}' }; }
    return reply(r);
  };
  const s = createWhisperServer({ exe: 'whisper-server.exe', model: 'm.bin', threads: 4, spawn, request, port: async () => 4321, pollMs: 1 });
  return { s, calls };
}

test('audio context fits the clip, never under 256 or over 1500', () => {
  assert.equal(audioCtxFor(500), 256);
  assert.equal(audioCtxFor(3435), 256);
  assert.equal(audioCtxFor(7035), 448);
  assert.equal(audioCtxFor(60000), 1500);
});

test('first transcribe returns null at once and starts the server on localhost with a random path', async () => {
  const { s, calls } = harness({ healthyAfter: 3 });
  assert.equal(await s.transcribe(Buffer.from('RIFF')), null, 'caller falls back to whisper-cli');
  await s.warm();
  assert.equal(s.status().state, 'ready');
  const args = calls.spawns[0].args;
  assert.equal(args[args.indexOf('--host') + 1], '127.0.0.1');
  assert.equal(args[args.indexOf('--port') + 1], '4321');
  assert.match(args[args.indexOf('--inference-path') + 1], /^\/i[0-9a-f]{24}$/);
  // 2026-11-01 security (L5): /health, /load and the index page sit under a
  // random prefix too, and every request goes there.
  const prefix = args[args.indexOf('--request-path') + 1];
  assert.match(prefix, /^\/p[0-9a-f]{24}$/);
  assert.ok(calls.requests.length > 0);
  for (const r of calls.requests) assert.equal(r.path, prefix + '/health', 'the health poll is under the prefix');
  assert.equal(calls.spawns.length, 1, 'one process, however many warms');
  s.close();
});

test('a ready server answers with the words and sends the clip-sized context and prompt', async () => {
  const { s, calls } = harness();
  await s.warm();
  const text = await s.transcribe(Buffer.from('RIFFwav'), { audioCtx: 448, prompt: 'Nūs, the Knot.' });
  assert.equal(text, ' hello there\n');
  const post = calls.requests.find((r) => r.method === 'POST');
  const args = calls.spawns[0].args;
  assert.equal(post.path, args[args.indexOf('--request-path') + 1] + args[args.indexOf('--inference-path') + 1], 'inference goes to prefix + route');
  const body = post.body.toString('utf8');
  assert.match(body, /name="audio_ctx"\r\n\r\n448\r\n/);
  assert.match(body, /name="prompt"\r\n\r\nNūs, the Knot\.\r\n/);
  assert.match(body, /name="temperature_inc"\r\n\r\n0\r\n/);
  assert.match(body, /RIFFwav/);
  s.close();
});

test('a refused request marks the server gone, returns null, and the next warm starts a new one', async () => {
  const { s, calls } = harness({ reply: () => { throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }); } });
  await s.warm();
  assert.equal(await s.transcribe(Buffer.from('x')), null);
  assert.equal(s.status().state, 'off');
  await s.warm();
  assert.equal(calls.spawns.length, 2);
  s.close();
});

test('an HTTP error or bad JSON is a null, not a crash', async () => {
  let n = 0;
  const { s } = harness({ reply: () => (++n === 1 ? { status: 500, text: 'oops' } : { status: 200, text: 'not json' }) });
  await s.warm();
  assert.equal(await s.transcribe(Buffer.from('x')), null);
  assert.equal(await s.transcribe(Buffer.from('x')), null);
  assert.equal(s.status().state, 'ready', 'still running for the next ask');
  s.close();
});

test('a server that never becomes healthy is given up on, and not retried at once', async () => {
  let t = 0;
  const spawned = [];
  const s = createWhisperServer({ exe: 'e', model: 'm', spawn: () => { const c = fakeChild(); spawned.push(c); return c; },
    request: async () => { throw new Error('refused'); }, port: async () => 1, pollMs: 1, now: () => (t += 50), startTimeoutMs: 500, retryMs: 100000 });
  assert.equal(await s.warm(), false);
  assert.equal(s.status().state, 'failed');
  assert.ok(spawned[0].killed, 'the half-started process is stopped');
  assert.equal(await s.warm(), false);
  assert.equal(spawned.length, 1, 'no retry inside the retry window');
});

test('no binary means no server and no spawn', async () => {
  let spawned = 0;
  const s = createWhisperServer({ exe: null, model: 'm', spawn: () => { spawned++; return fakeChild(); } });
  assert.equal(await s.warm(), false);
  assert.equal(await s.transcribe(Buffer.from('x')), null);
  assert.equal(spawned, 0);
  assert.equal(s.status().state, 'missing');
});

test('the multipart body is what a real HTTP server reads', async () => {
  const { boundary, body } = formBody({ language: 'en', audio_ctx: '256', empty: '' }, Buffer.from('WAVDATA'));
  const got = await new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { res.end('ok'); srv.close(); resolve({ type: req.headers['content-type'], b }); });
    }).listen(0, '127.0.0.1', () => {
      const r = http.request({ host: '127.0.0.1', port: srv.address().port, method: 'POST', path: '/', headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': body.length } }, (res) => res.resume());
      r.end(body);
    });
  });
  assert.equal(got.type, 'multipart/form-data; boundary=' + boundary);
  assert.match(got.b, /name="language"\r\n\r\nen\r\n/);
  assert.doesNotMatch(got.b, /name="empty"/, 'empty fields are left out');
  assert.match(got.b, /filename="speech\.wav"\r\nContent-Type: audio\/wav\r\n\r\nWAVDATA\r\n/);
  assert.ok(got.b.endsWith('--' + boundary + '--\r\n'));
});

// A clock and a request the test drives: a timeout, a hang-up, or the words.
function strikeHarness({ abandonMs = 2500 } = {}) {
  const calls = { spawns: [], posts: 0, killed: 0, logs: [] };
  let clock = 1000, next = () => ({ status: 200, text: JSON.stringify({ text: 'ok' }) });
  const spawn = () => { const c = fakeChild(); const k = c.kill; c.kill = () => { calls.killed++; k(); }; calls.spawns.push(c); return c; };
  const request = async (r) => { if (/\/health$/.test(r.path)) return { status: 200, text: '{}' }; calls.posts++; return next(r); };
  const s = createWhisperServer({ exe: 'x.exe', model: 'm.bin', threads: 2, spawn, request, port: async () => 4321, pollMs: 1, now: () => clock, abandonMs, log: (m) => calls.logs.push(m) });
  return { s, calls, set: (fn) => { next = fn; }, advance: (ms) => { clock += ms; } };
}
const timesOut = () => { throw new Error('timeout'); };
const words = () => ({ status: 200, text: JSON.stringify({ text: 'ok' }) });

test('a partial that times out leaves the server up, and nothing queues behind its decode until that has had time to end', async () => {
  const { s, calls, set, advance } = strikeHarness();
  await s.warm();
  set(timesOut);
  assert.equal(await s.transcribe(Buffer.from('x'), { partial: true, timeoutMs: 1200 }), null);
  assert.equal(s.status().state, 'ready', 'one late partial is not a stall');
  assert.equal(calls.killed, 0);
  assert.equal(calls.posts, 1);
  set(words);
  assert.equal(await s.transcribe(Buffer.from('x')), null, 'the final goes to whisper-cli at once');
  assert.equal(calls.posts, 1, 'the server was not asked');
  advance(2500);
  assert.equal(await s.transcribe(Buffer.from('x')), 'ok');
  s.close();
});

test('two partials timing out in a row restart the server; one answered in between clears the count', async () => {
  const { s, calls, set, advance } = strikeHarness();
  await s.warm();
  set(timesOut);
  await s.transcribe(Buffer.from('x'), { partial: true }); advance(2500);
  set(words);
  await s.transcribe(Buffer.from('x'), { partial: true }); advance(2500);
  set(timesOut);
  await s.transcribe(Buffer.from('x'), { partial: true }); advance(2500);
  assert.equal(calls.killed, 0, 'not in a row');
  await s.transcribe(Buffer.from('x'), { partial: true });
  assert.equal(calls.killed, 1, 'stalled: the old process is gone');
  assert.ok(calls.logs.some((m) => /stopped \(stalled\)/.test(m)));
  await s.warm();
  assert.equal(calls.spawns.length, 2, 'and a new one started');
  assert.equal(s.status().state, 'ready');
  s.close();
});

test('a final that times out restarts the server at once and the caller runs whisper-cli', async () => {
  const { s, calls, set } = strikeHarness();
  await s.warm();
  set(timesOut);
  assert.equal(await s.transcribe(Buffer.from('x'), { timeoutMs: 3000 }), null);
  assert.equal(calls.killed, 1);
  await s.warm();
  assert.equal(calls.spawns.length, 2);
  s.close();
});

test('a hang-up is not a failure: no strike and no log, and only a slow one keeps the next request off the server', async () => {
  const { s, calls, set, advance } = strikeHarness();
  await s.warm();
  const before = calls.logs.length;
  set(() => { throw new Error('aborted'); });
  assert.equal(await s.transcribe(Buffer.from('x'), { partial: true }), null);
  assert.equal(calls.logs.length, before);
  assert.equal(calls.killed, 0);
  set(words);
  assert.equal(await s.transcribe(Buffer.from('x')), 'ok', 'a young partial ends in a moment: the final may queue behind it');
  set(() => { advance(800); throw new Error('aborted'); });
  await s.transcribe(Buffer.from('x'), { partial: true });
  set(words);
  const posts = calls.posts;
  assert.equal(await s.transcribe(Buffer.from('x')), null, 'an 800 ms partial may run on: whisper-cli takes the final');
  assert.equal(calls.posts, posts);
  s.close();
});

test('a refused request does not kill the server that replaced it', async () => {
  const { s, calls, set } = strikeHarness();
  await s.warm();
  let fail;
  set(() => new Promise((_, reject) => { fail = reject; }));
  const old = s.transcribe(Buffer.from('x'));
  await new Promise((r) => setImmediate(r));
  s.close();
  await s.warm();
  fail(Object.assign(new Error('reset'), { code: 'ECONNRESET' }));
  await old;
  assert.equal(s.status().state, 'ready');
  assert.equal(calls.spawns.length, 2);
  assert.equal(calls.killed, 1, 'only the first');
  s.close();
});

test('the request really hangs up when the signal fires', async () => {
  const { httpRequest } = require('./whisper-server');
  let closed;
  const seen = new Promise((r) => { closed = r; });
  const srv = http.createServer((req) => { req.resume(); req.on('close', closed); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const ctl = new AbortController();
  const asked = httpRequest({ port: srv.address().port, path: '/x', method: 'POST', body: Buffer.from('x'), timeoutMs: 5000, signal: ctl.signal });
  setTimeout(() => ctl.abort(), 30);
  await assert.rejects(asked, /aborted/);
  await seen;
  srv.close();
  await assert.rejects(httpRequest({ port: 1, path: '/x', signal: ctl.signal }), /aborted/, 'already aborted: nothing is sent');
});

test('a careful decode keeps the whole context and searches; the fast one is unchanged', async () => {
  const { s, calls } = harness();
  await s.warm();
  await s.transcribe(Buffer.from('RIFFwav'), { careful: true, prompt: 'Nūs Companion.', timeoutMs: 3500 });
  await s.transcribe(Buffer.from('RIFFwav'), { audioCtx: 448, prompt: 'Nūs Companion.' });
  const [careful, fast] = calls.requests.filter((r) => r.method === 'POST').map((r) => r.body.toString('utf8'));
  assert.deepEqual(CAREFUL_FIELDS, { beam_size: '5', temperature_inc: '0' });
  assert.match(careful, /name="beam_size"\r\n\r\n5\r\n/);
  assert.match(careful, /name="temperature_inc"\r\n\r\n0\r\n/);
  assert.match(careful, /name="prompt"\r\n\r\nNūs Companion\.\r\n/);
  assert.doesNotMatch(careful, /name="audio_ctx"/, 'no context cut: the encoder keeps its 30 s');
  assert.doesNotMatch(careful, /name="best_of"/);
  assert.match(fast, /name="audio_ctx"\r\n\r\n448\r\n/);
  assert.match(fast, /name="best_of"\r\n\r\n1\r\n/);
  assert.doesNotMatch(fast, /name="beam_size"/);
  s.close();
});
