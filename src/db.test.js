// Schema + CRUD + ranking + GPA math + companion sessions, no Electron needed.
// Uses node:test so a broken assertion actually fails the run. (This file used
// console.assert, which logs and still exits 0, so nothing here could fail CI.)
const { test, before } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { open, api } = require('./db');
const { rankToday, projectCourse, overallGpa } = require('./logic');

let courseId, wExams, wHw, hwId;

before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nus-test-'));
  await open(dir);
  courseId = api.addCourse({ name: 'MATH 2418', credit_hours: 4, term: 'Fall 2026' });
  wExams = api.addGradeWeight({ course_id: courseId, category: 'Exams', weight_pct: 60 });
  wHw = api.addGradeWeight({ course_id: courseId, category: 'Homework', weight_pct: 40 });
  api.addAssignment({ course_id: courseId, grade_weight_id: wExams, title: 'Exam 1', due_date: '2026-08-10' });
  hwId = api.addAssignment({ course_id: courseId, grade_weight_id: wHw, title: 'HW 1', due_date: '2026-08-07' });
  api.updateAssignment(hwId, { status: 'graded', score_pct: 95 });
});

test('courses and assignments persist', () => {
  assert.equal(api.listCourses().length, 1);
  assert.equal(api.listAssignments(courseId).length, 2);
});

test('ranking puts the heavy pending exam first, with its reason', () => {
  const ranked = rankToday(
    api.listAssignments(courseId).filter((a) => a.status === 'pending').map((a) => ({
      title: a.title, due_date: a.due_date, weight_pct: 60, course_name: 'MATH 2418',
    })),
    new Date('2026-08-06T12:00:00')
  );
  assert.equal(ranked[0].title, 'Exam 1');
  assert.match(ranked[0].reason, /60%/);
});

test('GPA projection splits known and assumed weight', () => {
  // HW graded 95 (40%), exams assumed 90 (60%) -> 38 + 54 = 92 -> A-
  const proj = projectCourse(api.listGradeWeights(courseId), api.listAssignments(courseId));
  assert.ok(Math.abs(proj.projected_pct - 92) < 0.01, `projected 92, got ${proj.projected_pct}`);
  assert.equal(proj.letter, 'A-');
  assert.equal(proj.known_weight, 40);
  assert.equal(proj.assumed_weight, 60);
  assert.equal(overallGpa([{ credit_hours: 4, points: proj.points }]), 3.7);
});

test('a reminder fires exactly once', () => {
  const taskId = api.addTask({ title: 'Study for Exam 1', due_date: '2026-08-09' });
  api.addReminder({ task_id: taskId, fire_at: '2026-08-06T00:00:00Z' });
  const due = api.dueReminders(new Date().toISOString());
  assert.equal(due.length, 1);
  assert.equal(due[0].task_title, 'Study for Exam 1');
  api.markFired(due[0].id);
  assert.equal(api.dueReminders(new Date().toISOString()).length, 0);
});

// ---- Companion sessions: the history feature's storage contract ----

test('a companion session round-trips with its messages', () => {
  const started = new Date().toISOString();
  const id = api.addCompanionSession({ started_at: started, pack: 'sample-briefing' });
  assert.ok(id > 0);

  api.addCompanionMessage(id, { channel: 'them', text: 'The seat pricing feels steep.', ts: Date.now() });
  api.addCompanionMessage(id, { channel: 'you', text: 'What is the counter?', ts: Date.now(), mode: 'ask' });
  api.addCompanionMessage(id, { channel: 'nus', text: 'Anchor on outcome per member.', ts: Date.now(), mode: 'ask', used_screenshot: true });

  const messages = api.listCompanionMessages(id);
  assert.equal(messages.length, 3);
  assert.deepEqual(messages.map((m) => m.channel), ['them', 'you', 'nus']);
  assert.equal(messages[2].used_screenshot, 1, 'screenshot flag stored as 1');
  assert.ok(messages[0].ts.includes('T'), 'timestamps normalize to ISO');

  api.updateCompanionSession(id, { ended_at: new Date().toISOString(), title: 'Pricing objection' });
  const session = api.listCompanionSessions().find((s) => s.id === id);
  assert.equal(session.title, 'Pricing objection');
  assert.equal(session.message_count, 3, 'session list carries a message count');
  assert.ok(session.ended_at);
});

test('session search matches message text and maps back to the session', () => {
  const hits = api.searchCompanionMessages('seat pricing');
  assert.ok(hits.length >= 1);
  assert.ok(hits[0].session_id > 0);
  assert.equal(api.searchCompanionMessages('nothing matches this string').length, 0);
});

test('updateCompanionSession refuses fields outside the allow-list', () => {
  const id = api.addCompanionSession({ started_at: new Date().toISOString(), pack: '' });
  const before = api.listCompanionSessions().find((s) => s.id === id);
  api.updateCompanionSession(id, { id: 9999, started_at: 'hacked' });
  const after = api.listCompanionSessions().find((s) => s.id === id);
  assert.equal(after.id, id, 'id is not writable');
  assert.equal(after.started_at, before.started_at, 'started_at is not writable');
});
