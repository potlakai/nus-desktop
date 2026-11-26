'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createChats, parseClaudeExport } = require('../src/recall/chats');
const { createVault } = require('../src/recall/vault');
const { createRecall, TOP_K } = require('../src/recall/recall');
const { topicMap } = require('../src/recall/topics');
const { createEmbedder } = require('../src/recall/embed');

// A stand-in for the model: words grouped into a few "meanings", so synonyms
// land near each other and tests do not need the 23 MB model or onnxruntime.
const MEANINGS = [['car', 'suv', 'vehicle', 'lexus', 'mercedes', 'crash', 'accident'], ['book', 'novel', 'publish', 'author', 'story'], ['matrix', 'eigenvalue', 'diagonalize', 'linear', 'algebra']];
function fakeEmbedder({ calls = [] } = {}) {
  const dim = 16;
  return {
    dim, calls,
    available: () => true,
    load: async () => {},
    reason: '',
    async embed(texts) {
      calls.push(texts.length);
      return texts.map((t) => {
        const v = new Float32Array(dim);
        for (const w of String(t).toLowerCase().match(/[a-z]+/g) || []) {
          const m = MEANINGS.findIndex((g) => g.some((x) => w.startsWith(x)));
          if (m >= 0) v[m] += 1; else v[3 + (w.charCodeAt(0) % (dim - 3))] += 0.2;
        }
        let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1;
        return v.map((x) => x / n);
      });
    },
  };
}
const conv = (id, name, at, ...texts) => ({ uuid: id, name, created_at: at, updated_at: at, chat_messages: texts.map((text, i) => ({ sender: i % 2 ? 'assistant' : 'human', text, created_at: at })) });
const DATA = [
  conv('suv', 'Parents new ride', '2026-05-03T10:00:00Z', 'Lexus RX or Mercedes GLE for my parents?', 'The Lexus is more reliable.'),
  conv('book', 'Getting my novel out', '2026-04-13T10:00:00Z', 'How do I publish a novel I wrote?', 'Self publishing or an agent.'),
  conv('math', 'Homework help', '2026-04-27T10:00:00Z', 'How do I diagonalize this matrix?', 'Find each eigenvalue first.'),
  conv('pasta', 'Dinner', '2026-04-01T10:00:00Z', 'Quick pasta for dinner?', 'Garlic and oil.'),
];
function store(embedder) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nus-hybrid-'));
  const c = createChats({ file: path.join(dir, 'chats.json'), embedder });
  c.add(parseClaudeExport(DATA), 'test');
  return { c, dir };
}

test('hybrid search finds by meaning where keywords miss, and keyword hits still rank', async () => {
  const { c } = store(fakeEmbedder());
  assert.deepEqual(c.search('which vehicle for my mom and dad'), [], 'no shared words: keywords find nothing');
  assert.equal(await c.embedPending(), 8);
  const hits = await c.hybridSearch('which vehicle for my mom and dad');
  assert.equal(hits[0].title, 'Parents new ride');
  assert.equal((await c.hybridSearch('diagonalize'))[0].title, 'Homework help');
  assert.ok(hits.length <= 8);
  assert.deepEqual(await c.hybridSearch('what did I ask last week'), [], 'a question with no topic words finds nothing here');
});

test('vectors are saved next to the store, reused after a restart, made only for new passages, and forgotten with it', async () => {
  const calls = [];
  const { c, dir } = store(fakeEmbedder({ calls }));
  await c.embedPending();
  assert.ok(fs.existsSync(path.join(dir, 'chats.vectors.bin')));
  assert.ok(fs.existsSync(path.join(dir, 'chats.vectors.json')));
  const again = createChats({ file: path.join(dir, 'chats.json'), embedder: fakeEmbedder({ calls }) });
  assert.equal(await again.embedPending(), 0, 'nothing new to embed');
  assert.deepEqual(again.vectorStatus(), { available: true, reason: '', passages: 8, embedded: 8, running: false });
  again.add(parseClaudeExport([conv('new', 'Crash', '2026-06-01T10:00:00Z', 'My brother had a car accident')]), 'test');
  assert.equal(await again.embedPending(), 1);
  again.forgetAll();
  assert.ok(!fs.existsSync(path.join(dir, 'chats.vectors.bin')));
  assert.ok(!fs.existsSync(path.join(dir, 'chats.vectors.json')));
});

