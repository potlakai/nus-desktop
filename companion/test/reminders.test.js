// Reminders and timers: "remind me at 4 to email Professor Lee", "remind me in
// 20 minutes to stretch", "set a timer for 10 minutes", "cancel the timer".
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseReminder, parseDuration, createReminders, whenLabel, describeList, panelRows, durationWords } = require('../src/reminders');
const { rewriteAsk } = require('../src/reflex/rules');
const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

// Monday 12 October 2026, 10:15 in the morning, local time.
const NOW = new Date(2026, 9, 12, 10, 15, 0).getTime();
const at = (day, h, m = 0) => new Date(2026, 9, day, h, m, 0, 0).getTime();

test('durations in words and digits', () => {
  assert.equal(parseDuration('20 minutes'), 20 * 60000);
  assert.equal(parseDuration('an hour'), 3600000);
  assert.equal(parseDuration('half an hour'), 30 * 60000);
  assert.equal(parseDuration('an hour and a half'), 90 * 60000);
  assert.equal(parseDuration('1 hour 30 minutes'), 90 * 60000);
  assert.equal(parseDuration('2 hours and 15 minutes'), 135 * 60000);
  assert.equal(parseDuration('ten minutes'), 10 * 60000);
  assert.equal(parseDuration('90 seconds'), 90000);
  assert.equal(parseDuration('soon'), null);
});

test('a reminder at a clock time: the next one ahead, afternoon for 1 to 6', () => {
  let r = parseReminder('remind me at 4 to email Professor Lee', NOW);
  assert.deepEqual(r, { kind: 'reminder', at: at(12, 16), what: 'email Professor Lee' });
  r = parseReminder('Remind me at 4:30 pm to call mom', NOW);
  assert.equal(r.at, at(12, 16, 30)); assert.equal(r.what, 'call mom');
  assert.equal(parseReminder('remind me at 9 to study', NOW).at, at(12, 21), '9 in the morning has passed: 9 tonight');
  assert.equal(parseReminder('remind me at 11 to stand up', NOW).at, at(12, 11), '11 is still ahead this morning');
  assert.equal(parseReminder('remind me at 16:45 to leave', NOW).at, at(12, 16, 45));
  assert.equal(parseReminder('remind me at noon to eat', NOW).at, at(12, 12));
  assert.equal(parseReminder('set a reminder for 3pm to leave for class', NOW).at, at(12, 15));
  assert.equal(parseReminder('set a reminder for 3pm to leave for class', NOW).what, 'leave for class');
  assert.equal(parseReminder('remind me at 8 am to stretch', NOW).at, at(13, 8), '8 am has passed today: tomorrow');
});

test('today, tomorrow and tonight', () => {
  let r = parseReminder('remind me tomorrow at 9:30 am to submit lab 3', NOW);
  assert.equal(r.at, at(13, 9, 30)); assert.equal(r.what, 'submit lab 3');
  r = parseReminder('remind me tonight at 8 to call dad', NOW);
  assert.equal(r.at, at(12, 20)); assert.equal(r.what, 'call dad');
  r = parseReminder('remind me tomorrow to call the bank', NOW);
  assert.equal(r.at, at(13, 9)); assert.equal(r.what, 'call the bank');
});

test('a reminder in a while, with the words before or after the time', () => {
  let r = parseReminder('remind me in 20 minutes to stretch', NOW);
  assert.deepEqual(r, { kind: 'reminder', at: NOW + 20 * 60000, what: 'stretch' });
  r = parseReminder('remind me to stretch in 20 minutes', NOW);
  assert.equal(r.at, NOW + 20 * 60000); assert.equal(r.what, 'stretch');
  r = parseReminder('hey can you remind me in half an hour that the laundry is done', NOW);
  assert.equal(r.at, NOW + 30 * 60000); assert.equal(r.what, 'the laundry is done');
});

