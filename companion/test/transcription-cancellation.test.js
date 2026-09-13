const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter, getEventListeners } = require('node:events');
const { createRequire } = require('node:module');

function loadModule(relative, overrides = {}) {
  const filename = path.resolve(__dirname, relative);
  const realRequire = createRequire(filename);
  const context = vm.createContext({
    module: { exports: {} }, Buffer, process, console, setTimeout, clearTimeout,
    __dirname: path.dirname(filename),
    require: (name) => name in overrides ? overrides[name] : realRequire(name),
  });
  vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  return context;
}

test('cancelling local transcription stops the worker and removes its abort listener', async () => {
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  let killed = 0; child.kill = () => { killed++; };
  const context = loadModule('../../src/stt-local.js', { child_process: { spawn: () => child } });
  const controller = new AbortController();
  const work = context.runWhisper('fixture', 'model', 'audio', controller.signal);
  controller.abort();
  assert.equal((await work).cancelled, true);
  assert.equal(killed, 1);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  child.stdout.emit('data', Buffer.from('late words'));
  child.emit('close', 0);
});

test('an already cancelled transcription never spawns a worker', async () => {
  const context = loadModule('../../src/stt-local.js', { child_process: { spawn: () => assert.fail('worker started') } });
  const controller = new AbortController(); controller.abort();
  assert.equal((await context.runWhisper('fixture', 'model', 'audio', controller.signal)).cancelled, true);
});

test('a completed local transcription releases cancellation resources', async () => {
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.kill = () => assert.fail('completed worker killed');
  const context = loadModule('../../src/stt-local.js', { child_process: { spawn: () => child } });
  const controller = new AbortController();
  const work = context.runWhisper('fixture', 'model', 'audio', controller.signal);
  child.stdout.emit('data', Buffer.from('all the words'));
  child.emit('close', 0);
  assert.equal((await work).text, 'all the words');
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  controller.abort();
});

test('cancellation does not start a cloud fallback after local failure', async () => {
  let rejectLocal;
  const context = loadModule('../src/stt.js', {
    '../../src/stt-local': { status: () => ({ available: true }), transcribePcm: () => new Promise((_r, reject) => { rejectLocal = reject; }) },
    openai: () => assert.fail('cloud fallback started after cancellation'),
  });
  const controller = new AbortController();
  const stt = context.module.exports.createSTT({ apiKeys: { openai: 'fixture-not-a-key' } });
  const work = stt.transcribe(Buffer.alloc(6400), { signal: controller.signal });
  controller.abort(); rejectLocal(new Error('cancelled'));
  assert.equal((await work).cancelled, true);
});

test('configured speech providers receive cancellation signals without a live request', async () => {
  const controller = new AbortController();
  class FakeOpenAI {
    static async toFile() { return {}; }
    audio = { transcriptions: { create: async (_body, options) => {
      assert.equal(options.signal, controller.signal); return { text: 'openai fixture' };
    } } };
  }
  class FakeGemini {
    models = { generateContent: async (body) => {
      assert.equal(body.config.abortSignal, controller.signal); return { text: 'gemini fixture' };
    } };
  }
  const context = loadModule('../src/stt.js', {
    '../../src/stt-local': { status: () => ({ available: false }) },
    openai: FakeOpenAI, '@google/genai': { GoogleGenAI: FakeGemini },
  });
  for (const provider of ['openai', 'gemini']) {
    const stt = context.module.exports.createSTT({ apiKeys: { [provider]: 'fixture-not-a-key' } });
    assert.equal((await stt.transcribe(Buffer.alloc(6400), { signal: controller.signal })).text, provider + ' fixture');
  }
});
