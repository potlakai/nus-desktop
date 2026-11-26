'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const M = require('../src/memory');

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
  // A card number, password or ID is refused outright (Pranav, 2026-11-03), never kept masked.
  const priv = m.remember('remember my passport number is X1234567', 'passport number: X1234567');
  assert.equal(priv.ok, false); assert.equal(priv.reason, 'sensitive'); assert.match(priv.say, /will not keep/);
  assert.doesNotMatch(m.summary(), /X1234567/);
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

test('a correction right after a save replaces the value of that fact', () => {
  let t = 1000;
  const m = M.createMemory({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nus-mem-')), 'memory.json'), now: () => t });
  m.remember('Remember my dorm is Clark Hall, room 211', 'my dorm is Clark Hall, room 211');
  const before = m.facts[0].id;
  t += 6000;
  const r = m.correctLast("Sorry, it's room 212.");
  assert.equal(r.ok, true);
  assert.equal(r.say, 'Changed it to room 212.');
  assert.equal(m.facts.length, 1, 'replaced, not added');
  assert.equal(m.facts[0].id, before);
  assert.equal(m.facts[0].value, 'my dorm is Clark Hall, room 212');
  assert.match(m.summary(), /room 212/);
  assert.doesNotMatch(m.summary(), /room 211/);
  const again = M.createMemory({ file: m.file });
  assert.equal(again.facts[0].value, 'my dorm is Clark Hall, room 212', 'on disk too');
  t += 1000;
  assert.equal(m.correctLast('No, make that 214').ok, true, 'a second go at it');
  assert.equal(m.facts[0].value, 'my dorm is Clark Hall, room 214');
  t += 121000;
  assert.deepEqual(m.correctLast('Sorry, it is room 300'), { ok: false, reason: 'not a correction' }, 'two minutes on, the words are about something else');
  assert.equal(m.facts[0].value, 'my dorm is Clark Hall, room 214');
});

test('with nothing just saved, or words that are not a correction, memory is left alone', () => {
  let t = 1000;
  const m = M.createMemory({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nus-mem-')), 'memory.json'), now: () => t });
  assert.equal(m.correctLast("Sorry, it's room 212").ok, false, 'nothing saved yet');
  m.add('note', 'my dorm is Clark Hall, room 211');
  assert.equal(m.correctLast("Sorry, it's room 212").ok, false, 'an old fact is not the one just saved');
  m.remember('Remember my dorm is Clark Hall, room 211', 'my dorm is Clark Hall, room 211');
  for (const said of ["It's fine, no.", "It's okay.", 'No, it is fine', 'Actually, open Word', 'Wait, what is the Nyquist rate?', 'Sorry', 'No', 'Open room 212', 'Where is my dorm', 'Thanks', "It's raining outside", 'No, close the window']) {
    assert.equal(m.correctLast(said).ok, false, said);
  }
  assert.equal(m.facts[0].value, 'my dorm is Clark Hall, room 211');
  const r = m.correctLast('Sorry, it is 4111 1111 1111 1111');
  assert.equal(r.ok, false);
  assert.match(r.say, /will not keep/, 'a card number is refused here too');
  assert.equal(m.facts[0].value, 'my dorm is Clark Hall, room 211');
});

test('the new words go where they belong', () => {
  const fix = M.applyCorrection;
  assert.equal(fix('my dorm is Clark Hall, room 211', 'room 212'), 'my dorm is Clark Hall, room 212');
  assert.equal(fix('my dorm is Clark Hall, room 211', '212'), 'my dorm is Clark Hall, room 212');
  assert.equal(fix('my dorm is Clark Hall, room 211', 'Baker Hall,'), 'my dorm is Baker Hall, room 211');
  assert.equal(fix('my dorm is Clark Hall, room 211', 'Baker Hall, room 5'), 'my dorm is Baker Hall, room 5');
  assert.equal(fix('I take CS 2110 with Professor Lee', 'Professor Kim'), 'I take CS 2110 with Professor Kim');
  assert.equal(fix('I take CS 2110 with Professor Lee', 'CS 2120'), 'I take CS 2120 with Professor Lee');
  assert.equal(fix('my favourite colour is blue', 'green'), 'my favourite colour is green');
  assert.equal(fix('my favourite colour is blue', 'green', { marked: false }), null, 'not plainly a correction, and no word to line up on');
  assert.equal(fix('call mom on sunday', 'dad'), null, 'no telling where it goes');
  assert.deepEqual(M.parseCorrection("Sorry, it's room 212."), { words: 'room 212', marked: true, named: true });
  assert.deepEqual(M.parseCorrection('I meant Baker Hall'), { words: 'Baker Hall', marked: false, named: true });
  assert.equal(M.parseCorrection('room 212'), null, 'bare words are no correction');
});

test('a correction is heard ahead of the reflex layer and answered in words', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const route = main.slice(main.indexOf('async function routeUtterance('), main.indexOf('function routeUtteranceSlow('));
  assert.ok(route.indexOf('getMemory().correctLast(text)') > 0 && route.indexOf('getMemory().correctLast(text)') < route.indexOf('getReflex()'));
  assert.match(route, /if \(c && c\.say\) \{ sayShort\(c\.say, source, heardAt, 'memory correction'\); return; \}/);
});
