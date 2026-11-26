'use strict';
// A failed ask becomes one sentence, never provider JSON (companion/src/ask-error.js).
// The raw strings below are the ones users sent from the error bubble, 2026-10-23 to 10-27.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { plainAskError, providerName } = require('../src/ask-error');
const { friendlyError } = require('../src/guide/assignment');

const GEMINI_429 = '{"error":{"message":"{\\n  \\"error\\": {\\n    \\"code\\": 429,\\n    \\"message\\": \\"You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.\\",\\n    \\"status\\": \\"RESOURCE_EXHAUSTED\\"\\n  }\\n}\\n","code":429,"status":"Too Many Requests"}}';
const GEMINI_503 = '{"error":{"message":"{\\n  \\"error\\": {\\n    \\"code\\": 503,\\n    \\"message\\": \\"This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.\\",\\n    \\"status\\": \\"UNAVAILABLE\\"\\n  }\\n}\\n","code":503,"status":"Service Unavailable"}}';
const CLI_402 = 'cli_failed: API Error: 402 This request requires more credits, or fewer max_tokens. You requested up to 64000 tokens, but can only afford 3839.';
const ANTHROPIC_CREDIT = '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}';

function plain(s) {
  assert.ok(!/[{}"]|\\n/.test(s), 'no JSON in: ' + s);
  assert.ok(s.length < 220, 'one or two sentences: ' + s);
  assert.ok(!/[–—]/.test(s), 'no dashes: ' + s);
}

test('the feedback errors read as plain sentences', () => {
  const quota = plainAskError('gemini', GEMINI_429);
  plain(quota);
  assert.match(quota, /free Gemini key hit its limit/);
  const busy = plainAskError('gemini', new Error(GEMINI_503));
  plain(busy);
  assert.match(busy, /Gemini is busy right now/);
  const credits = plainAskError('claude (desktop)', CLI_402);
  plain(credits);
  assert.match(credits, /Claude Code is out of credits/);
  const anth = plainAskError('anthropic', ANTHROPIC_CREDIT);
  plain(anth);
  assert.match(anth, /Anthropic is out of credits/);
  const net = plainAskError('gemini', 'fetch failed');
  plain(net);
  assert.match(net, /could not reach Gemini\. Check your internet/);
});

test('the provider name comes from the id, or from the text when the id is missing', () => {
  assert.equal(providerName('nvidia', ''), 'Nvidia');
  assert.equal(providerName('', 'cli_failed: boom'), 'Claude Code');
  assert.equal(providerName(undefined, 'generativelanguage.googleapis.com said no'), 'Gemini');
  assert.equal(providerName('', 'boom'), '');
  assert.match(plainAskError('', 'ECONNRESET'), /^I could not reach the AI\./);
  assert.match(plainAskError('', '429'), /^The AI hit its usage limit/);
});

test('each kind of failure gets its own next step', () => {
  assert.match(plainAskError('anthropic', '401 authentication_error: invalid x-api-key'), /did not accept your key[\s\S]*Settings > Keys/);
  assert.match(plainAskError('gemini', 'API key not valid. Please pass a valid API key.'), /Gemini did not accept your key/);
  assert.match(plainAskError('nvidia', '404 model not found'), /Nvidia no longer offers the model/);
  assert.match(plainAskError('claude (desktop)', 'cli_timeout'), /Claude Code took too long/);
  assert.match(plainAskError('claude (desktop)', 'cli_spend_limit'), /out of usage on your plan/);
  assert.match(plainAskError('', 'cli_failed: Failed to authenticate: OAuth session expired'), /signed out[\s\S]*free Gemini key[\s\S]*Settings, Keys/);
  assert.match(plainAskError('gemini', 'incomplete model reply: MAX_TOKENS'), /cut off/);
  assert.match(plainAskError('gemini', 'something odd'), /Something went wrong getting an answer from Gemini\. Ask again/);
});

test('our own no-key sentence passes through unchanged', () => {
  const NO_KEY = 'No AI is set up yet. Add a free Gemini key or an Anthropic key under Settings > Keys in the Nūs Companion window, or sign in to Claude Code. The checklist there tests each one.';
  assert.equal(plainAskError('', new Error(NO_KEY)), NO_KEY);
});

test('assignment mode falls back to the plain sentence, not the raw error', () => {
  const s = friendlyError(new Error(GEMINI_503));
  plain(s);
  assert.match(s, /busy right now/);
});
