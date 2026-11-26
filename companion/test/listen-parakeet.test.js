'use strict';
// Finals with an optional better engine: when it is ready its words are the
// final, and anything else lands on whisper at once. Partials never change.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createListener, CFG } = require('../src/reflex/listen');

const pcm = (ms, level = 1000) => {
  const b = Buffer.alloc(ms * 32);
  for (let i = 0; i < b.length; i += 2) b.writeInt16LE(level, i);
  return b;
};
const tick = () => new Promise((r) => setImmediate(r));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeServer(answer = () => 'whisper words') {
  const calls = [];
  return {
    calls,
    warm: () => Promise.resolve(true),
    status: () => ({ state: 'ready' }),
    transcribe: async (wav, opts) => { calls.push(opts); return answer(opts); },
  };
}

function engine({ ready = true, wanted = true, transcribe = async () => 'Parakeet words.' } = {}) {
  const e = { name: 'parakeet', calls: [], wanted: () => wanted, ready: () => (typeof ready === 'function' ? ready() : ready) };
  e.transcribe = (p) => { e.calls.push(p); return transcribe(p); };
  return e;
}

function rig(finalEngine, server = fakeServer()) {
  const finals = [], partials = [], logs = [];
  const l = createListener({ server, finalEngine, vocabulary: [], log: (m) => logs.push(m), onFinal: (t, meta) => finals.push({ t, meta }), onPartial: (t) => partials.push(t) });
  return { l, finals, partials, logs, server };
}
const finalLog = (logs) => logs.find((m) => m.startsWith('[listen] final'));

test('ready: the final is the engine\'s words, whisper is not asked, and the log says so', async () => {
  const e = engine();
  const r = rig(e);
  r.l.push(pcm(400)); await r.l.flush();
  assert.deepEqual(r.finals.map((f) => f.t), ['Parakeet words.']);
  assert.equal(r.finals[0].meta.reason, 'flush');
  assert.equal(r.server.calls.length, 0);
  assert.equal(e.calls.length, 1);
  assert.equal(e.calls[0].length, pcm(400).length, 'it gets the raw 16 kHz samples, not a wav');
  assert.match(finalLog(r.logs), /^\[listen\] final \d+ms \(flush, 400ms audio, speech~\d+ quiet~\d+, parakeet\) "Parakeet words\."$/);
});

test('the engine\'s words go through the same clean-up as whisper\'s', async () => {
  const r = rig(engine({ transcribe: async () => '  [noise] Open   Word. Open Word. ' }));
  r.l.push(pcm(1000)); await r.l.flush();
  assert.deepEqual(r.finals.map((f) => f.t), ['Open Word.']);
});

test('not loaded yet: whisper answers at once and the engine is not called', async () => {
  const e = engine({ ready: false });
  const r = rig(e);
  r.l.push(pcm(400)); await r.l.flush();
  assert.deepEqual(r.finals.map((f) => f.t), ['whisper words']);
  assert.equal(e.calls.length, 0);
  assert.match(finalLog(r.logs), /, whisper, parakeet not loaded\) "whisper words"$/);
});

test('off: the log says plain whisper, as if the engine were not there', async () => {
  const r = rig(engine({ ready: false, wanted: false }));
  r.l.push(pcm(400)); await r.l.flush();
  assert.match(finalLog(r.logs), /, whisper\) "whisper words"$/);
});

test('no engine at all behaves as before', async () => {
  const r = rig(undefined);
  r.l.push(pcm(400)); await r.l.flush();
  assert.deepEqual(r.finals.map((f) => f.t), ['whisper words']);
  assert.match(finalLog(r.logs), /, whisper\) "whisper words"$/);
});

test('an engine error falls back to whisper, and says why', async () => {
  const r = rig(engine({ transcribe: async () => { throw new Error('worker exited'); } }));
  r.l.push(pcm(400)); await r.l.flush();
  assert.deepEqual(r.finals.map((f) => f.t), ['whisper words']);
  assert.match(finalLog(r.logs), /, whisper, parakeet worker exited\) "whisper words"$/);
});

test('an engine that throws out of ready() or transcribe() cannot cost the person their words', async () => {
  const sync = rig(engine({ transcribe: () => { throw new Error('boom'); } }));
  sync.l.push(pcm(400)); await sync.l.flush();
  assert.deepEqual(sync.finals.map((f) => f.t), ['whisper words']);
  const broken = rig(engine({ ready: () => { throw new Error('boom'); } }));
  broken.l.push(pcm(400)); await broken.l.flush();
  assert.deepEqual(broken.finals.map((f) => f.t), ['whisper words']);
});

test('no words from the engine: whisper gets its turn', async () => {
  const r = rig(engine({ transcribe: async () => '' }));
  r.l.push(pcm(400)); await r.l.flush();
  assert.deepEqual(r.finals.map((f) => f.t), ['whisper words']);
  assert.match(finalLog(r.logs), /, whisper, parakeet no words\)/);
});

