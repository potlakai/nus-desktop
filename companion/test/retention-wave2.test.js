// Retention wave 2 (plan 2026-11-06): milestones, the Monday Knot Report, the
// three win-back lines, the one question.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRetention, DAY_MS, EXEMPT, TIPS } = require('../src/retention');

function rig(t, group = 'on') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nus-ret2-'));
  const clock = { t };
  const r = createRetention({ file: path.join(dir, 'retention.json'), now: () => clock.t, nudgeGroup: () => group });
  return { r, clock, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const at = (y, m, d, h = 10) => new Date(y, m - 1, d, h).getTime();

test('milestones: 10, 50, 100... each once; the first is left to the start-with-Windows offer', () => {
  const { r, done } = rig(at(2026, 11, 9));
  let hit = [];
  for (let i = 0; i < 52; i++) { const total = r.noteWin('guide'); const m = r.milestone(total); if (m) { hit.push(m); r.milestoneShown(m); } }
  assert.deepEqual(hit, [10, 50]);
  assert.equal(r.milestone(10), null, 'never twice');
  assert.ok(EXEMPT.has('milestone'), 'a milestone answers what just happened: outside the budget');
  done();
});

test('the Monday report: Mondays only, once a week, about last week, skipped when last week was empty', () => {
  // last week: Mon 2 Nov to Sun 8 Nov 2026
  const { r, clock, done } = rig(at(2026, 11, 3));
  for (let i = 0; i < 5; i++) r.noteWin('guide');
  clock.t = at(2026, 11, 5); for (let i = 0; i < 2; i++) r.noteWin('rewrite'); r.noteBlocked(); r.noteBlocked();
  clock.t = at(2026, 11, 8); assert.equal(r.knotReport(), null, 'Sunday: not yet');
  clock.t = at(2026, 11, 9, 9);
  const rep = r.knotReport();
  assert.equal(rep.hook, 'knot_report');
  assert.match(rep.text, /^Last week: 7 things done, 2 feeds kept away/);
  assert.match(rep.text, /Best day: Tuesday\.$/);
  r.knotReportShown(rep.week);
  clock.t = at(2026, 11, 9, 15);
  assert.equal(r.knotReport(), null, 'once that Monday');
  clock.t = at(2026, 11, 16);
  assert.equal(r.knotReport(), null, 'nothing happened the week before: no report');
  done();
});

test('win-back: day 3 a tip for something not tried, day 7 the waiting project, day 30 a goodbye, then silence', () => {
  const { r, clock, done } = rig(at(2026, 11, 2));
  r.noteEngaged(); r.noteWin('focus_guard');
  clock.t = at(2026, 11, 4);
  assert.equal(r.winback(), null, 'two days is just life');
  clock.t = at(2026, 11, 5);
  const d3 = r.winback();
  assert.equal(d3.step, 'd3');
  assert.ok(d3.text.includes(TIPS.find(([f]) => f !== 'focus_guard')[1]), 'a tip for something not tried yet');
  r.winbackShown('d3');
  assert.equal(r.winback(), null, 'once');
  clock.t = at(2026, 11, 9);
  const d7 = r.winback({ projects: [{ id: 'p1', name: 'History essay', lastAt: at(2026, 11, 1) }] });
  assert.equal(d7.step, 'd7');
  assert.equal(d7.projectId, 'p1');
  assert.match(d7.text, /"History essay" is waiting/);
  r.winbackShown('d7');
  clock.t = at(2026, 12, 2);
  const d30 = r.winback();
  assert.equal(d30.step, 'd30');
  r.winbackShown('d30');
  clock.t = at(2027, 3, 1);
  assert.equal(r.winback(), null, 'three lines in a lifetime');
  done();
});

test('win-back stays quiet for someone who keeps using Nus', () => {
  const { r, clock, done } = rig(at(2026, 11, 2));
  for (let i = 0; i < 20; i++) { r.noteEngaged(); assert.equal(r.winback(), null); clock.t += DAY_MS; }
  done();
});

test('the one question: after the 10th thing that worked, once', () => {
  const { r, done } = rig(at(2026, 11, 9));
  for (let i = 0; i < 9; i++) r.noteWin('guide');
  assert.equal(r.pmfDue(), false);
  r.noteWin('guide');
  assert.equal(r.pmfDue(), true);
  r.pmfAsked('very disappointed');
  assert.equal(r.pmfDue(), false);
  assert.equal(r.state().pmfAnswer, 'very disappointed');
  done();
});

test('the holdout gets no report, win-back or question pop-ups', () => {
  const { r, done } = rig(at(2026, 11, 9), 'off');
  for (const hook of ['knot_report', 'winback_d3', 'winback_d7', 'winback_d30', 'pmf', 'morning_line']) assert.equal(r.canPop(hook), false, hook);
  done();
});
