// Retention loops (plan 2026-11-06): the start-with-Windows offer, the shared
// pop-up budget and quiet mode, the morning line, the check-in, the local record.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRetention, goalText, tomorrowAt, hello, DAY_MS } = require('../src/retention');

function rig(opts = {}) {
  const dir = opts.dir || fs.mkdtempSync(path.join(os.tmpdir(), 'nus-ret-'));
  const clock = { t: opts.t || new Date(2026, 10, 9, 10, 0, 0).getTime() }; // Mon 9 Nov 2026, 10:00 local
  const group = { g: opts.group || 'on' };
  const r = createRetention({ file: path.join(dir, 'retention.json'), now: () => clock.t, nudgeGroup: () => group.g });
  return { r, clock, group, dir, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const HOUR = 3600000;

test('start with Windows: offered after a win, never when already on, at most twice, never twice a day', () => {
  const { r, clock, done } = rig();
  assert.equal(r.autostartDue(true), false, 'already on');
  assert.equal(r.autostartDue(false), true);
  r.autostartOffered(); r.autostartAnswer('later');
  assert.equal(r.autostartDue(false), false, 'not again today');
  clock.t += DAY_MS;
  assert.equal(r.autostartDue(false), true, 'once more on a later day');
  r.autostartOffered(); r.autostartAnswer('later');
  clock.t += DAY_MS;
  assert.equal(r.autostartDue(false), false, 'twice is the most');
  done();
});

test('start with Windows: a yes or a no is final', () => {
  for (const answer of ['yes', 'no']) {
    const { r, clock, done } = rig();
    r.autostartOffered(); r.autostartAnswer(answer);
    clock.t += 3 * DAY_MS;
    assert.equal(r.autostartDue(false), false, answer);
    done();
  }
});

test('the budget: one pop-up a day, three in seven days', () => {
  const { r, clock, done } = rig();
  assert.equal(r.canPop('morning_line'), true);
  r.popped('morning_line');
  assert.equal(r.canPop('checkin'), false, 'one a day');
  for (let i = 0; i < 2; i++) { clock.t += DAY_MS; assert.equal(r.canPop('morning_line'), true); r.popped('morning_line'); }
  clock.t += DAY_MS;
  assert.equal(r.canPop('morning_line'), false, 'three this week already');
  clock.t += 4 * DAY_MS + HOUR;
  assert.equal(r.canPop('morning_line'), true, 'the week rolled on');
  done();
});

test('the holdout gets no proactive pop-ups, but its own reminders and the start-with-Windows offer still show', () => {
  const { r, done } = rig({ group: 'off' });
  assert.equal(r.canPop('morning_line'), false);
  assert.equal(r.canPop('checkin'), false);
  assert.equal(r.canPop('reminder_toast'), true);
  assert.equal(r.canPop('autostart_offer'), true);
  done();
});

test('exempt pop-ups do not spend the budget', () => {
  const { r, done } = rig();
  r.popped('reminder_toast'); r.popped('autostart_offer');
  assert.equal(r.canPop('morning_line'), true);
  done();
});

test('three ignored in a row: quiet, said once; calling the Knot ends it; a dismissal is not ignoring', () => {
  const { r, done } = rig();
  assert.deepEqual(r.outcome('morning_line', 'ignored'), { quiet: false });
  assert.deepEqual(r.outcome('morning_line', 'dismissed'), { quiet: false });
  assert.deepEqual(r.outcome('morning_line', 'ignored'), { quiet: false });
  assert.deepEqual(r.outcome('morning_line', 'ignored'), { quiet: false }, 'the dismissal reset the run');
  assert.deepEqual(r.outcome('morning_line', 'ignored'), { quiet: true });
  assert.equal(r.quiet(), true);
  assert.equal(r.canPop('morning_line'), false);
  r.noteEngaged();
  assert.equal(r.quiet(), false);
  assert.equal(r.canPop('morning_line'), true);
  done();
});

test('the morning line: a reminder due today first, else a project kept this week, else nothing; once a day', () => {
  const { r, clock, done } = rig();
  const at2 = new Date(2026, 10, 9, 14, 0, 0).getTime();
  const line = r.morningLine({ reminders: [{ at: at2, what: 'essay outline', kind: 'reminder' }], projects: [{ name: 'Essay draft', lastAt: clock.t - DAY_MS }] });
  assert.equal(line.kind, 'reminder');
  assert.equal(line.text, 'Morning. At 2 PM you have: essay outline.');
  const p = r.morningLine({ reminders: [], projects: [{ name: 'Essay draft', lastAt: clock.t - DAY_MS }, { name: 'Old thing', lastAt: clock.t - 9 * DAY_MS }] });
  assert.equal(p.kind, 'project');
  assert.equal(p.text, 'Morning. Pick up "Essay draft" where you left off?');
  assert.equal(r.morningLine({ reminders: [{ at: clock.t + 5 * 60000, what: 'tea', kind: 'timer' }], projects: [{ name: 'Old thing', lastAt: clock.t - 9 * DAY_MS }] }), null, 'timers and stale projects say nothing');
  r.morningShown();
  assert.equal(r.morningLine({ projects: [{ name: 'Essay draft', lastAt: clock.t }] }), null, 'once a day');
  clock.t += DAY_MS;
  assert.ok(r.morningLine({ projects: [{ name: 'Essay draft', lastAt: clock.t - HOUR }] }));
  done();
});

test('the greeting follows the clock', () => {
  assert.equal(hello(new Date(2026, 10, 9, 8).getTime()), 'Morning.');
  assert.equal(hello(new Date(2026, 10, 9, 13).getTime()), 'Afternoon.');
  assert.equal(hello(new Date(2026, 10, 9, 20).getTime()), 'Evening.');
});

test('the check-in: the person\'s own words back, tomorrow at 9, once', () => {
  const { r, done } = rig();
  const c = r.checkinOffer('I want to finish my history essay.');
  assert.equal(c.goal, 'finish my history essay');
  assert.equal(c.text, 'You said you want to get this done this week: finish my history essay. Want me to check in tomorrow at 9 AM?');
  assert.equal(new Date(c.at).getDate(), 10);
  assert.equal(new Date(c.at).getHours(), 9);
  r.checkinOffered('yes');
  assert.equal(r.checkinOffer('something else'), null, 'once');
  done();
});

test('no answer, no check-in; a long answer is cut on a word', () => {
  const { r, done } = rig();
  assert.equal(r.checkinOffer(''), null);
  assert.equal(r.checkinOffer('ok'), null);
  const long = goalText('finish the lab report for chemistry and then also start studying for the calculus midterm next friday');
  assert.ok(long.length <= 63 && long.endsWith('...'), long);
  done();
});

test('tomorrowAt crosses a month end', () => {
  const d = new Date(tomorrowAt(new Date(2026, 10, 30, 22).getTime()));
  assert.deepEqual([d.getMonth(), d.getDate(), d.getHours()], [11, 1, 9]);
});

test('the local record: one entry per day used, wins by feature and by day', () => {
  const { r, clock, done } = rig();
  r.noteEngaged(); r.noteEngaged();
  r.noteWin('guide'); r.noteWin('guide'); r.noteWin('reminder');
  clock.t += DAY_MS;
  r.noteEngaged(); r.noteWin('focus_guard');
  const rec = r.record();
  assert.deepEqual(rec.days, ['2026-11-09', '2026-11-10']);
  assert.equal(rec.firstDay, '2026-11-09');
  assert.deepEqual(rec.wins, { guide: 2, reminder: 1, focus_guard: 1 });
  assert.deepEqual(rec.winsByDay, { '2026-11-09': 3, '2026-11-10': 1 });
  assert.equal(rec.winsTotal, 4);
  done();
});

test('state survives a restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nus-ret-'));
  const a = rig({ dir });
  a.r.noteWin('hands'); a.r.autostartOffered(); a.r.autostartAnswer('no');
  const b = rig({ dir });
  assert.equal(b.r.record().winsTotal, 1);
  assert.equal(b.r.autostartDue(false), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
