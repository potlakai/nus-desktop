const test = require('node:test');
const assert = require('node:assert/strict');
const { AskStream, parseAsk } = require('./ask-stream');

test('prose streams out as it arrives; the action tag is held back and parsed when it closes', () => {
  const s = new AskStream();
  let shown = '';
  for (const piece of ['Sure, I will add ', 'that for Friday. [DO:add_', 'task {"title": "Lab 3 [draft]", "due_date": "2026-10-16", "course": "CS 2110"}', ']']) shown += s.feed(piece);
  shown += s.end();
  assert.equal(shown, 'Sure, I will add that for Friday. ');
  assert.deepEqual(s.command(), { intent: 'add_task', args: { title: 'Lab 3 [draft]', due_date: '2026-10-16', course: 'CS 2110' } });
  assert.equal(s.prose(), 'Sure, I will add that for Friday.');
});

test('a reply with no tag is all prose, brackets included', () => {
  const r = parseAsk('Nothing is due today. Your next deadline is Quiz 2 [CS 2110] on Thursday.');
  assert.equal(r.command, null);
  assert.match(r.text, /\[CS 2110\]/);
});

test('a bare tag, a malformed tag and junk after the tag are handled quietly', () => {
  assert.deepEqual(parseAsk('Done. [DO:question]').command, { intent: 'question', args: {} });
  const bad = parseAsk('I will try. [DO:add_task {"title": "x" ] extra');
  assert.equal(bad.command, null);
  assert.equal(bad.text, 'I will try.');
  const after = parseAsk('Okay. [DO:add_event {"title": "Office hours", "time": "15:00"}] and then more words');
  assert.equal(after.command.intent, 'add_event');
  assert.equal(after.text, 'Okay.', 'nothing after the tag is shown');
  assert.equal(parseAsk('').command, null);
});

test('a lone bracket at the end of a chunk waits for the next chunk before being shown', () => {
  const s = new AskStream();
  assert.equal(s.feed('See the note ['), 'See the note ');
  assert.equal(s.feed('below].'), '[below].');
  assert.equal(s.end(), '');
  assert.equal(s.prose(), 'See the note [below].');
});
