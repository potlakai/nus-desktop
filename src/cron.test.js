'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parse, parseField, nextAfter, nextRunIso, isDue, describe, CronError, FIELDS } = require('../src/cron');
const field = (k) => FIELDS.find((f) => f.key === k);

// A local-time date, so these assertions mean the same thing in any timezone.
const at = (y, m, d, h = 0, min = 0, s = 0) => new Date(y, m - 1, d, h, min, s, 0);
const iso = (d) => d && d.toISOString();

test('fields: numbers, ranges, steps, lists, names, and the 0-7 weekday range', () => {
  assert.deepEqual(parseField('5', { min: 0, max: 59, label: 'minute' }), [5]);
  assert.deepEqual(parseField('1-3', { min: 0, max: 59, label: 'minute' }), [1, 2, 3]);
  assert.deepEqual(parseField('*/15', { min: 0, max: 59, label: 'minute' }), [0, 15, 30, 45]);
  assert.deepEqual(parseField('1,15,30', { min: 0, max: 59, label: 'minute' }), [1, 15, 30]);
  assert.deepEqual(parseField('*', { min: 0, max: 23, label: 'hour' }).length, 24);
  assert.deepEqual(parseField('mon-fri', field('dow')), [1, 2, 3, 4, 5], 'weekday names are 0-based');
  assert.deepEqual(parseField('sun', field('dow')), [0]);
  assert.deepEqual(parseField('jan,dec', field('month')), [1, 12], 'month names are 1-based');
  // 7 and 0 are both Sunday.
  assert.deepEqual(parse('0 9 * * 7').dows, [0]);
  assert.deepEqual(parse('0 9 * * 0').dows, [0]);
});

test('a bad expression says which field is wrong and what to write instead', () => {
  const bad = (expr, pattern, field) => {
    assert.throws(() => parse(expr), (e) => {
      assert.ok(e instanceof CronError, expr);
      assert.match(e.message, pattern, expr);
      if (field) assert.equal(e.field, field, expr);
      return true;
    });
  };
  bad('', /schedule is empty/);
  bad('0 9 * *', /five fields.*has 4.*Example: 0 9 \* \* 1-5/, null);
  bad('0 9 * * 1 2026', /has 6/);
  bad('61 * * * *', /minute must be 0 to 59, not 61/, 'minute');
  bad('* 24 * * *', /hour must be 0 to 23/, 'hour');
  bad('* * 0 * *', /day of the month must be 1 to 31, not 0/, 'dom');
  bad('* * * 13 *', /month must be 1 to 12/, 'month');
  bad('* * * * 8', /day of the week must be 0 to 7/, 'dow');
  bad('* * * * funday', /is not a number or a name for the day of the week/);
  bad('*/0 * * * *', /step must be at least 1/);
  bad('5-1 * * * *', /runs backwards/);
  bad('1,,2 * * * *', /empty item/);
});

test('the next run is the next whole minute that matches, never the one just gone', () => {
  assert.equal(iso(nextAfter('0 9 * * *', at(2026, 3, 2, 8, 30))), iso(at(2026, 3, 2, 9, 0)));
  // Already past nine today: tomorrow.
  assert.equal(iso(nextAfter('0 9 * * *', at(2026, 3, 2, 9, 0, 1))), iso(at(2026, 3, 3, 9, 0)));
  // Exactly on the minute counts (the tick runs within the minute).
  assert.equal(iso(nextAfter('0 9 * * *', at(2026, 3, 2, 9, 0, 0))), iso(at(2026, 3, 2, 9, 0)));
  // Seconds are dropped, not rounded up past the schedule.
  assert.equal(iso(nextAfter('30 9 * * *', at(2026, 3, 2, 9, 0, 30))), iso(at(2026, 3, 2, 9, 30)));
});

test('weekdays pick the right days, and a Friday evening lands on Monday', () => {
  // 2026-03-02 is a Monday.
  assert.equal(at(2026, 3, 2).getDay(), 1);
  assert.equal(iso(nextAfter('0 9 * * 1-5', at(2026, 3, 6, 18, 0))), iso(at(2026, 3, 9, 9, 0)), 'Friday evening -> Monday');
  assert.equal(iso(nextAfter('0 9 * * mon', at(2026, 3, 2, 10, 0))), iso(at(2026, 3, 9, 9, 0)));
  assert.equal(iso(nextAfter('0 9 * * 0', at(2026, 3, 2, 10, 0))), iso(at(2026, 3, 8, 9, 0)), 'Sunday next');
});

