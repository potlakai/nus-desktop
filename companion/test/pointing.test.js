const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPointRequest, parsePointReply, validatePoint, SYSTEM } = require('../src/guide/pointing');

const elements = [
  { id: 1, type: 'Button', name: 'Submit Assignment', box: [0.8, 0.9, 0.1, 0.03] },
  { id: 2, type: 'Edit', name: 'Password', box: [0.4, 0.5, 0.2, 0.03] },
];

test('the prompt carries the goal, the front window, history, and numbered controls', () => {
  const r = buildPointRequest({ task: 'submit my essay', history: [{ instruction: 'Open Assignments', outcome: 'clicked' }], window: { title: 'Canvas', process: 'chrome' }, elements });
  assert.equal(r.system, SYSTEM);
  assert.match(r.text, /Goal: submit my essay/);
  assert.match(r.text, /Front window: Canvas \(chrome\)/);
  assert.match(r.text, /1\. Open Assignments \(clicked\)/);
  assert.match(r.text, /1 \| Button \| "Submit Assignment" \| 0\.800,0\.900,0\.100,0\.030/);
  assert.match(SYSTEM, /Never point at a password/);
  assert.match(SYSTEM, /irreversible/);
  assert.match(SYSTEM, /Never say "I can see"/);
});

test('replies parse through fences and chatter', () => {
  assert.deepEqual(parsePointReply('```json\n{"instruction":"Click Submit","target":null,"confidence":0.9,"done":false}\n```').instruction, 'Click Submit');
  assert.equal(parsePointReply('Sure! {"instruction":"x","target":null} thanks').instruction, 'x');
  assert.equal(parsePointReply('nothing here'), null);
  assert.equal(parsePointReply(null), null);
});

test('an element id from the list is the preferred, verified target', () => {
  const v = validatePoint({ instruction: 'Click Submit Assignment. This sends it.', target: { kind: 'element', id: 1 }, confidence: 0.86, done: false }, elements);
  assert.equal(v.ok, true);
  assert.deepEqual(v.reply.target, { kind: 'element', id: 1, name: 'Submit Assignment', type: 'Button' });
});

test('unknown ids, low confidence, oversized or out-of-range boxes are rejected', () => {
  assert.equal(validatePoint({ instruction: 'x', target: { kind: 'element', id: 9 }, confidence: 0.9 }, elements).ok, false);
  assert.equal(validatePoint({ instruction: 'x', target: { kind: 'element', id: 1 }, confidence: 0.3 }, elements).reason, 'low confidence');
  assert.equal(validatePoint({ instruction: 'x', target: { kind: 'bbox', x: 0.1, y: 0.1, w: 0.6, h: 0.6 }, confidence: 0.9 }, elements).reason, 'bbox too large');
  assert.equal(validatePoint({ instruction: 'x', target: { kind: 'bbox', x: 0.9, y: 0.1, w: 0.3, h: 0.1 }, confidence: 0.9 }, elements).reason, 'bbox out of range');
  assert.equal(validatePoint({ instruction: 'x', target: { kind: 'bbox', x: 0.1, y: 0.1, w: 0.1, h: 0.1, label: 'Save' }, confidence: 0.65 }, elements, { verified: false }).reason, 'low confidence', 'model-only pointing needs more confidence');
  assert.equal(validatePoint({ instruction: 'x', target: { kind: 'bbox', x: 0.1, y: 0.1, w: 0.1, h: 0.1, label: 'Save' }, confidence: 0.65 }, elements).ok, true);
  assert.equal(validatePoint({ instruction: '', target: null }, elements).ok, false);
  assert.equal(validatePoint(null, elements).ok, false);
});

test('a null target with done or a note is a valid non-pointing reply', () => {
  const v = validatePoint({ instruction: 'All set.', target: null, confidence: 0.9, done: true }, elements);
  assert.equal(v.ok, true);
  assert.equal(v.reply.done, true);
  assert.equal(v.reply.target, null);
  const w = validatePoint({ instruction: 'Open Canvas first.', target: null, note: 'The front window is a browser on another site.' }, elements);
  assert.equal(w.ok, true);
  assert.equal(w.reply.note, 'The front window is a browser on another site.');
});
