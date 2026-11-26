'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTokenizer, basicTokens, createEmbedder, dot, DIM } = require('../src/recall/embed');
const { createChats, parseClaudeExport } = require('../src/recall/chats');

const VOCAB = ['[PAD]', '[UNK]', '[CLS]', '[SEP]', 'un', '##aff', '##able', 'hello', ',', 'world', '!', 'eigen', '##value', '##s', 'cafe'].join('\n');

test('BERT basic tokens: lowercase, accents off, punctuation split', () => {
  assert.deepEqual(basicTokens('Hello, World! Café'), ['hello', ',', 'world', '!', 'cafe']);
});

test('WordPiece: longest match first, ## continuations, [UNK] for the rest, [CLS] and [SEP] around, cut at max', () => {
  const t = createTokenizer(VOCAB);
  assert.deepEqual(t.wordPiece('unaffable'), [4, 5, 6]);
  assert.deepEqual(t.wordPiece('eigenvalues'), [11, 12, 13]);
  assert.deepEqual(t.wordPiece('zzz'), [1]);
  assert.deepEqual(t.encode('Hello, world!'), [2, 7, 8, 9, 10, 3]);
  assert.deepEqual(t.encode('hello hello hello hello', 4), [2, 7, 7, 3]);
});

test('missing model or runtime: not available, with a reason, and search falls back to keywords', async () => {
  const e = createEmbedder({ modelDir: path.join(os.tmpdir(), 'no-model-here') });
  assert.equal(e.available(), false);
  assert.match(e.reason, /missing|not installed/);
  const chats = createChats({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nus-emb-')), 'c.json'), embedder: e });
  chats.add(parseClaudeExport([{ uuid: 'a', name: 'Eigenvalues', created_at: '2026-01-01T00:00:00Z', chat_messages: [{ sender: 'human', text: 'what is an eigenvalue', created_at: '2026-01-01T00:00:00Z' }] }]), 't');
  assert.equal((await chats.hybridSearch('eigenvalue question'))[0].title, 'Eigenvalues');
  assert.equal(await chats.embedPending(), 0);
});

// The real model, when this checkout has it (npm run setup:embed). Skipped otherwise.
const real = createEmbedder();
test('the local model puts related sentences near each other', { skip: real.available() ? false : 'model not installed (npm run setup:embed)' }, async () => {
  const [a, b, c] = await real.embed(['How do I diagonalize a matrix?', 'Find the eigenvectors, then write it as P D P inverse.', 'A recipe for pasta with garlic']);
  assert.equal(a.length, DIM);
  assert.ok(Math.abs(dot(a, a) - 1) < 1e-4, 'unit length');
  assert.ok(dot(a, b) > dot(a, c) + 0.2, 'related beats unrelated');
});