test('timers, cancelling, and the list', () => {
  for (const said of ['set a timer for 10 minutes', 'start a 10 minute timer', '10 minute timer', 'set a timer for 10', 'timer for ten minutes']) {
    const r = parseReminder(said, NOW);
    assert.equal(r && r.kind, 'timer', said); assert.equal(r.ms, 600000, said); assert.equal(r.at, NOW + 600000, said); assert.equal(r.label, '10 minute timer', said);
  }
  assert.deepEqual(parseReminder('cancel the timer', NOW), { kind: 'cancel', which: 'timer', all: false, about: '' });
  assert.deepEqual(parseReminder('stop the timer', NOW), { kind: 'cancel', which: 'timer', all: false, about: '' });
  assert.deepEqual(parseReminder('cancel all my reminders', NOW), { kind: 'cancel', which: 'reminder', all: true, about: '' });
  assert.deepEqual(parseReminder('cancel the reminder to stretch', NOW), { kind: 'cancel', which: 'reminder', all: false, about: 'stretch' });
  assert.deepEqual(parseReminder('what are my reminders', NOW), { kind: 'list' });
  assert.deepEqual(parseReminder('how much time is left on the timer', NOW), { kind: 'list' });
});

test('not a reminder: no time means it stays a note; other asks are left alone', () => {
  for (const said of ['remind me that my exam is Thursday', 'remember I take CS 2110', 'set a timer', 'stop', 'cancel', 'open notepad', 'what time is it', 'make this friendlier', 'how do I set a timer in Excel'])
    assert.equal(parseReminder(said, NOW), null, said);
  assert.equal(rewriteAsk('remind me in 20 minutes to stretch'), null);
});

function tmpFile() { return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nus-rem-')), 'companion', 'reminders.json'); }
function clock(start) {
  const c = { t: start, timers: [] };
  c.now = () => c.t;
  c.setTimer = (fn, ms) => { const h = { fn, due: c.t + ms, live: true }; c.timers.push(h); return h; };
  c.clearTimer = (h) => { if (h) h.live = false; };
  c.advance = (ms) => { c.t += ms; for (const h of c.timers.slice()) if (h.live && h.due <= c.t) { h.live = false; h.fn(); } };
  return c;
}

test('the store fires each reminder once, at its time, and keeps the rest', () => {
  const file = tmpFile(), c = clock(NOW), fired = [], changes = [];
  const store = createReminders({ file, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer, onFire: (r) => fired.push(r), onChange: (l) => changes.push(l.length) });
  store.start();
  store.add(parseReminder('remind me in 20 minutes to stretch', c.t));
  store.add(parseReminder('set a timer for 10 minutes', c.t));
  store.add(parseReminder('remind me at 4 to email Professor Lee', c.t));
  assert.equal(store.list().length, 3);
  assert.equal(store.list()[0].kind, 'timer', 'soonest first');
  c.advance(9 * 60000); assert.equal(fired.length, 0);
  c.advance(60000); assert.equal(fired.length, 1); assert.equal(fired[0].kind, 'timer'); assert.equal(fired[0].late, false);
  c.advance(10 * 60000); assert.equal(fired.length, 2); assert.equal(fired[1].what, 'stretch');
  assert.equal(store.list().length, 1);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.items.length, 1); assert.equal(saved.items[0].what, 'email Professor Lee');
  assert.ok(changes.length >= 5);
  store.stop();
});

test('reminders survive a restart; one missed while closed fires late, a missed timer is dropped', () => {
  const file = tmpFile(), c = clock(NOW);
  const first = createReminders({ file, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer });
  first.add(parseReminder('remind me in 20 minutes to stretch', c.t));
  first.add(parseReminder('set a timer for 5 minutes', c.t));
  first.add(parseReminder('remind me at 4 to email Professor Lee', c.t));
  first.stop();
  // Nūs closed for an hour.
  const c2 = clock(NOW + 3600000), fired = [];
  const second = createReminders({ file, now: c2.now, setTimer: c2.setTimer, clearTimer: c2.clearTimer, onFire: (r) => fired.push(r) });
  assert.equal(second.list().length, 3, 'all three read back from the file');
  second.start();
  assert.equal(second.list().length, 2, 'the run-out timer is gone');
  c2.advance(0);
  assert.equal(fired.length, 1); assert.equal(fired[0].what, 'stretch'); assert.equal(fired[0].late, true);
  assert.equal(second.list().length, 1);
  c2.advance(at(12, 16) - c2.t);
  assert.equal(fired.length, 2); assert.equal(fired[1].late, false);
  second.stop();
});

