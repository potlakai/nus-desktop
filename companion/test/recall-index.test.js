'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createIndex, tokenize, queryTerms, passages } = require('../src/recall/bm25');

test('tokenize folds case and accents, drops stop words, plurals and hashes', () => {
  assert.deepEqual(tokenize('The Nūs Chats about Eigenvalues'), ['nus', 'chat', 'about', 'eigenvalue']);
  assert.deepEqual(tokenize('commit 656e028 at 20261016t210747'), ['commit']);
  assert.deepEqual(tokenize("Pranav's class"), ['pranav', 'class'], 'possessive and double s kept whole');
});

test('queryTerms drops the frame of an ask but indexing keeps those words', () => {
  assert.deepEqual(queryTerms('What did I ask Claude about the FPL moneyball bot last week?'), ['fpl', 'moneyball', 'bot']);
  assert.ok(tokenize('notes about Claude').includes('claude'), 'a note about Claude is still findable');
});

test('BM25 ranks the passage with more and rarer matching words first', () => {
  const ix = createIndex();
  ix.add('a', 'eigenvalues and eigenvectors of a matrix', { n: 'a' });
  ix.add('b', 'matrix multiplication basics', { n: 'b' });
  ix.add('c', 'cooking pasta at home', { n: 'c' });
  const hits = ix.search('eigenvalues matrix');
  assert.equal(hits[0].id, 'a');
  assert.equal(hits[0].matched, 2);
  assert.deepEqual(hits.map((h) => h.id), ['a', 'b']);
  assert.deepEqual(ix.search('nothing here'), []);
});

test('documents are replaced and removed, and a filter narrows results', () => {
  const ix = createIndex();
  ix.add('a', 'alpha beta', { day: 1 });
  ix.add('b', 'alpha gamma', { day: 2 });
  ix.add('a', 'delta only', { day: 3 });
  assert.deepEqual(ix.search('alpha').map((h) => h.id), ['b']);
  assert.deepEqual(ix.search('delta').map((h) => h.meta.day), [3]);
  assert.deepEqual(ix.search('alpha delta', { filter: (m) => m.day > 2 }).map((h) => h.id), ['a']);
  assert.equal(ix.remove('b'), true);
  assert.equal(ix.remove('b'), false);
  assert.equal(ix.size, 1);
  assert.deepEqual(ix.search('alpha'), []);
});

test('sealed postings still search, grow and compact', () => {
  const ix = createIndex();
  for (let i = 0; i < 3000; i++) ix.add('d' + i, 'common word ' + (i % 2 ? 'odd' : 'even'), { i });
  ix.seal();
  ix.add('late', 'common late', {});
  for (let i = 0; i < 2000; i++) ix.remove('d' + i);
  assert.equal(ix.size, 1001);
  assert.equal(ix.search('late')[0].id, 'late');
  assert.equal(ix.search('common', { limit: 5000 }).length, 1001);
});

test('passages cut long text near size at paragraph or sentence ends, keeping every word', () => {
  assert.deepEqual(passages('short'), ['short']);
  const para = 'One sentence here. '.repeat(120);
  const parts = passages(para + '\n\n' + 'x'.repeat(3000), 900);
  assert.ok(parts.length > 3);
  assert.ok(parts.every((p) => p.length <= 1200));
  assert.equal(parts.join('').replace(/\s/g, '').length, (para + 'x'.repeat(3000)).replace(/\s/g, '').length);
});
