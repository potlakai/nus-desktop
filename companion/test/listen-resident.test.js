const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { createListener } = require('../src/reflex/listen');

const pcm = (ms, level = 1000) => {
  const b = Buffer.alloc(ms * 32);
  for (let i = 0; i < b.length; i += 2) b.writeInt16LE(level, i);
  return b;
};
const tick = () => new Promise(r => setImmediate(r));

function fakeServer(answers) {
  const calls = [];
  let warms = 0;
  return {
    calls, warms: () => warms,
    warm: () => { warms++; return Promise.resolve(true); },
    transcribe: async (wav, opts) => { calls.push({ wav, opts }); return answers.length ? answers.shift() : null; },
    status: () => ({ state: 'ready' }),
  };
}

test('the resident whisper answers when it can, with the clip-sized context and the names prompt', async () => {
  const server = fakeServer(['Open Spotify.']);
  const finals = [];
  const l = createListener({ server, transcribe: () => assert.fail('whisper-cli must not run'), vocabulary: ['Professor Lee'], onFinal: t => finals.push(t) });
  l.push(pcm(400)); await l.flush();
  assert.deepEqual(finals, ['Open Spotify.']);
  assert.equal(server.calls[0].opts.audioCtx, 256);
  assert.match(server.calls[0].opts.prompt, /Professor Lee/);
  assert.equal(server.calls[0].wav.toString('ascii', 0, 4), 'RIFF');
});

test('when the resident whisper cannot answer, whisper-cli does, and every press warms it', async () => {
  const server = fakeServer([null]);
  const finals = [];
  const l = createListener({ server, transcribe: async () => 'fallback words', onFinal: t => finals.push(t) });
  l.push(pcm(400)); await l.flush();
  assert.deepEqual(finals, ['fallback words']);
  const before = server.warms();
  l.reset();
  assert.equal(server.warms(), before + 1);
});

test('key up stops a whisper-cli partial that heard less than was said, instead of waiting for it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nus-listen-'));
  fs.writeFileSync(path.join(dir, 'whisper-cli.exe'), '');
  fs.writeFileSync(path.join(dir, 'whisper-cli'), '');   // the Mac name (companion/src/reflex/listen.js CLI_NAME)
  fs.mkdirSync(path.join(dir, 'whisper-models'));
  fs.writeFileSync(path.join(dir, 'whisper-models', 'ggml-base.en-q5_1.bin'), '');
  const prev = process.env.NUS_WHISPER_DIR;
  process.env.NUS_WHISPER_DIR = dir;
  const children = [];
  const spawn = () => {
    const c = new EventEmitter();
    c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
    c.killed = false;
    c.kill = () => { c.killed = true; setImmediate(() => c.emit('close', null)); };
    children.push(c);
    // The second process is the final: it answers at once. The first (the
    // partial) only answers if nobody stops it.
    if (children.length > 1) setImmediate(() => { c.stdout.emit('data', Buffer.from('open word and type hello')); c.emit('close', 0); });
    return c;
  };
  const finals = [], logs = [];
  try {
    const l = createListener({ userData: dir, spawn, log: m => logs.push(m), onFinal: t => finals.push(t) });
    assert.equal(l.available, true);
    l.push(pcm(700));                     // the first partial starts here
    await tick();
    assert.equal(children.length, 1);
    l.push(pcm(600));                     // more speech while it runs
    const t0 = Date.now();
    await l.flush();                      // the key comes up
    assert.ok(children[0].killed, 'the stale partial was stopped');
    assert.ok(Date.now() - t0 < 1000, 'the final did not wait out the partial budget');
    assert.deepEqual(finals, ['open word and type hello']);
    assert.ok(logs.some(m => /stale partial stopped/.test(m)));
  } finally {
    if (prev == null) delete process.env.NUS_WHISPER_DIR; else process.env.NUS_WHISPER_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A resident whisper whose partial never answers until it is hung up on.
function stuckPartialServer(finalWords) {
  const calls = [];
  return {
    calls, warm: () => Promise.resolve(true), status: () => ({ state: 'ready' }),
    transcribe: (wav, opts) => {
      calls.push(opts);
      if (!opts.partial) return Promise.resolve(finalWords);
      return new Promise((resolve) => { opts.signal.addEventListener('abort', () => resolve(null), { once: true }); });
    },
  };
}

test('a final never waits behind a resident whisper partial: key up hangs up on it', async () => {
  const server = stuckPartialServer('open word and type hello');
  const finals = [], logs = [];
  const l = createListener({ server, transcribe: () => assert.fail('no whisper-cli here'), log: m => logs.push(m), onFinal: t => finals.push(t) });
  l.push(pcm(700)); await tick();
  assert.equal(server.calls.length, 1);
  assert.equal(server.calls[0].partial, true);
  assert.equal(server.calls[0].timeoutMs, 1200);
  l.push(pcm(600));
  const t0 = Date.now();
  await l.flush();
  assert.ok(Date.now() - t0 < 300, 'the final did not wait out the partial budget');
  assert.ok(server.calls[0].signal.aborted);
  assert.equal(server.calls[1].partial, false);
  assert.equal(server.calls[1].timeoutMs, 3000, 'and has a short budget of its own');
  assert.deepEqual(finals, ['open word and type hello']);
  assert.ok(logs.some(m => /stale partial stopped \(at key up\)/.test(m)));
});

test('a pause hangs up on a partial of the same segment too', async () => {
  const server = stuckPartialServer('open word');
  const finals = [];
  const l = createListener({ server, transcribe: () => assert.fail('no whisper-cli here'), onFinal: t => finals.push(t) });
  l.push(pcm(700)); await tick();
  l.push(pcm(100));
  l.push(pcm(500, 0));                  // quiet long enough to end the segment
  await new Promise(r => setTimeout(r, 80));
  assert.ok(server.calls[0].signal.aborted);
  assert.deepEqual(finals, ['open word']);
});

test('a partial that heard everything gets a moment to be the final, then the final goes on without it', async () => {
  const server = stuckPartialServer('open word');
  const finals = [];
  const l = createListener({ server, transcribe: () => assert.fail('no whisper-cli here'), onFinal: t => finals.push(t) });
  l.push(pcm(700)); await tick();
  const t0 = Date.now();
  await l.flush();                      // nothing said since the partial started
  const took = Date.now() - t0;
  assert.ok(took >= 500 && took < 1100, 'waited about 0.7 s, not the 1.2 s budget: ' + took);
  assert.ok(server.calls[0].signal.aborted);
  assert.deepEqual(finals, ['open word']);
});

test('a partial the resident whisper could not answer does not start whisper-cli behind it', async () => {
  let cli = 0;
  const server = { warm: () => Promise.resolve(true), status: () => ({ state: 'ready' }), transcribe: async () => null };
  const partials = [];
  const l = createListener({ server, transcribe: async () => { cli++; return 'words'; }, onPartial: t => partials.push(t) });
  l.push(pcm(700)); await tick(); await tick();
  assert.equal(cli, 0);
  assert.deepEqual(partials, []);
});

test('with the resident whisper still loading, a partial comes from whisper-cli as before', async () => {
  let cli = 0;
  const server = { warm: () => Promise.resolve(true), status: () => ({ state: 'starting' }), transcribe: async () => null };
  const partials = [];
  const l = createListener({ server, transcribe: async () => { cli++; return 'words'; }, onPartial: t => partials.push(t) });
  l.push(pcm(700)); await tick(); await tick(); await tick();
  assert.equal(cli, 1);
  assert.deepEqual(partials, ['words']);
});
