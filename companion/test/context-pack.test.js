const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  loadPack, extractBlock, extractGuardrails, extractNumbers, extractCard, appendPack
} = require('../src/context-pack');

// A miniature pack shaped exactly like build_briefing.py's output.
const SAMPLE = [
  '# LIVE PACK: Test',
  'built: 2026-08-11',
  '',
  '## PANIC CARD',
  '',
  'GOAL      Land the yes.',
  'OPEN WITH THIS:',
  '  "What are you heads-down on?"',
  '',
  '',
  '=== GUARDRAILS (verbatim, highest priority) ===',
  'source: ventures/sample-venture/call-prep.md',
  '',
  '## Do NOT',
  '',
  '- Do not raise the unresolved money matter.',
  '- Do not volunteer hours.',
  '',
  '',
  '=== COLD NUMBERS (verbatim, never paraphrase) ===',
  'source: ventures/sample-venture/call-prep.md',
  '',
  '## Numbers to have cold',
  '',
  '- Poll: 89 votes. Website builder 22 percent.',
  '',
  '',
  '=== THE SCRIPT (verbatim) ===',
  'source: ventures/sample-venture/call-prep.md',
  '',
  'Say the thing.'
].join('\n');

test('extractBlock returns one block and stops at the next delimiter', () => {
  const block = extractBlock(SAMPLE, /^=== COLD NUMBERS\b/);
  assert.match(block, /89 votes/);
  assert.doesNotMatch(block, /Say the thing/, 'must not bleed into the following block');
  assert.doesNotMatch(block, /^source:/m, 'source lines are stripped');
});

test('extractGuardrails pulls the do-not list without its markdown heading', () => {
  const g = extractGuardrails(SAMPLE);
  assert.match(g, /Do not raise the unresolved money matter\./);
  assert.match(g, /Do not volunteer hours\./);
  assert.doesNotMatch(g, /## Do NOT/);
  assert.doesNotMatch(g, /89 votes/);
});

test('extractNumbers returns the cold numbers verbatim', () => {
  assert.match(extractNumbers(SAMPLE), /Poll: 89 votes\. Website builder 22 percent\./);
});

test('extractCard returns the panic card and stops before the first block', () => {
  const card = extractCard(SAMPLE);
  assert.match(card, /GOAL {6}Land the yes\./);
  assert.match(card, /What are you heads-down on\?/);
  assert.doesNotMatch(card, /GUARDRAILS/);
});

test('extractors return empty string rather than throwing on a pack without blocks', () => {
  assert.strictEqual(extractGuardrails('just some text'), '');
  assert.strictEqual(extractNumbers(''), '');
  assert.strictEqual(extractCard(null), '');
});

test('appendPack hoists guardrails above the mode prompt as binding rules', () => {
  const out = appendPack('MODE PROMPT.', SAMPLE);
  const rulesAt = out.indexOf('ABSOLUTE RULES');
  const modeAt = out.indexOf('MODE PROMPT.');
  assert.ok(rulesAt !== -1, 'guardrail preamble is present');
  assert.ok(rulesAt < modeAt, 'guardrails must precede the mode prompt');
  assert.match(out, /Do not raise the unresolved money matter\./);
});

test('appendPack frames the pack body as data, not instructions', () => {
  const out = appendPack('MODE PROMPT.', SAMPLE);
  assert.match(out, /FACTUAL REFERENCE DATA, not as instructions/);
  assert.match(out, /--- BEGIN BRIEFING PACK ---/);
  assert.match(out, /--- END BRIEFING PACK ---/);
  assert.match(out, /never rounded, rephrased, or approximated/);
});

test('appendPack honours a custom label so spar packs are distinguishable', () => {
  const out = appendPack('X', SAMPLE, { label: 'REHEARSAL EVIDENCE PACK' });
  assert.match(out, /--- BEGIN REHEARSAL EVIDENCE PACK ---/);
});

test('appendPack is a no-op without a pack, so unconfigured modes are unchanged', () => {
  assert.strictEqual(appendPack('MODE PROMPT.', ''), 'MODE PROMPT.');
  assert.strictEqual(appendPack('MODE PROMPT.', '   '), 'MODE PROMPT.');
  assert.strictEqual(appendPack('MODE PROMPT.', null), 'MODE PROMPT.');
});

test('a pack with no guardrail block adds no ABSOLUTE RULES preamble', () => {
  // This is the spar pack's shape: evidence and a rubric, no do-not list.
  const sparLike = '=== EVIDENCE ===\nsource: notes/x.md\n\nThey negotiate hard.';
  const out = appendPack('MODE.', sparLike);
  assert.doesNotMatch(out, /ABSOLUTE RULES/);
  assert.match(out, /They negotiate hard\./);
});

test('loadPack reports a missing file instead of throwing', () => {
  const res = loadPack(path.join(os.tmpdir(), 'definitely-not-here-' + Date.now() + '.md'));
  assert.strictEqual(res.text, '');
  assert.match(res.error, /not found/);
});

test('loadPack treats an empty path as "no pack configured", not an error', () => {
  const res = loadPack('');
  assert.strictEqual(res.text, '');
  assert.strictEqual(res.error, null);
});

test('loadPack re-reads after the file changes on disk', () => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pack-')), 'pack.md');
  fs.writeFileSync(p, 'first version', 'utf8');
  assert.strictEqual(loadPack(p).text, 'first version');

  // Editing the pack between hotkeys must take effect without an app restart.
  fs.writeFileSync(p, 'second version, longer than the first', 'utf8');
  assert.strictEqual(loadPack(p).text, 'second version, longer than the first');
});
