const { test } = require('node:test');
const assert = require('node:assert');
const { createLimits, FREE_LIMITS, PRO_STORAGE_BYTES, localDay } = require('./limits');

function harness({ pro = false, now = Date.parse('2026-08-21T12:00:00') } = {}) {
  const preferences = {};
  const db = {
    getPreferences: () => ({ ...preferences }),
    setPreference: (key, value) => { preferences[key] = value; },
  };
  const license = { status: () => ({ isPro: pro }) };
  return { limits: createLimits({ db, license, clock: () => now }), preferences };
}

test('Free syllabus extraction stops after three unique sources', () => {
  const { limits } = harness();
  for (const id of [1, 2, 3]) {
    assert.equal(limits.syllabusAllowed(id).ok, true);
    limits.recordSyllabus(id);
  }
  assert.equal(limits.syllabusAllowed(4).error, 'limit_syllabus_imports');
  assert.equal(limits.syllabusAllowed(2).ok, true, 'a retry of an already counted source stays available');
});

test('Free questions are ten per local day and failed calls can roll back', () => {
  const { limits, preferences } = harness();
  const first = limits.reserveQuestion();
  assert.equal(first.ok, true);
  first.rollback();
  assert.equal(preferences.usage_questions_daily.count, 0);
  for (let i = 0; i < FREE_LIMITS.questionsPerDay; i += 1) assert.equal(limits.reserveQuestion().ok, true);
  assert.equal(limits.reserveQuestion().error, 'limit_questions');
});

test('Free allows only one connected account and one automation', () => {
  const { limits } = harness();
  assert.equal(limits.connectedAccountAllowed('outlook', { google_calendar: true, outlook: false }).error, 'limit_connected_accounts');
  assert.equal(limits.connectedAccountAllowed('google_calendar', { google_calendar: true, outlook: false }).ok, true);
  assert.equal(limits.automationAllowed(1).error, 'limit_automation_rules');
});

test('Companion allowance and seven-day history are enforced locally', () => {
  const now = Date.parse('2026-08-21T12:00:00');
  const { limits } = harness({ now });
  limits.recordCompanionMs(5 * 60 * 1000);
  assert.equal(limits.companionAllowanceMs(), 15 * 60 * 1000);
  assert.equal(Date.parse(limits.historyCutoff()), now - 7 * 86400000);
});

test('Pro bypasses feature caps but keeps a physical two-gigabyte safety cap', () => {
  const { limits } = harness({ pro: true });
  assert.equal(limits.syllabusAllowed(999).ok, true);
  assert.equal(limits.automationAllowed(99).ok, true);
  assert.equal(limits.companionAllowanceMs(), Number.POSITIVE_INFINITY);
  assert.equal(limits.historyCutoff(), null);
  assert.equal(limits.storageCapBytes(), PRO_STORAGE_BYTES);
});

test('day keys follow local calendar days', () => {
  assert.match(localDay(Date.parse('2026-08-21T12:00:00')), /^2026-08-21$/);
});
