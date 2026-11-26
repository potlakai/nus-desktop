const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../src/guide/solve');

test('the solve request carries the question, the cursor and the previous problem', () => {
  const req = S.buildSolveRequest({ question: 'why is step 2 like that?', previous: { problem: 'Problem 3: solve 2x + 6 = 0', steps: [{ title: 'Move the 6', body: 'Subtract 6 from both sides.' }], answer: 'x = -3' }, cursor: { x: 0.5, y: 0.25 }, window: { title: 'HW 4 - Chrome', process: 'chrome' }, auto: false });
  assert.match(req.system, /tutor/);
  assert.match(req.system, /JSON only/);
  assert.match(req.text, /Front window: HW 4 - Chrome \(chrome\)/);
  assert.match(req.text, /Cursor at x,y as fractions of the screen: 0\.500,0\.250/);
  assert.match(req.text, /Previous problem \(the one already walked through\): Problem 3/);
  assert.match(req.text, /1\. Move the 6: Subtract 6/);
  assert.match(req.text, /The student says: why is step 2 like that\?/);
});

test('a look nobody asked for says so, and leaves the old walkthrough out', () => {
  const req = S.buildSolveRequest({ previous: { problem: 'Problem 3', steps: [{ title: 'a', body: 'b' }], answer: '1' }, auto: true });
  assert.match(req.text, /did not ask anything/);
  assert.match(req.text, /set same true/);
  assert.doesNotMatch(req.text, /Its walkthrough so far/);
  assert.match(S.buildSolveRequest({ auto: false }).text, /Previous problem: \(none\)[\s\S]*Walk me through this problem\./);
});

test('a good reply is normalized: fences, long dashes, long bodies, too many steps', () => {
  const steps = Array.from({ length: 11 }, (_, i) => ({ title: 'Step ' + i, body: i === 0 ? 'x'.repeat(900) : 'Do the thing — carefully.' }));
  const raw = '```json\n' + JSON.stringify({ found: true, same: false, problem: 'Problem 4: integrate x^2', steps, answer: 'x^3/3 + C', check: 'Differentiated it back.', confidence: 0.9 }) + '\n```';
  const v = S.parseSolveReply(raw);
  assert.equal(v.ok, true);
  assert.equal(v.reply.steps.length, S.MAX_STEPS);
  assert.ok(v.reply.steps[0].body.length <= S.MAX_BODY);
  assert.equal(v.reply.steps[1].body, 'Do the thing , carefully.');
  assert.equal(v.reply.answer, 'x^3/3 + C');
  assert.equal(v.reply.confidence, 0.9);
});

test('steps may come back as plain strings or with "text"', () => {
  const v = S.parseSolveReply(JSON.stringify({ problem: 'p', steps: ['First do this.', { title: 'Then', text: 'Do that.' }], answer: '4' }));
  assert.equal(v.ok, true);
  assert.deepEqual(v.reply.steps, [{ title: '', body: 'First do this.' }, { title: 'Then', body: 'Do that.' }]);
});

test('nothing on screen, the same problem, and rubbish are told apart', () => {
  const none = S.parseSolveReply(JSON.stringify({ found: false, problem: 'a news page', steps: [{ title: 'x', body: 'y' }] }));
  assert.equal(none.ok, true);
  assert.equal(none.reply.found, false);
  assert.deepEqual(none.reply.steps, []);
  const same = S.parseSolveReply(JSON.stringify({ found: true, same: true, problem: 'Problem 3', steps: [] }));
  assert.equal(same.ok, true);
  assert.equal(same.reason, 'same problem');
  assert.equal(S.parseSolveReply('I could not view the screenshot.').ok, false);
  assert.equal(S.parseSolveReply(JSON.stringify({ found: true, problem: 'p', steps: [] })).ok, false);
  assert.equal(S.parseSolveReply(null).ok, false);
});

test('gray cells: a bubble-sized change is small, a new page is big', () => {
  const w = 48, h = 27;
  const frame = (fill, patch) => {
    const buf = Buffer.alloc(w * h * 4, fill);
    if (patch) for (let y = patch.y; y < patch.y + patch.h; y++) for (let x = patch.x; x < patch.x + patch.w; x++) buf.fill(patch.v, (y * w + x) * 4, (y * w + x) * 4 + 4);
    return S.grayCells(buf, w, h);
  };
  const page = frame(240);
  assert.equal(S.cellsChanged(page, frame(240)), 0);
  assert.equal(S.cellsChanged(page, frame(243)), 0, 'a few gray levels of noise is not a change');
  const bubble = S.cellsChanged(page, frame(240, { x: 38, y: 20, w: 8, h: 4, v: 20 }));
  assert.ok(bubble > 0 && bubble < 0.03, 'bubble = ' + bubble);
  assert.ok(S.cellsChanged(page, frame(240, { x: 4, y: 3, w: 36, h: 18, v: 200 })) > 0.4);
  assert.equal(S.cellsChanged(page, null), 1);
});

test('new words: a scroll keeps most of them, a new problem does not', () => {
  const chrome = 'Canvas Dashboard Courses Calendar Inbox Homework 4 Submit Save Previous Next ';
  const p1 = chrome + 'Question 3 A block of mass 2 kg slides down a frictionless incline of angle 30 degrees. Find the acceleration of the block along the incline.';
  const p1scrolled = chrome + 'slides down a frictionless incline of angle 30 degrees. Find the acceleration of the block along the incline. Enter your answer in m/s^2. Attempts remaining 3';
  const p2 = chrome + 'Question 4 A capacitor of 5 microfarads is charged through a 200 ohm resistor from a 12 volt battery. How long until it reaches half of its final voltage?';
  assert.ok(S.newTextFraction(p1, p1scrolled) < 0.35, 'scroll = ' + S.newTextFraction(p1, p1scrolled));
  assert.ok(S.newTextFraction(p1, p2) > 0.35, 'new = ' + S.newTextFraction(p1, p2));
  assert.equal(S.newTextFraction('', p1), 1);
  assert.equal(S.newTextFraction(p1, ''), 0);
});
