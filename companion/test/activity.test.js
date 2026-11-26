// The Activity view on the Home window: the last 50 model requests from the
// usage ledger in plain words, and one line for today.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLedger, activityView } = require('../src/usage-ledger');
const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

// Monday 12 October 2026, 3 in the afternoon, local time.
const NOW = new Date(2026, 9, 12, 15, 0, 0).getTime();
const iso = (day, h, m = 0) => new Date(2026, 9, day, h, m, 0).toISOString();

const ROWS = [
  { at: iso(10, 9, 5), feature: 'guide', provider: 'gemini', model: 'gemini-3.6-flash', outcome: 'ok', ms: 3100, costUsd: 0.0004, note: 'click in Word' },
  { at: iso(11, 22, 58), feature: 'hands', provider: 'claude (desktop)', model: '', outcome: 'step-failed', ms: 11812, costUsd: null, note: 'open Notepad and write my to-do list' },
  { at: iso(12, 9, 30), feature: 'answer', provider: 'claude (desktop)', model: '', outcome: 'ok', ms: 2400, costUsd: null, note: 'no screen' },
  { at: iso(12, 10, 0), feature: 'guide', provider: 'anthropic', model: 'claude-sonnet-5', outcome: 'explain', ms: 4200, costUsd: 0.0123, note: 'point in Chrome' },
  { at: iso(12, 13, 45), feature: 'solve', provider: 'anthropic', model: 'claude-sonnet-5', outcome: 'error', ms: 61000, costUsd: 0.02, note: 'asked in firefox' },
  { at: iso(12, 14, 59), feature: 'rewrite', provider: 'gemini', model: 'gemini-3.6-flash', outcome: 'ok', ms: 1800, note: 'friendly, replaced, WINWORD' },
];

test('the newest request comes first, every field in plain words', () => {
  const v = activityView(ROWS, { now: NOW });
  assert.equal(v.rows.length, 6);
  assert.deepEqual(v.rows[0], { at: ROWS[5].at, when: 'Today, 2:59 PM', feature: 'Rewrite', outcome: 'Done', ok: true, seconds: '1.8 s', model: 'gemini-3.6-flash', cost: '', note: 'friendly, replaced, WINWORD' });
  assert.equal(v.rows[1].feature, 'Homework help'); assert.equal(v.rows[1].outcome, 'Failed'); assert.equal(v.rows[1].ok, false); assert.equal(v.rows[1].cost, '$0.02'); assert.equal(v.rows[1].seconds, '61.0 s');
  assert.equal(v.rows[2].feature, 'Walkthrough'); assert.equal(v.rows[2].outcome, 'Answered in words'); assert.equal(v.rows[2].ok, true); assert.equal(v.rows[2].cost, '$0.01');
  assert.equal(v.rows[3].feature, 'Answer'); assert.equal(v.rows[3].model, 'Claude Code', 'the brain is named when the row has no model');
  assert.equal(v.rows[4].when, 'Yesterday, 10:58 PM'); assert.equal(v.rows[4].feature, 'Hands'); assert.equal(v.rows[4].outcome, 'A step did not work');
  assert.equal(v.rows[5].when, 'Oct 10, 9:05 AM'); assert.equal(v.rows[5].cost, '$0.0004', 'a fraction of a cent still shows');
  for (const r of v.rows) for (const k of ['when', 'feature', 'outcome', 'seconds', 'model', 'cost']) { assert.equal(typeof r[k], 'string'); assert.doesNotMatch(r[k], /[{}"]|—/, k); }
});

test('the line for today counts only today, names the failures, and adds up the wait and the cost', () => {
  const v = activityView(ROWS, { now: NOW });
  assert.equal(v.today.requests, 4);
  assert.equal(v.today.failed, 1, 'only the failed homework help; "answered in words" is not a failure');
  assert.equal(v.today.ms, 2400 + 4200 + 61000 + 1800);
  assert.equal(v.today.costUsd, 0.0323);
  assert.equal(v.today.line, 'Today: 4 requests, 1 did not work, 1 min 9 s of waiting in all, about $0.03 at API prices.');
  assert.equal(activityView([ROWS[2]], { now: NOW }).today.line, 'Today: 1 request, 2 s of waiting in all.');
  assert.equal(activityView([], { now: NOW }).today.line, 'Nothing yet today.');
  assert.equal(activityView([ROWS[0]], { now: NOW }).today.line, 'Nothing yet today.');
});

test('at most the last 50, and broken lines are skipped', () => {
  const many = [];
  for (let i = 0; i < 80; i++) many.push({ at: new Date(NOW - (80 - i) * 60000).toISOString(), feature: 'guide', outcome: 'ok', ms: 1000, note: 'n' + i });
  const v = activityView([...many, null, { at: 'not a date' }, {}], { now: NOW });
  assert.equal(v.rows.length, 50);
  assert.equal(v.rows[0].note, 'n79'); assert.equal(v.rows[49].note, 'n30');
  assert.equal(activityView(many, { now: NOW, limit: 5 }).rows.length, 5);
});

test('it reads the ledger file the Companion writes', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nus-activity-')), 'usage.jsonl');
  let t = NOW - 60000;
  const l = createLedger({ file, now: () => t });
  l.record({ feature: 'hands', provider: 'claude (desktop)', outcome: 'ok', ms: 5000, note: 'open Notepad' });
  fs.appendFileSync(file, '{broken\n');
  t += 1000;
  l.record({ feature: 'page', provider: 'gemini', model: 'gemini-3.6-flash', outcome: 'ok', ms: 2500, note: 'summarize this page' });
  const v = activityView(l.read(), { now: NOW });
  assert.deepEqual(v.rows.map((r) => r.feature), ['Read the page', 'Hands']);
  assert.equal(v.today.requests, 2);
});

test('Home asks for it over its own channel and shows it as an Activity tab under Saved; homework help is in the ledger too', () => {
  const host = fs.readFileSync(path.join(root, '..', 'src', 'main-companion.js'), 'utf8');
  assert.match(host, /handle\('home:activity', \(\) => companion\.activity\(\)\)/);
  assert.match(read('home', 'preload.js'), /activity: \(\) => invoke\('activity'\)/);
  const main = read('index.js');
  assert.match(main, /activity: \(\) => activityView\(getLedger\(\)\.read\(\), \{ now: Date\.now\(\), limit: 50 \}\)/);
  assert.match(main, /getLedger\(\)\.record\(\{ feature: 'solve'/);
  const html = read('home', 'index.html');
  assert.match(html, /<button data-saved="activity" role="tab">Activity<\/button>/);
  assert.match(html, /<div id="saved-activity" class="saved-view"><\/div>/);
  const home = read('home', 'home.js');
  assert.match(home, /else if\(saved==='activity'\) \{/);
  assert.match(home, /<th>When<\/th><th>What<\/th><th>Result<\/th><th>Took<\/th><th>AI<\/th><th>Cost<\/th><th>Details<\/th>/);
  assert.match(home, /esc\(a\.today\.line\)/);
  assert.doesNotMatch(home, /JSON\.stringify/, 'no raw JSON on the page');
});
