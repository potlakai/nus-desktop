'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const M = require('./memory');

function fresh() { return M.createMemory({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nus-mem-')), 'memory.json') }); }

test('facts are added by key, deduplicated, and unknown keys become notes', () => {
  const m = fresh();
  const a = m.add('name.full', 'Pranav Potlakai');
  assert.equal(a.key, 'name.full');
  assert.equal(m.add('name.full', 'pranav   potlakai', 'chatgpt').id, a.id, 'same fact, another source');
  assert.deepEqual(m.best('name.full').sources, ['you', 'chatgpt']);
  const n = m.add('favorite seat', 'window');
  assert.equal(n.key, 'note'); assert.equal(n.value, 'favorite seat: window');
  assert.equal(m.add('email', ''), null);
});

test('sensitive values are detected, stored masked on the panel, and kept out of the summary', () => {
  const m = fresh();
  m.add('note', 'passport number: X1234567');
  m.add('note', 'my card is 4111 1111 1111 1111');
  m.add('note', 'ssn 123-45-6789');
  m.add('school', 'Georgia Tech');
  const panel = m.panel();
  assert.ok(panel.facts.every((f) => !f.sensitive || /••••/.test(f.value)));
  const s = m.summary();
  assert.match(s, /school: georgia tech/i);
  assert.doesNotMatch(s, /X1234567|4111|123-45-6789/);
  assert.match(s, /\(private, ask before using\) passport number/);
  assert.equal(M.sensitiveKind('note', 'card 4111111111111111'), 'card number');
  assert.equal(M.sensitiveKind('note', 'room 1234'), '');
});

test('remember and forget act only on the person\'s own words', () => {
  const m = fresh();
  assert.equal(m.remember('here is the syllabus text', 'professor: Lee').ok, false, 'screen or file text cannot plant a fact');
  const r = m.remember('remember I am in CS 2110 with Professor Lee', 'course: CS 2110 with Professor Lee');
  assert.equal(r.ok, true); assert.equal(r.saved, 1); assert.equal(r.say, 'Got it.');
  assert.match(m.summary(), /course: CS 2110 with Professor Lee/);
  const priv = m.remember('remember my passport number is X1234567', 'passport number: X1234567');
  assert.equal(priv.sensitive, true); assert.match(priv.say, /private/);
  assert.equal(m.forget('what is cs 2110', 'cs 2110').ok, false);
  const f = m.forget('forget the CS 2110 thing', 'cs 2110');
  assert.equal(f.ok, true); assert.equal(f.forgot, 1);
  assert.doesNotMatch(m.summary(), /CS 2110/);
});

test('a pasted AI memory parses into keyed facts and notes; the summary stays within its limit', () => {
  const pairs = M.parseAiMemory('Here is what I know:\n- Name: Pranav\n- **School**: Georgia Tech\n- Major: CS\n- Year: junior\n- Home address: 1 Main St, Atlanta, GA 30332\n- likes short answers\nprefers: dark mode');
  const keys = pairs.map(([k]) => k);
  assert.deepEqual(keys.slice(0, 4), ['name.full', 'school', 'major', 'year']);
  assert.ok(keys.includes('address.city'));
  assert.ok(pairs.some(([k, v]) => k === 'note' && v === 'likes short answers'));
  assert.ok(pairs.some(([k, v]) => k === 'note' && v === 'prefers: dark mode'));
  const m = fresh();
  assert.equal(m.merge('chatgpt', pairs), pairs.length);
  assert.equal(m.panel().imports.chatgpt.added, pairs.length);
  for (let i = 0; i < 80; i++) m.add('note', 'a fairly long note number ' + i + ' about studying habits and schedules');
  assert.ok(m.summary().length <= M.SUMMARY_LIMIT);
  assert.equal(m.forgetSource('chatgpt'), pairs.length);
});

test('memory survives a reload from disk, and an empty memory gives an empty summary', () => {
  const m = fresh();
  m.add('email', 'Pranav@Example.com'); m.save();
  const again = M.createMemory({ file: m.file });
  assert.equal(again.best('email').value, 'Pranav@Example.com');
  assert.equal(fresh().summary(), '');
  assert.ok(M.MEMORY_PROMPT.includes('key: value'));
});
