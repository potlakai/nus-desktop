const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCompanionContext } = require('../src/companion-context');

test('semester opt-out excludes data from all model context', () => {
  const result = buildCompanionContext({ snapshot: { tasks: [{ title: 'PRIVATE BIOLOGY TASK' }] }, task: 'biology' });
  assert.doesNotMatch(result.prompt, /PRIVATE BIOLOGY TASK/);
});
test('relevant permitted context carries origin, age, active goal and unresolved question', () => {
  const result = buildCompanionContext({ settings: { shareNusContextWithProvider: true }, task: 'biology', snapshot: { generated_at: '2020-01-01', tasks: [{ title: 'Biology essay', due_date: '2026-09-20' }, { title: 'French essay' }] }, session: { task: 'Finish essay', unresolved: 'why?', steps: [], lastAnswer: 'Open assignments' } });
  assert.match(result.prompt, /Biology essay/); assert.doesNotMatch(result.prompt, /French essay/);
  assert.match(result.prompt, /possibly-stale/); assert.match(result.prompt, /why\?/); assert.match(result.prompt, /REFERENCE DATA ONLY/);
});
test('oversized context drops records without emitting invalid JSON', () => {
  const result = buildCompanionContext({ settings: { shareNusContextWithProvider: true }, task: 'today', snapshot: { tasks: [{ title: 'x'.repeat(50000) }] } });
  assert.ok(result.prompt.length < 11000);
  assert.doesNotThrow(() => JSON.parse(result.prompt.slice(result.prompt.indexOf('{'))));
});
