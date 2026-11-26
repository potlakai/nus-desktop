'use strict';
// 0.1.36. A user report, 2026-11-21: after installing, neither a Gemini key nor an Nvidia key
// worked.
//   - Nvidia ended meta/llama-3.2-90b-vision-instruct on 2026-11-16. Every Nvidia ask got
//     410 Gone, and the key box read it as "That key did not work". Both tiers now use
//     nvidia/nemotron-3.5-super-vl-120b-a12b, sent with reasoning_effort "none".
//   - The key Test pinged publik whenever the stored choice was publik, so with an empty
//     balance a good Gemini or Nvidia key read as "That key did not work". It now tests the key.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const Module = require('node:module');
const { createLLM, streamOpenAI, nvidiaArgs, NVIDIA_BASE_URL } = require('../src/llm');
const { plainKeyError } = require('../src/get-started');
const { plainAskError, ownKeyStuck } = require('../src/ask-error');

const root = path.resolve(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8').replace(/\r\n/g, '\n');
const NEMOTRON = 'nvidia/nemotron-3.5-super-vl-120b-a12b';
// Nvidia's answer for the old model, read 2026-11-22 through the app's own OpenAI client.
const GONE = '410 {"type":"about:blank","title":"Gone","status":410,"detail":"The model \'meta/llama-3.2-90b-vision-instruct\' has reached its end of life on 2026-11-16T09:00:00Z and is no longer available."}';
// And for a key it does not know, same day.
const REFUSED = '403 {"status":403,"title":"Forbidden","detail":"Authorization failed"}';

// A fresh store over a fake electron (as in store-save.test.js).
function storeWith(saved) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nus-nvidia-'));
  fs.writeFileSync(path.join(dir, 'companion-settings.json'), JSON.stringify({ encrypted: true, payload: Buffer.from(JSON.stringify(saved)).toString('base64') }));
  const fake = { app: { getPath: (n) => (n === 'userData' ? dir : path.join(dir, 'appdata')) },
    safeStorage: { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() } };
  const file = path.join(root, 'companion', 'src', 'store.js');
  const load = Module._load;
  Module._load = function (req, ...rest) { return req === 'electron' ? fake : load.call(this, req, ...rest); };
  delete require.cache[file];
  let store;
  try { store = require(file); } finally { Module._load = load; }
  store.setStandalone(true);
  const log = console.log;
  console.log = () => {};
  try { return store.getSettings(); } finally { console.log = log; }
}

test('a saved file pinned to either ended Llama vision model now asks Nemotron, on both tiers', () => {
  for (const old of ['meta/llama-3.2-90b-vision-instruct', 'meta/llama-3.2-11b-vision-instruct']) {
    const s = storeWith({ provider: 'nvidia', apiKeys: { nvidia: 'nvapi-test' }, models: { nvidia: { fast: old, smart: old } } });
    assert.deepEqual(s.models.nvidia, { fast: NEMOTRON, smart: NEMOTRON }, old);
  }
  // A new install, and one that never saved a models block, get it from the defaults.
  assert.deepEqual(storeWith({}).models.nvidia, { fast: NEMOTRON, smart: NEMOTRON });
  // Nothing else moved.
  const other = storeWith({ models: { gemini: { fast: 'gemini-3.6-flash', smart: 'gemini-3.6-pro' } } });
  assert.deepEqual(other.models.gemini, { fast: 'gemini-3.6-flash', smart: 'gemini-3.6-pro' });
});

test('Nemotron is asked not to think; other Nvidia models get no extra field', () => {
  const a = nvidiaArgs({ model: NEMOTRON, apiKey: 'nvapi-test', maxTokens: 8 });
  assert.equal(a.baseURL, NVIDIA_BASE_URL);
  assert.equal(NVIDIA_BASE_URL, 'https://integrate.api.nvidia.com/v1');
  assert.deepEqual(a.extra, { reasoning_effort: 'none' });
  assert.equal(a.maxTokens, 8);
  assert.equal(nvidiaArgs({ model: 'google/gemma-4-31b-it' }).extra, undefined);
});

// A stand-in for Nvidia's endpoint: records the request, answers in server-sent events.
function standIn(chunks) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const delta of chunks) res.write('data: ' + JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: NEMOTRON, choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n');
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, base: 'http://127.0.0.1:' + server.address().port + '/v1' })));
}