test('over budget: whisper answers, the budget is about 1.5 s, and a late answer is dropped', async () => {
  assert.equal(CFG.betterFinalBudgetMs, 1500);
  const saved = CFG.betterFinalBudgetMs;
  CFG.betterFinalBudgetMs = 30;
  try {
    let late;
    const r = rig(engine({ transcribe: () => new Promise((resolve) => { late = resolve; }) }));
    r.l.push(pcm(400));
    const t0 = Date.now();
    await r.l.flush();
    assert.ok(Date.now() - t0 < 1000);
    assert.deepEqual(r.finals.map((f) => f.t), ['whisper words']);
    assert.match(finalLog(r.logs), /, whisper, parakeet over budget\)/);
    late('too late');
    await tick();
    assert.equal(r.finals.length, 1);
  } finally { CFG.betterFinalBudgetMs = saved; }
});

test('reused-partial path: with the engine ready the final is the engine\'s, not the partial\'s', async () => {
  const e = engine();
  const r = rig(e, fakeServer(() => 'open notepad partial'));
  r.l.push(pcm(CFG.firstPartialMs + 50));
  await tick(); await tick();
  assert.deepEqual(r.partials, ['open notepad partial'], 'the partial still comes from whisper');
  assert.equal(r.server.calls.length, 1);
  await r.l.flush();
  assert.deepEqual(r.finals.map((f) => f.t), ['Parakeet words.']);
  assert.equal(r.server.calls.length, 1, 'whisper was not asked again');
  assert.equal(e.calls.length, 1);
  assert.ok(!finalLog(r.logs).includes('reused partial'));
});

test('reused-partial path: engine off, the partial is the final as before, without running anything', async () => {
  const e = engine({ ready: false, wanted: false });
  const r = rig(e, fakeServer(() => 'open notepad partial'));
  r.l.push(pcm(CFG.firstPartialMs + 50));
  await tick(); await tick();
  await r.l.flush();
  assert.deepEqual(r.finals.map((f) => f.t), ['open notepad partial']);
  assert.equal(r.server.calls.length, 1);
  assert.equal(e.calls.length, 0);
  assert.match(finalLog(r.logs), /^\[listen\] final 0ms \(flush, reused partial, speech~\d+ quiet~\d+, whisper\) "open notepad partial"$/);
});

test('reused-partial path: the engine fails, and the whole partial answers instead of a second decode', async () => {
  const r = rig(engine({ transcribe: async () => { throw new Error('worker exited'); } }), fakeServer(() => 'open notepad partial'));
  r.l.push(pcm(CFG.firstPartialMs + 50));
  await tick(); await tick();
  await r.l.flush();
  assert.deepEqual(r.finals.map((f) => f.t), ['open notepad partial']);
  assert.equal(r.server.calls.length, 1);
  assert.match(finalLog(r.logs), /reused partial, speech~\d+ quiet~\d+, whisper, parakeet worker exited\)/);
});

test('reused-partial path: not loaded yet, the partial is the final', async () => {
  const r = rig(engine({ ready: false }), fakeServer(() => 'open notepad partial'));
  r.l.push(pcm(CFG.firstPartialMs + 50));
  await tick(); await tick();
  await r.l.flush();
  assert.deepEqual(r.finals.map((f) => f.t), ['open notepad partial']);
  assert.match(finalLog(r.logs), /whisper, parakeet not loaded\)/);
});

test('a partial still running when the final is due is hung up on, not waited for', async () => {
  const e = engine();
  let abort = null;
  const server = fakeServer((opts) => new Promise((resolve) => { abort = () => resolve(null); opts.signal.addEventListener('abort', abort); }));
  const r = rig(e, server);
  r.l.push(pcm(CFG.firstPartialMs + 50));
  await tick();
  const t0 = Date.now();
  await r.l.flush();
  assert.ok(Date.now() - t0 < CFG.slowPartialMs, 'no wait for a partial that can no longer be the final');
  assert.deepEqual(r.finals.map((f) => f.t), ['Parakeet words.']);
});

test('a new press during the decode drops the answer, and whisper is not started for it', async () => {
  let answer;
  const r = rig(engine({ transcribe: () => new Promise((resolve) => { answer = resolve; }) }));
  r.l.push(pcm(400));
  const done = r.l.flush();
  await wait(5);
  r.l.reset();
  answer('Parakeet words.');
  await done;
  assert.equal(r.finals.length, 0);
  assert.equal(r.server.calls.length, 0);
});

test('partials stay on whisper while the engine is ready', async () => {
  const e = engine();
  const r = rig(e, fakeServer(() => 'heard so far'));
  r.l.push(pcm(CFG.firstPartialMs + 50));
  await tick(); await tick();
  assert.deepEqual(r.partials, ['heard so far']);
  assert.equal(e.calls.length, 0);
});
