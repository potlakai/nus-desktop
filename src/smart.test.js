const test = require('node:test');
const assert = require('node:assert/strict');
const { decomposeTask, nextScheduledAt, parseIcs } = require('./smart');

test('decomposeTask creates concrete study steps', () => {
  const steps = decomposeTask({ title: 'Study for linear algebra midterm', estimated_minutes: 100 });
  assert.equal(steps.length, 5);
  assert.match(steps[1].title, /diagnostic/i);
  assert.equal(steps.reduce((sum, step) => sum + step.estimated_minutes, 0), 100);
});

test('nextScheduledAt advances weekly automations', () => {
  assert.equal(nextScheduledAt('weekly', new Date('2026-08-12T12:00:00.000Z')), '2026-08-19T12:00:00.000Z');
});

test('parseIcs reads basic calendar events', () => {
  const events = parseIcs('BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART:20260820T150000Z\nSUMMARY:Test review\nEND:VEVENT\nEND:VCALENDAR');
  assert.deepEqual(events, [{ title: 'Test review', due_date: '2026-08-20', notes: '' }]);
});

test('normalizeRecurrenceKey strips week/chapter numbers and has no stray $1', () => {
  const { normalizeRecurrenceKey } = require('./db');
  assert.equal(normalizeRecurrenceKey('Week 3 homework'), 'homework');
  assert.equal(normalizeRecurrenceKey('Chapter 5 reading'), 'reading');
  assert.equal(normalizeRecurrenceKey('Quiz 2 prep'), 'prep');
  assert.equal(normalizeRecurrenceKey('Assignment 1 draft'), 'draft');
  assert(!normalizeRecurrenceKey('Week 3 homework').includes('$'));
});