test('a vector file from another model is ignored, not misread', async () => {
  const { c, dir } = store(fakeEmbedder());
  await c.embedPending();
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'chats.vectors.json'), 'utf8'));
  fs.writeFileSync(path.join(dir, 'chats.vectors.json'), JSON.stringify({ ...meta, model: 'something-else' }));
  const again = createChats({ file: path.join(dir, 'chats.json'), embedder: fakeEmbedder() });
  assert.equal(again.vectorStatus().embedded, 0);
});

test('retrieval on 1,000 messages stays under 150 ms, keywords and hybrid', async () => {
  const words = 'alpha beta gamma delta epsilon zeta theta kappa lambda sigma omega matrix novel vehicle garden river'.split(' ');
  const many = Array.from({ length: 100 }, (_, i) => conv('c' + i, 'Chat ' + i + ' about ' + words[i % words.length], '2026-05-01T10:00:00Z',
    ...Array.from({ length: 10 }, (_, j) => Array.from({ length: 120 }, (_, k) => words[(i * 7 + j * 3 + k) % words.length]).join(' ') + '.')));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nus-speed-'));
  const c = createChats({ file: path.join(dir, 'chats.json'), embedder: fakeEmbedder() });
  c.add(parseClaudeExport(many), 'test');
  assert.equal(c.stats().messages, 1000);
  await c.embedPending();
  await c.warm();
  c.search('warm');
  for (const q of ['matrix novel', 'river garden vehicle']) {
    let t = process.hrtime.bigint();
    c.search(q, { limit: 8 });
    const kw = Number(process.hrtime.bigint() - t) / 1e6;
    t = process.hrtime.bigint();
    await c.hybridSearch(q, { limit: 8 });
    const hy = Number(process.hrtime.bigint() - t) / 1e6;
    assert.ok(kw < 150, 'keywords took ' + kw.toFixed(1) + ' ms');
    assert.ok(hy < 150, 'hybrid took ' + hy.toFixed(1) + ' ms');
  }
});

test('a chats ask puts the top 8 passages from hybrid search in the prompt and says how long retrieval took', async () => {
  const { c } = store(fakeEmbedder());
  await c.embedPending();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nus-hv-'));
  const r = createRecall({ chats: c, vault: createVault({ root: () => '' }), vaultRoot: () => '' });
  const x = await r.prepare('across my chats, what did I decide about a vehicle for my parents');
  assert.equal(TOP_K, 8);
  assert.match(x.prompt, /Parents new ride/);
  assert.match(x.note, /hybrid, \d+ ms$/);
  assert.ok(x.retrievalMs >= 0);
  void root;
});

test('topics: chats grouped by meaning, named by their words, one-offs on their own', async () => {
  const { c } = store(fakeEmbedder());
  c.add(parseClaudeExport([conv('suv2', 'SUV pick', '2026-05-21T10:00:00Z', 'Find me a white Lexus SUV deal'), conv('book2', 'Book money', '2026-04-28T10:00:00Z', 'How would I make money from my novel as an author?')]), 'test');
  await c.embedPending();
  const m = topicMap(c.conversations, { vectorOf: (x) => c.conversationVector(x.id), target: 4 });
  assert.equal(m.method, 'meaning');
  const of = (id) => m.topics.findIndex((t) => t.conversations.some((x) => x.id === id));
  assert.equal(of('claude:suv'), of('claude:suv2'));
  assert.equal(of('claude:book'), of('claude:book2'));
  assert.notEqual(of('claude:suv'), of('claude:book'));
  const suv = m.topics[of('claude:suv')];
  assert.equal(suv.count, 2);
  assert.equal(suv.from, '2026-05-03');
  assert.equal(suv.to, '2026-05-21');
  assert.deepEqual(suv.conversations.map((x) => x.title), ['SUV pick', 'Parents new ride'], 'newest first');
  const kw = topicMap(c.conversations, { target: 3 });
  assert.equal(kw.method, 'keywords');
  assert.equal(kw.topics.reduce((n, t) => n + t.count, 0), 6);
  assert.deepEqual(topicMap([]), { method: 'none', topics: [] });
  void createEmbedder;
});