test('both day fields restricted means either matches, as cron has always done', () => {
  // The 1st of the month OR any Monday.
  const expr = '0 9 1 * 1';
  assert.equal(iso(nextAfter(expr, at(2026, 3, 2, 10, 0))), iso(at(2026, 3, 9, 9, 0)), 'a Monday');
  assert.equal(iso(nextAfter(expr, at(2026, 3, 25, 10, 0))), iso(at(2026, 3, 30, 9, 0)), 'Monday the 30th still wins first');
  assert.equal(iso(nextAfter(expr, at(2026, 4, 1, 8, 0))), iso(at(2026, 4, 1, 9, 0)), 'the 1st');
  // Only one restricted: that one decides.
  assert.equal(iso(nextAfter('0 9 1 * *', at(2026, 3, 2, 10, 0))), iso(at(2026, 4, 1, 9, 0)));
  assert.equal(iso(nextAfter('0 9 * * 1', at(2026, 3, 2, 10, 0))), iso(at(2026, 3, 9, 9, 0)));
});

test('months and stepped hours stay inside the schedule', () => {
  assert.equal(iso(nextAfter('0 0 1 1 *', at(2026, 6, 1))), iso(at(2027, 1, 1, 0, 0)));
  assert.equal(iso(nextAfter('0 0 1 jan *', at(2026, 6, 1))), iso(at(2027, 1, 1, 0, 0)));
  // Every 6 hours from midnight.
  const every6 = '0 */6 * * *';
  assert.equal(iso(nextAfter(every6, at(2026, 3, 2, 7, 0))), iso(at(2026, 3, 2, 12, 0)));
  assert.equal(iso(nextAfter(every6, at(2026, 3, 2, 19, 0))), iso(at(2026, 3, 3, 0, 0)));
  // Every 15 minutes.
  assert.equal(iso(nextAfter('*/15 * * * *', at(2026, 3, 2, 10, 7))), iso(at(2026, 3, 2, 10, 15)));
});

test('a schedule that can never happen returns null instead of looping for ever', () => {
  assert.equal(nextAfter('0 0 31 2 *', at(2026, 1, 1)), null);
  assert.equal(nextRunIso('0 0 30 2 *', at(2026, 1, 1)), null);
});

test('isDue is true only in the minute it names, so a double tick runs nothing twice', () => {
  assert.equal(isDue('0 9 * * *', at(2026, 3, 2, 9, 0, 0)), true);
  assert.equal(isDue('0 9 * * *', at(2026, 3, 2, 9, 0, 45)), true, 'any second of that minute');
  assert.equal(isDue('0 9 * * *', at(2026, 3, 2, 9, 1, 0)), false);
  assert.equal(isDue('0 9 * * *', at(2026, 3, 2, 8, 59, 59)), false);
  assert.equal(isDue('*/15 * * * *', at(2026, 3, 2, 10, 45)), true);
});

test('nextRunIso is what the row stores: an ISO string, or null', () => {
  const isoStr = nextRunIso('0 9 * * *', at(2026, 3, 2, 8, 0));
  assert.equal(typeof isoStr, 'string');
  assert.equal(isoStr, at(2026, 3, 2, 9, 0).toISOString());
});

test('describe is a sentence for the person, not the expression again', () => {
  assert.equal(describe('0 9 * * 1-5'), 'At 09:00, on mon, tue, wed, thu, fri.');
  assert.equal(describe('30 18 * * *'), 'At 18:30, every day.');
  assert.equal(describe('0 0 1 * *'), 'At 00:00, on day 1 of the month.');
  assert.match(describe('*/15 * * * *'), /^At minute 0, 15, 30, 45 of hour/);
});

test('a parsed expression can be reused, so a tick does not re-parse per row', () => {
  const spec = parse('0 9 * * 1');
  assert.equal(iso(nextAfter(spec, at(2026, 3, 2, 10, 0))), iso(at(2026, 3, 9, 9, 0)));
  assert.equal(isDue(spec, at(2026, 3, 9, 9, 0)), true);
  assert.equal(describe(spec), 'At 09:00, on mon.');
});
