// My Nus (plan 2026-11-06, section 5): numbers about the person, worked out on
// this computer from the local record.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { summary, workdayStreak, milestoneAt, MINUTES_BY_HAND } = require('../src/my-nus');

const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h).getTime();
const NOW = at(2026, 11, 12, 15); // Thursday 12 Nov 2026, 3 PM

test('an empty record is an honest zero, everything still locked', () => {
  const s = summary({ record: {}, now: NOW });
  assert.equal(s.thingsDone, 0);
  assert.equal(s.minutesBack, 0);
  assert.equal(s.streak.days, 0);
  assert.equal(s.week.length, 7);
  assert.deepEqual(s.week.map((d) => d.day), ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
  assert.equal(s.week.filter((d) => d.today).length, 1);
  assert.ok(s.unlocks.every((u) => !u.unlocked));
  assert.equal(s.busiestHour, null);
  assert.equal(s.nextMilestone, 1);
});

test('things done, top uses, an estimate of minutes back, feeds blocked this week', () => {
  const record = {
    days: ['2026-11-09', '2026-11-10', '2026-11-12'], firstDay: '2026-11-09',
    wins: { guide: 6, reminder: 2, rewrite: 3, greeting: 4 }, winsTotal: 11,
    winsByDay: { '2026-11-09': 4, '2026-11-10': 3, '2026-11-12': 4, '2026-11-02': 9 },
    blockedByDay: { '2026-11-10': 5, '2026-11-03': 2 }, blockedTotal: 7,
  };
  const s = summary({ record, now: NOW, kept: { memories: 4, projects: 1 } });
  assert.equal(s.thingsDone, 11);
  assert.deepEqual(s.topUses.map((u) => u.feature), ['guide', 'rewrite', 'reminder'], 'a greeting is never a use');
  assert.equal(s.minutesBack, Math.round(6 * MINUTES_BY_HAND.guide + 2 * MINUTES_BY_HAND.reminder + 3 * MINUTES_BY_HAND.rewrite));
  assert.equal(s.minutesBackIsEstimate, true);
  assert.equal(s.weekDone, 11, 'Monday to today only');
  assert.equal(s.weekBlocked, 5);
  assert.equal(s.feedsBlocked, 7);
  assert.deepEqual(s.week.map((d) => d.used), [true, true, false, true, false, false, false]);
  assert.equal(s.daysSinceFirst, 3);
  assert.equal(s.kept.memories, 4);
  assert.equal(s.kept.routines, 0);
  assert.equal(s.nextMilestone, 50);
});

test('the busiest hour unlocks after 5 days used; the best day after 7; a week compare after 10', () => {
  const days = Array.from({ length: 6 }, (_, i) => '2026-11-0' + (i + 1));
  const s = summary({ record: { days, winsByHour: { 9: 2, 15: 7, 21: 1 }, winsByDay: { '2026-11-02': 5, '2026-11-03': 1 } }, now: NOW });
  assert.equal(s.busiestHour, '3 PM');
  assert.equal(s.bestDay, null);
  assert.equal(s.unlocks.find((u) => u.key === 'best_day').daysLeft, 1);
  assert.equal(s.weekCompare, null);
});

test('workday streak: weekends never break it, today not used yet never breaks it', () => {
  // Thu 12 Nov, not used yet today. Used Mon-Wed, and Thu-Fri of the week before.
  const days = ['2026-11-05', '2026-11-06', '2026-11-09', '2026-11-10', '2026-11-11'];
  assert.equal(workdayStreak(days, NOW).days, 5);
  assert.equal(workdayStreak(days.concat('2026-11-12'), NOW).days, 6);
});

test('workday streak: one missed weekday is forgiven, a second ends it', () => {
  const days = ['2026-11-04', '2026-11-05', '2026-11-09', '2026-11-11', '2026-11-12'];
  // Thu 12, Wed 11, (Tue 10 missed, forgiven), Mon 9, (weekend), (Fri 6 missed) -> stop
  assert.deepEqual(workdayStreak(days, NOW), { days: 3, forgiven: 1 });
});

test('milestones', () => {
  assert.equal(milestoneAt(1), 1);
  assert.equal(milestoneAt(10), 10);
  assert.equal(milestoneAt(11), null);
  assert.equal(milestoneAt(100), 100);
});