test('on the wire: model, reasoning_effort "none", the screenshot as an image_url part; thinking text never reaches the answer', async () => {
  // Nemotron sends its thinking in reasoning_content, apart from the answer in content.
  const s = await standIn([{ role: 'assistant', reasoning_content: 'Let me look at the screen.' }, { content: 'Click ' }, { content: 'Save.' }]);
  try {
    const tokens = [];
    const args = nvidiaArgs({ apiKey: 'nvapi-test', model: NEMOTRON, maxTokens: 4096, system: 'You are Nūs.', turns: [{ role: 'user', text: 'where do I save?' }],
      imageDataUrl: 'data:image/jpeg;base64,/9j/AAAA', onToken: (t) => tokens.push(t) });
    const text = await streamOpenAI({ ...args, baseURL: s.base });
    assert.equal(text, 'Click Save.');
    assert.deepEqual(tokens, ['Click ', 'Save.']);
    const { url, auth, body } = s.seen[0];
    assert.equal(url, '/v1/chat/completions');
    assert.equal(auth, 'Bearer nvapi-test');
    assert.equal(body.model, NEMOTRON);
    assert.equal(body.reasoning_effort, 'none');
    assert.equal(body.stream, true);
    assert.equal(body.max_tokens, 4096);
    assert.deepEqual(body.messages[0], { role: 'system', content: 'You are Nūs.' });
    assert.deepEqual(body.messages[1].content, [{ type: 'text', text: 'where do I save?' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j/AAAA' } }]);
  } finally { s.server.close(); }
});

test('the other OpenAI-shaped callers send no reasoning_effort (publik, OpenAI)', async () => {
  const s = await standIn([{ content: 'OK' }]);
  try {
    await streamOpenAI({ apiKey: 'k', model: 'fast', maxTokens: 8, system: 's', turns: [{ role: 'user', text: 'ping' }], onToken: () => {}, baseURL: s.base });
    await streamOpenAI({ apiKey: 'k', model: 'fast', maxTokens: 8, system: 's', turns: [{ role: 'user', text: 'ping' }], onToken: () => {}, baseURL: s.base, idleAfterTextMs: 2500 });
    for (const r of s.seen) assert.equal('reasoning_effort' in r.body, false);
  } finally { s.server.close(); }
});

test('an ended model reads as "no longer offers the model", in the key box and in the bubble', () => {
  assert.equal(plainKeyError('nvidia', GONE), 'Nvidia no longer offers the model Nūs asked for. Use a free Gemini key for now.');
  assert.equal(plainAskError('nvidia', new Error(GONE)), 'Nvidia no longer offers the model Nūs asked for. Use another key in Settings > Keys for now.');
  assert.equal(ownKeyStuck('nvidia', new Error(GONE)), true);
  // A bare 410 with no body says the same.
  assert.match(plainKeyError('nvidia', '410 status code (no body)'), /no longer offers the model/);
  // A key Nvidia does not know still reads as a key problem.
  assert.equal(plainKeyError('nvidia', REFUSED), 'Nvidia did not accept this key. Copy it again from build.nvidia.com; it starts with nvapi-.');
});

test('the key Test asks the key\'s own provider, even while publik answers the asks', () => {
  const saved = { on: process.env.NUS_PUBLIK, key: process.env.PUBLIK_API_KEY };
  process.env.NUS_PUBLIK = '1';
  process.env.PUBLIK_API_KEY = 'publik-test-key';
  try {
    const s = { provider: 'gemini', smart: false, apiKeys: { gemini: 'AQ.test-key-0000000000000', nvidia: 'nvapi-test' },
      models: { gemini: { fast: 'gemini-3.6-flash', smart: 'gemini-3.6-pro' }, nvidia: { fast: NEMOTRON, smart: NEMOTRON } } };
    // The asks: publik, as before.
    assert.equal(createLLM({ ...s, provider: 'nvidia' }).provider, 'publik');
    // The Test: the key itself.
    const nv = createLLM({ ...s, provider: 'nvidia' }, { ownKey: true });
    assert.equal(nv.provider, 'nvidia');
    assert.equal(nv.model, NEMOTRON);
    assert.equal(nv.apiKey, 'nvapi-test');
    assert.equal(nv.ready, true);
    const gm = createLLM({ ...s, provider: 'gemini' }, { ownKey: true });
    assert.equal(gm.provider, 'gemini');
    assert.equal(gm.apiKey, 'AQ.test-key-0000000000000');
    // No key saved: not ready, so the Test says "no key" instead of asking publik.
    assert.equal(createLLM({ ...s, provider: 'nvidia', apiKeys: {} }, { ownKey: true }).ready, false);
  } finally {
    if (saved.on === undefined) delete process.env.NUS_PUBLIK; else process.env.NUS_PUBLIK = saved.on;
    if (saved.key === undefined) delete process.env.PUBLIK_API_KEY; else process.env.PUBLIK_API_KEY = saved.key;
  }
});

test('Settings > Keys Test is wired to the own-key path', () => {
  const main = read('src', 'main-companion.js');
  const fn = /async function testKeys\(which\) \{[\s\S]*?\n\}\n/.exec(main);
  assert.ok(fn, 'testKeys');
  assert.match(fn[0], /createLLM\(\{ \.\.\.s, provider, smart: false \}, \{ ownKey: true \}\)/);
  assert.equal((fn[0].match(/createLLM\(/g) || []).length, 1, 'one client, built the own-key way');
});
