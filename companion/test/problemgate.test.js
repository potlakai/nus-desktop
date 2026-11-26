const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../src/guide/problemgate');

test('the screen question carries the previous problem and the OCR words, clipped', () => {
  const { state, questions } = G.buildScreenQuestions({ previousProblem: 'Question 3: block on an incline', previousAnswer: '4.9 m/s^2', text: 'x'.repeat(5000) });
  assert.equal(state.previous_problem, 'Question 3: block on an incline');
  assert.equal(state.previous_answer, '4.9 m/s^2');
  assert.equal(state.screen_text.length, 1800);
  assert.equal(questions.screen.type, 'choice');
  assert.deepEqual(Object.keys(questions.screen.criteria), ['same', 'different', 'none']);
  assert.equal(questions.has_problem.type, 'noul');
  assert.equal(G.buildScreenQuestions({ text: 'a' }).state.previous_problem, '(none yet)');
});

test('only a confident same or none stops the model; different and unsure go through', () => {
  assert.equal(G.judge({ screen: { choice: 'same', probabilities: { same: 0.9, different: 0.05, none: 0.05 } } }).verdict, 'same');
  assert.equal(G.judge({ screen: { choice: 'same', probabilities: { same: 0.55, different: 0.4, none: 0.05 } } }).verdict, 'unsure');
  assert.equal(G.judge({ screen: { choice: 'none', confidence: 0.9 }, has_problem: { noul: 0.1 } }).verdict, 'none');
  assert.equal(G.judge({ screen: { choice: 'none', confidence: 0.9 }, has_problem: { noul: 0.8 } }).verdict, 'unsure', 'none but a problem is there: let the model look');
  assert.equal(G.judge({ screen: { choice: 'different', probabilities: { different: 0.5 } } }).verdict, 'different');
  assert.equal(G.judge(null).verdict, 'unsure');
});

test('the gate has no opinion without a key, on a failure, or past its deadline', async () => {
  const off = G.createProblemGate({ client: { ready: () => false, systemOne: async () => { throw new Error('never'); } } });
  assert.equal(off.enabled(), false);
  assert.equal(await off.judge({ text: 'x' }), null);
  const failing = G.createProblemGate({ client: { ready: () => true, systemOne: async () => { throw new Error('jev 500'); } } });
  assert.equal(await failing.judge({ text: 'x' }), null);
  const ok = G.createProblemGate({ client: { ready: () => true, systemOne: async () => ({ answers: { screen: { choice: 'same', probabilities: { same: 0.95 } } }, ms: 210 }) } });
  const j = await ok.judge({ previousProblem: 'p', text: 'p again' });
  assert.equal(j.verdict, 'same');
  assert.equal(j.ms, 210);
});
