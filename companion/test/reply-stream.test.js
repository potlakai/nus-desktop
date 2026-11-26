'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ReplyStream, parseReply } = require('../src/guide/reply-stream');

function feedAll(rs, text, size = 7) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(...rs.feed(text.slice(i, i + size)));
  out.push(...rs.end());
  return out;
}

test('sentences are released as they complete, before the tags arrive', () => {
  const rs = new ReplyStream();
  const first = rs.feed('Click the Insert tab at the top of the window. Then we');
  assert.deepEqual(first, [{ type: 'speech', text: 'Click the Insert tab at the top of the window.' }]);
  const more = rs.feed(' will pick a table.\n[POINT:12] [CONF:0.9]');
  assert.deepEqual(more.map((e) => e.type), ['speech', 'point', 'conf']);
  assert.equal(more[0].text, 'Then we will pick a table.');
  assert.deepEqual(rs.end(), []);
  assert.deepEqual(rs.reply(), { instruction: 'Click the Insert tab at the top of the window. Then we will pick a table.', target: { kind: 'element', id: 12 }, confidence: 0.9, done: false, note: '', next: [] });
});

test('short sentences merge with the next one; the tail is released at the end', () => {
  const rs = new ReplyStream();
  const ev = feedAll(rs, 'Click the Insert tab at the top of the window. Almost there. Now press the blue Save button near the bottom right');
  assert.deepEqual(ev, [
    { type: 'speech', text: 'Click the Insert tab at the top of the window.' },
    { type: 'speech', text: 'Almost there. Now press the blue Save button near the bottom right' },
  ]);
});

test('the first sentence is spoken the moment it completes, however short (2026-10-30)', () => {
  // The answer prompt asks for a five-word opener so the first word is heard
  // at once; it used to wait for sentence two to finish.
  const rs = new ReplyStream();
  const first = rs.feed('Paris. The capital since');
  assert.deepEqual(first, [{ type: 'speech', text: 'Paris.' }]);
  assert.deepEqual(rs.feed(' the tenth century, on the Seine.'), [], 'a sentence with nothing after its full stop waits for the end');
  assert.deepEqual(rs.end(), [{ type: 'speech', text: 'The capital since the tenth century, on the Seine.' }]);
  // Hands style: a short opener then the tag.
  const h = new ReplyStream();
  assert.deepEqual(h.feed('Opening Gmail. '), [{ type: 'speech', text: 'Opening Gmail.' }]);
  assert.deepEqual(h.feed('[POINT:none]').map((e) => e.type), ['point']);
  // A one-letter fragment ("A.") is not a sentence worth a voice line on its own.
  const t = new ReplyStream();
  assert.deepEqual(feedAll(t, 'A. Second sentence follows here now.'), [{ type: 'speech', text: 'A. Second sentence follows here now.' }]);
});

test('every tag form parses, and tags never reach the spoken text', () => {
  const box = parseReply('Click Export on the toolbar.\n[POINT:0.12,0.05,0.08,0.03:Export] [CONF:0.7] [NOTE:This starts the export.] [NEXT:Pick a folder (Browse) | Press OK (OK)]');
  assert.deepEqual(box.spoken, ['Click Export on the toolbar.']);
  assert.deepEqual(box.reply.target, { kind: 'bbox', x: 0.12, y: 0.05, w: 0.08, h: 0.03, label: 'Export' });
  assert.equal(box.reply.confidence, 0.7);
  assert.equal(box.reply.note, 'This starts the export.');
  assert.deepEqual(box.reply.next, [{ instruction: 'Pick a folder', control: 'Browse' }, { instruction: 'Press OK', control: 'OK' }]);
  const none = parseReply('Open Word first, this is the browser. [POINT:none] [CONF:0.8]');
  assert.equal(none.reply.target, null); assert.equal(none.reply.instruction, 'Open Word first, this is the browser.');
  const done = parseReply('That is the table in place. [DONE]');
  assert.equal(done.reply.done, true); assert.equal(done.reply.target, null);
  const onlyTag = parseReply('[POINT:3]');
  assert.equal(onlyTag.reply.instruction, ''); assert.deepEqual(onlyTag.reply.target, { kind: 'element', id: 3 });
  assert.equal(onlyTag.reply.confidence, 0.75, 'a point without CONF is a moderate guess');
});

test('malformed tags are dropped, brackets that are not tags are spoken, thinking is skipped', () => {
  const r = parseReply('<thinking>where is it</thinking>Press [Ctrl+S] to save. [POINT:abc] [POINT:1,2] [CONF:x] [POINT:4]');
  assert.deepEqual(r.spoken, ['Press [Ctrl+S] to save.']);
  assert.deepEqual(r.reply.target, { kind: 'element', id: 4 });
  assert.equal(r.reply.confidence, 0.75);
  const dangling = parseReply('Click Save [POINT:');
  assert.equal(dangling.reply.instruction, 'Click Save');
  assert.equal(dangling.reply.target, null);
});

test('tool-call markup written as text mutes everything after it', () => {
  const r = parseReply('Click File. <function_calls><invoke name="Read">secret</invoke> and then Save. [POINT:9]');
  assert.deepEqual(r.spoken, ['Click File.']);
  assert.equal(r.muted, true);
  assert.equal(r.reply.target, null);
});

test('an empty or tagless reply gives null or a bare instruction', () => {
  assert.equal(parseReply('').reply, null);
  assert.equal(parseReply('   ').reply, null);
  const prose = parseReply('I cannot tell from this screen.');
  assert.equal(prose.reply.instruction, 'I cannot tell from this screen.');
  assert.equal(prose.reply.target, null);
});
