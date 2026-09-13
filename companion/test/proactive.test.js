const test = require('node:test');
const assert = require('node:assert/strict');
const { createProactive, dayKey, COOLDOWN_MS } = require('../src/proactive');

const NOON = new Date(2026, 8, 7, 12, 0, 0).getTime();   // 2026-09-07 12:00 local
const today = dayKey(NOON);
const iso = (t) => new Date(t).toISOString();

function make(t0 = NOON) {
  let t = t0;
  const p = createProactive({ now: () => t });
  return { p, at: (v) => { t = v; }, advance: (ms) => { t += ms; } };
}

const snap = (over = {}) => Object.assign({
  next_moves: [{ id: 7, title: 'Problem set 3', due_date: today, course_name: 'CS 2110' }],
  tasks: [],
  gcal_events: [{ id: 'e1', summary: 'CS 2110 lecture', start: { dateTime: iso(NOON + 25 * 60000) } }],
}, over);

test('an event within the hour outranks a deadline due today; each key fires once per day', () => {
  const { p, advance } = make();
  const first = p.tick({ snapshot: snap(), snoozes: {} });
  assert.equal(first.kind, 'plan');
  assert.match(first.text, /CS 2110 lecture starts in 25 minutes\./);
  advance(COOLDOWN_MS + 1);
  const second = p.tick({ snapshot: snap(), snoozes: {} });
  assert.match(second.text, /Problem set 3 \(CS 2110\) is due today\./);
  advance(COOLDOWN_MS + 1);
  assert.equal(p.tick({ snapshot: snap(), snoozes: {} }), null, 'both keys already shown today');
});

test('not now snoozes that key for the day; the cooldown holds between nudges', () => {
  const { p, advance } = make();
  const snoozes = { ['event:e1:' + today]: today };
  const first = p.tick({ snapshot: snap(), snoozes });
  assert.match(first.text, /due today/, 'the snoozed event is skipped');
  assert.equal(p.tick({ snapshot: snap(), snoozes }), null, 'cooldown');
  advance(COOLDOWN_MS - 1000);
  assert.equal(p.tick({ snapshot: snap(), snoozes }), null);
});

test('quiet means quiet: nothing fires during a session, while hidden, or while listening', () => {
  const { p } = make();
  assert.equal(p.tick({ snapshot: snap(), snoozes: {}, quiet: true }), null);
});

test('overdue beats due today; due tomorrow only shows from the evening', () => {
  const evening = new Date(2026, 8, 7, 19, 0, 0).getTime();
  const { p } = make(evening);
  const s = snap({ gcal_events: [], next_moves: [
    { id: 1, title: 'Essay draft', due_date: '2026-09-08', course_name: 'ENGL 1010' },
    { id: 2, title: 'Lab report', due_date: '2026-09-05', course_name: 'PHYS 2211' },
  ] });
  const t = p.tick({ snapshot: s, snoozes: {} });
  assert.match(t.text, /Lab report \(PHYS 2211\) was due 2026-09-05\./);
  const noon = make();
  const cands = noon.p.planCandidates({ next_moves: [{ id: 1, title: 'Essay draft', due_date: '2026-09-08' }] });
  assert.equal(cands.length, 0, 'tomorrow is not a nudge at noon');
});

test('an app coming to the front with kept walkthroughs earns one short hint per app per day, never twice for the same window', () => {
  const { p, advance } = make();
  const walkthroughs = { forApp: (proc) => (proc === 'chrome' ? [{ task: 'submit my essay on canvas' }] : []) };
  assert.equal(p.tick({ snapshot: {}, snoozes: {}, walkthroughs, fgWindow: { process: 'claude', title: 'Claude' } }), null);
  const hint = p.tick({ snapshot: {}, snoozes: {}, walkthroughs, fgWindow: { process: 'chrome', title: 'Canvas - Google Chrome' } });
  assert.equal(hint.kind, 'app');
  assert.equal(hint.text, 'Canvas: 1 saved');
  assert.match(hint.hint, /Ask "submit my essay on canvas" to replay it\./);
  advance(COOLDOWN_MS + 1);
  assert.equal(p.tick({ snapshot: {}, snoozes: {}, walkthroughs, fgWindow: { process: 'chrome', title: 'Canvas' } }), null, 'same window, no repeat');
  p.tick({ snapshot: {}, snoozes: {}, walkthroughs, fgWindow: { process: 'claude', title: 'Claude' } });
  advance(COOLDOWN_MS + 1);
  assert.equal(p.tick({ snapshot: {}, snoozes: {}, walkthroughs, fgWindow: { process: 'chrome', title: 'Canvas' } }), null, 'once per app per day');
});

test('a window already in front when a session ends does not fire the moment quiet lifts', () => {
  const { p } = make();
  const walkthroughs = { forApp: () => [{ task: 'x' }] };
  assert.equal(p.tick({ snapshot: {}, snoozes: {}, walkthroughs, fgWindow: { process: 'chrome', title: 'Canvas' }, quiet: true }), null);
  assert.equal(p.tick({ snapshot: {}, snoozes: {}, walkthroughs, fgWindow: { process: 'chrome', title: 'Canvas' } }), null);
});
