'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLedger, estimateCost, textTokens, imageTokens } = require('../src/usage-ledger');

test('rows are appended as JSON lines with a cost estimate when the brain gave token counts', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nus-ledger-')), 'usage.jsonl');
  let t = Date.parse('2026-10-09T12:00:00Z');
  const l = createLedger({ file, now: () => t });
  const row = l.record({ feature: 'guide', provider: 'claude (desktop)', model: 'claude-sonnet-5', ms: 2100, timings: { first_token: 900, first_point: 1400 }, usage: { input_tokens: 2000, output_tokens: 60 }, warm: true });
  assert.equal(row.costUsd, Math.round((2000 * 3 + 60 * 15) / 1e6 * 1e6) / 1e6);
  t += 1000;
  l.record({ feature: 'guide', provider: 'gemini', model: 'gemini-3.6-flash', outcome: 'error', ms: 9000, costUsd: 0 });
  const rows = l.read();
  assert.equal(rows.length, 2);
  assert.equal(rows[1].outcome, 'error');
  const s = l.summary(1);
  assert.equal(s.requests, 2); assert.equal(s.failed, 1);
  assert.equal(s.byFeature.guide, 2);
  assert.equal(s.medianFirstTokenMs, 900);
  assert.ok(s.costUsd > 0);
  // Yesterday's rows fall out of a one-day summary.
  t += 2 * 86400000;
  assert.equal(l.summary(1).requests, 0);
});

test('estimates: unknown models have no price, tokens follow the four-chars and image rules', () => {
  assert.equal(estimateCost('mystery-model', { input_tokens: 10 }), null);
  assert.equal(estimateCost('claude-sonnet-5', null), null);
  assert.equal(textTokens('abcdefgh'), 2);
  assert.equal(imageTokens(1568, 882), Math.min(1600, Math.ceil(1568 * 882 / 750)));
  assert.equal(imageTokens(4000, 3000), 1600);
});

test('a ledger without a file records nothing and summarizes to zero', () => {
  const l = createLedger({});
  assert.equal(l.record({ feature: 'x' }), null);
  assert.equal(l.summary().requests, 0);
});
