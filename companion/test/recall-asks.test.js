'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseRecallAsk, mergePicks } = require('../src/recall/asks');
const B = require('../src/recall/brief');

const NOW = Date.parse('2026-10-16T15:00:00Z');
const kind = (t) => { const a = parseRecallAsk(t, { now: NOW }); return a ? a.kind : null; };

test('memory asks are told apart by code', () => {
  const cases = {
    "what's my brief": 'brief', 'brief': 'brief', 'Read me my morning brief': 'brief', 'what does my brief say about career': 'brief',
    "what's on my plate today": 'today', 'what should I work on today': 'today', "today's tasks": 'today',
    'what did I ask Claude about fantasy premier league': 'chats', 'across my chats, what have I said about pricing': 'chats',
    'in my claude chats did I talk about react': 'chats', 'what did ChatGPT say about my resume': 'chats',
    'look at my eigenvalues chat and my diagonalization chat and find the gap': 'merge', 'compare those two chats': 'merge',
    "what's the gap in my last two chats": 'merge',
    'what was I working on last week': 'recent', 'last week I was working on what again?': 'recent',
    "what's in my vault about the telemetry contract": 'vault', 'search my notes for fundraising': 'vault', 'what do my notes say about pricing': 'vault',
  };
  for (const [t, k] of Object.entries(cases)) assert.equal(kind(t), k, t);
});

test('everything else routes as before', () => {
  for (const t of ['open chrome', 'what is a pivot table', 'summarize this page', 'email the brief to Ankith', 'open my brief in notepad',
    'remember my chats are private', 'forget my chats', 'make a briefing pack', 'remind me at 4 to call mom', 'how do I open settings', '']) {
    assert.equal(kind(t), null, t);
  }
});

test('a time window comes from the words', () => {
  const day = 86400000;
  assert.equal(parseRecallAsk('what did I ask Claude about react last week', { now: NOW }).sinceMs, NOW - 14 * day);
  assert.equal(parseRecallAsk('what did I ask Claude about react yesterday', { now: NOW }).sinceMs, NOW - 2 * day);
  assert.equal(parseRecallAsk('what did I ask Claude about react', { now: NOW }).sinceMs, 0);
  const r = parseRecallAsk('what was I working on', { now: NOW });
  assert.equal(r.sinceMs, NOW - 7 * day, 'recent without a window means the last week');
});

test('two chats are named by their topic words', () => {
  assert.deepEqual(mergePicks('look at my eigenvalues chat and my diagonalization chat and find the gap'), ['eigenvalues', 'diagonalization']);
  assert.deepEqual(mergePicks('merge the assistant chat with the voters one'), ['assistant', 'voters']);
  assert.deepEqual(mergePicks('find the gap between "Calc 14.1" and "Calc 14.3"'), ['Calc 14.1', 'Calc 14.3']);
  assert.deepEqual(mergePicks('compare my last two chats'), []);
});

const BRIEF_MD = `# Morning Brief: 2026-10-15

Today is Wednesday, October 15, 2026. The biggest fact: the loop is stalled on inputs \u2014 only you can provide them.

**In motion**

- **Companion**: building 0.1.7. Next step: film.

**Growth**

- Pending approvals: none.

**Career**

- No internship report for today. Newest is 2026-10-08.

**Worth a look**

- The launch-rate finding.

**Today's #1**

Open Instagram and screenshot the cards, because everything waits on them.

## Today's Tasks

1. Screenshot the Insights cards.
2. Post the approved batch.

**Most important: screenshot the Insights.** Everything is blocked on it.
`;

function briefVault(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nus-brief-'));
  fs.mkdirSync(path.join(dir, 'logs'));
  for (const [n, t] of Object.entries(files)) fs.writeFileSync(path.join(dir, 'logs', n), t);
  return dir;
}

test('the newest real brief is found; stubs and failure logs are skipped', () => {
  const dir = briefVault({ 'brief-2026-10-14.md': BRIEF_MD.replace('2026-10-15', '2026-10-14'), 'brief-2026-10-15.md': BRIEF_MD, 'brief-2026-10-16.md': 'failed', 'brief-failures.log': 'x' });
  const b = B.latestBrief(dir, { now: Date.parse('2026-10-16T15:00:00') });
  assert.equal(b.date, '2026-10-15');
  assert.equal(b.isToday, false);
  assert.deepEqual(Object.keys(b.sections), ['opening', 'In motion', 'Growth', 'Career', 'Worth a look', "Today's #1"]);
  assert.deepEqual(b.tasks, ['Screenshot the Insights cards.', 'Post the approved batch.']);
  assert.equal(b.mostImportant, 'screenshot the Insights. Everything is blocked on it.');
  assert.equal(B.latestBrief(path.join(dir, 'nope')), null);
  assert.equal(B.latestBrief(''), null);
});

test('the brief is read out short, says when it is stale, and never says an em dash', () => {
  const dir = briefVault({ 'brief-2026-10-15.md': BRIEF_MD });
  const stale = B.briefAnswer(B.latestBrief(dir, { now: Date.parse('2026-10-16T15:00:00') }));
  assert.match(stale.say, /^Your newest brief is from October 15, so it may be out of date\. The biggest fact/);
  assert.doesNotMatch(stale.say, /Today is Wednesday/);
  assert.match(stale.say, /Your number one today: Open Instagram/);
  assert.doesNotMatch(stale.say + stale.show, /[\u2013\u2014*]/);
  assert.match(stale.show, /Career: No internship report/);
  const fresh = B.briefAnswer(B.latestBrief(dir, { now: Date.parse('2026-10-15T09:00:00') }));
  assert.doesNotMatch(fresh.say, /out of date/);
  const career = B.briefAnswer(B.latestBrief(dir, { now: Date.parse('2026-10-15T09:00:00') }), 'what does my brief say about career');
  assert.match(career.say, /^No internship report for today/);
  const today = B.todayAnswer(B.latestBrief(dir, { now: Date.parse('2026-10-15T09:00:00') }));
  assert.match(today.say, /^2 tasks for today\. Most important: screenshot the Insights\./);
  assert.match(today.show, /1\. Screenshot the Insights cards\.\n2\. Post the approved batch\./);
  assert.match(B.briefAnswer(null).say, /could not find a brief/);
});