test('cancel takes the next timer, every reminder, or the one whose words match; remove takes one by id', () => {
  const file = tmpFile(), c = clock(NOW);
  const store = createReminders({ file, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer });
  store.add(parseReminder('set a timer for 10 minutes', c.t));
  const stretch = store.add(parseReminder('remind me in 20 minutes to stretch', c.t));
  store.add(parseReminder('remind me at 4 to email Professor Lee', c.t));
  assert.equal(store.cancel({ which: 'timer' }).length, 1);
  assert.equal(store.cancel({ which: 'timer' }).length, 0, 'nothing left to cancel');
  const gone = store.cancel({ which: 'reminder', about: 'professor lee' });
  assert.equal(gone.length, 1); assert.equal(gone[0].what, 'email Professor Lee');
  assert.equal(store.remove(stretch.id), 1);
  assert.equal(store.list().length, 0);
  store.add(parseReminder('remind me in 20 minutes to stretch', c.t)); store.add(parseReminder('remind me at 4 to eat', c.t));
  assert.equal(store.cancel({ which: 'reminder', all: true }).length, 2);
  store.stop();
});

test('the words people see: labels, the list, the Home rows', () => {
  assert.equal(whenLabel(at(12, 16), NOW), 'today at 4:00 PM');
  assert.equal(whenLabel(at(13, 9, 30), NOW), 'tomorrow at 9:30 AM');
  assert.equal(durationWords(600000), '10 minutes');
  assert.equal(durationWords(60000), '1 minute');
  assert.equal(durationWords(90 * 60000), '1 hour 30 minutes');
  assert.equal(describeList([], NOW), 'You have no reminders or timers.');
  const items = [{ id: 'a', kind: 'timer', at: NOW + 600000, label: '10 minute timer' }, { id: 'b', kind: 'reminder', at: at(12, 16), what: 'email Professor Lee' }];
  assert.equal(describeList(items, NOW), 'You have 2: a 10 minute timer with 10 minutes left; "email Professor Lee" today at 4:00 PM.');
  assert.deepEqual(panelRows(items, NOW), [
    { id: 'a', kind: 'timer', title: '10 minute timer', when: 'ends 10:25 AM' },
    { id: 'b', kind: 'reminder', title: 'email Professor Lee', when: 'today at 4:00 PM' },
  ]);
  for (const s of [describeList(items, NOW), whenLabel(NOW, NOW)]) assert.doesNotMatch(s, /—/);
});

test('the Companion routes reminders by code before the reflex note rule, fires with a bubble and a spoken line, and Home lists them', () => {
  const main = read('index.js');
  assert.match(main, /function ownPath\(text\) \{ return Boolean\([^\n]*\|\| parseReminder\(text\)[^\n]*\); \}/);
  const slow = main.slice(main.indexOf('function routeUtteranceSlow('), main.indexOf('function routeAnswer('));
  assert.match(slow, /const rm = parseReminder\(kind\.text\); if \(rm\) \{[^\n]*handleReminder\(rm, source\)/);
  assert.ok(slow.indexOf('parseReminder(kind.text)') < slow.indexOf("dropped: a walkthrough is still running"), 'a reminder works while a walkthrough is up');
  assert.match(main, /file: path\.join\(app\.getPath\('userData'\), 'companion', 'reminders\.json'\)/);
  assert.match(main, /send\('guide:bubble', \{ text, anchor: 'knot', task: 'ask', kicker: item\.kind === 'timer' \? 'timer' : 'reminder'/);
  assert.match(main, /send\('guide:say', \{ text: line, first: true, sessionId: null \}\)/);
  assert.match(main, /'Reminder: ' \+ item\.what/);
  assert.match(main, /getReminders\(\)\.start\(\);/);
  assert.match(main, /!ownPath\(text\) && !handsClaims\(text\)/, 'a half-heard reminder never reaches the reflex note rule');
  const host = fs.readFileSync(path.join(root, '..', 'src', 'main-companion.js'), 'utf8');
  assert.match(host, /handle\('home:reminders:list', \(\) => companion\.reminders\(\)\)/);
  assert.match(host, /handle\('home:reminders:remove', id => companion\.reminderRemove\(String\(id \|\| ''\)\)\)/);
  assert.match(host, /onReminders: rows => send\('home:reminders', rows\)/);
  assert.match(read('home', 'preload.js'), /'home:reminders'\]/);
  assert.match(read('home', 'index.html'), /id="reminders-card"[^>]*><h3 class="card-label">Reminders<\/h3><div id="reminder-list"><\/div>/);
  const home = read('home', 'home.js');
  assert.match(home, /data-reminder-remove=/);
  assert.match(home, /api\.on\('home:reminders',rows=>paintReminders\(rows\)\)/);
});
