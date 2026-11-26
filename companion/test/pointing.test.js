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

test('the spoken-sentence-plus-tags reply is the contract the prompt asks for, and it validates like JSON did', () => {
  assert.match(SYSTEM, /\[POINT:<id>\]/);
  assert.match(SYSTEM, /\[POINT:none\]/);
  assert.match(SYSTEM, /No code fences, no JSON/);
  const r = parsePointReply('Click Submit Assignment. This sends it.\n[POINT:1] [CONF:0.86]');
  assert.deepEqual(r, { instruction: 'Click Submit Assignment. This sends it.', target: { kind: 'element', id: 1 }, confidence: 0.86, done: false, note: '', next: [] });
  const v = validatePoint(r, elements);
  assert.equal(v.ok, true);
  assert.deepEqual(v.reply.target, { kind: 'element', id: 1, name: 'Submit Assignment', type: 'Button' });
  const box = parsePointReply('Press the Export button on the toolbar.\n[POINT:0.12,0.05,0.08,0.03:Export] [CONF:0.7]');
  assert.equal(validatePoint(box, elements).reply.target.kind, 'bbox');
  const none = parsePointReply('Open Word first, this is a browser window. [POINT:none] [CONF:0.8] [NOTE:The front window is Chrome.]');
  const vn = validatePoint(none, elements);
  assert.equal(vn.ok, true); assert.equal(vn.reply.target, null); assert.match(vn.reply.note, /Chrome/);
  const done = parsePointReply('That is the table in place. [DONE]');
  assert.equal(validatePoint(done, elements).reply.done, true);
  const plan = parsePointReply('Click Insert. [POINT:1] [CONF:0.9] [NEXT:Pick Table (Table) | Choose a size (grid)]');
  assert.deepEqual(validatePoint(plan, elements).reply.next, [{ instruction: 'Pick Table', control: 'Table' }, { instruction: 'Choose a size', control: 'grid' }]);
});

test('an element id from the list is the preferred, verified target', () => {
  const v = validatePoint({ instruction: 'Click Submit Assignment. This sends it.', target: { kind: 'element', id: 1 }, confidence: 0.86, done: false }, elements);
  assert.equal(v.ok, true);
  assert.deepEqual(v.reply.target, { kind: 'element', id: 1, name: 'Submit Assignment', type: 'Button' });
});

test('unknown ids, low confidence, oversized or out-of-range boxes are rejected', () => {
  assert.equal(validatePoint({ instruction: 'x', target: { kind: 'element', id: 9 }, confidence: 0.9 }, elements).ok, false);
  assert.equal(validatePoint({ instruction: 'x', target: { kind: 'element', id: 1 }, confidence: 0.2 }, elements).reason, 'low confidence');
  assert.equal(validatePoint({ instruction: 'x', target: { kind: 'element', id: 1 }, confidence: 0.35 }, elements).ok, true, 'a hedged pick from the Windows list is pointed at (labelled a guess), 2026-09-15');
  assert.equal(validatePoint({ instruction: 'x', target: { kind: 'bbox', x: 0.1, y: 0.1, w: 0.6, h: 0.6 }, confidence: 0.9 }, elements).reason, 'bbox too large');
  assert.equal(validatePoint({ instruction: 'x', target: { kind: 'bbox', x: 0.9, y: 0.1, w: 0.3, h: 0.1 }, confidence: 0.9 }, elements).reason, 'bbox out of range');
  assert.equal(validatePoint({ instruction: 'x', target: { kind: 'bbox', x: 0.1, y: 0.1, w: 0.1, h: 0.1, label: 'Save' }, confidence: 0.45 }, elements, { verified: false }).reason, 'low confidence', 'model-only pointing needs more confidence');
  assert.equal(validatePoint({ instruction: 'x', target: { kind: 'bbox', x: 0.1, y: 0.1, w: 0.1, h: 0.1, label: 'Save' }, confidence: 0.65 }, elements).ok, true);
  assert.equal(validatePoint({ instruction: '', target: null }, elements).ok, false);
  assert.equal(validatePoint(null, elements).ok, false);
});

test('the optional plan: off by default, never a reason to reject, and junk is dropped', () => {
  const { PLAN_RULE } = require('../src/guide/pointing');
  const input = { task: 'submit my essay', history: [], window: { title: 'Canvas', process: 'chrome' }, elements };
  assert.equal(buildPointRequest(input).system, SYSTEM, 'the prompt is untouched unless the plan is asked for');
  const withPlan = buildPointRequest(Object.assign({ plan: true }, input));
  assert.equal(withPlan.system, SYSTEM + '\n' + PLAN_RULE);
  assert.equal(withPlan.text, buildPointRequest(input).text, 'the user turn is the same either way');

  const base = { instruction: 'Click Submit Assignment. This sends it.', target: { kind: 'element', id: 1 }, confidence: 0.9 };
  assert.deepEqual(validatePoint(base, elements).reply.next, []);
  const good = validatePoint(Object.assign({ next: [{ instruction: 'Confirm', control: 'OK' }, { instruction: 'a' }, { control: 'b' }, { instruction: 'fourth', control: 'x' }] }, base), elements);
  assert.equal(good.ok, true);
  assert.equal(good.reply.next.length, 3, 'at most three');
  assert.deepEqual(good.reply.next[0], { instruction: 'Confirm', control: 'OK' });
  for (const junk of ['soon', 42, { instruction: 'x' }, [null, 7, 'x', {}, []]]) {
    const v = validatePoint(Object.assign({ next: junk }, base), elements);
    assert.equal(v.ok, true);
    assert.deepEqual(v.reply.next, []);
    assert.deepEqual(v.reply.target, good.reply.target, 'the pick itself is never affected');
  }
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

test('a bbox in image pixels is converted with the image size, and still checked', () => {
  const img = { width: 1568, height: 882 };
  // Word's Insert tab, answered in pixels (live 2026-10-22).
  const v = validatePoint({ instruction: 'Click Insert.', target: { kind: 'bbox', x: 113, y: 51, w: 30, h: 15, label: 'Insert' }, confidence: 0.9 }, [], { image: img });
  assert.equal(v.ok, true);
  assert.equal(v.reason, 'bbox (pixels converted)');
  assert.ok(Math.abs(v.reply.target.x - 113 / 1568) < 1e-9 && Math.abs(v.reply.target.h - 15 / 882) < 1e-9);
  // Without the image size it is still out of range, as before.
  assert.equal(validatePoint({ instruction: 'x', target: { kind: 'bbox', x: 113, y: 51, w: 30, h: 15 }, confidence: 0.9 }, []).reason, 'bbox out of range');
  // Pixels that land off the image are still refused.
  assert.equal(validatePoint({ instruction: 'x', target: { kind: 'bbox', x: 1700, y: 51, w: 30, h: 15 }, confidence: 0.9 }, [], { image: img }).reason, 'bbox out of range');
  // Fractions are untouched.
  assert.equal(validatePoint({ instruction: 'x', target: { kind: 'bbox', x: 0.1, y: 0.1, w: 0.1, h: 0.1 }, confidence: 0.9 }, [], { image: img }).reason, 'bbox');
});
