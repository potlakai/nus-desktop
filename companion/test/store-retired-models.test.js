// Saved settings beat DEFAULTS on merge, so a model ID that stopped existing
// must be rewritten on load or every Companion answer 404s after an upgrade.
const test = require('node:test');
const assert = require('node:assert');

function loadStore() {
  // store.js needs electron's app/safeStorage at require time; stub them.
  const Module = require('node:module');
  const real = Module._load;
  Module._load = function (req, ...rest) {
    if (req === 'electron') {
      return { app: { getPath: () => require('node:os').tmpdir() }, safeStorage: { isEncryptionAvailable: () => false } };
    }
    return real.call(this, req, ...rest);
  };
  try { return require('../src/store'); } finally { Module._load = real; }
}

test('retired Gemini and Anthropic model IDs are rewritten to the current defaults', () => {
  const store = loadStore();
  const settings = { models: {
    gemini: { fast: 'gemini-2.5-flash', smart: 'gemini-2.5-pro' },
    anthropic: { fast: 'claude-3-5-haiku-latest', smart: 'claude-sonnet-5' },
    openai: { fast: 'gpt-4o-mini', smart: 'gpt-4o' },
  } };
  assert.equal(store._retireDeadModels(settings), true);
  assert.deepEqual(settings.models.gemini, { fast: 'gemini-3.6-flash', smart: 'gemini-3.6-pro' });
  assert.deepEqual(settings.models.anthropic, { fast: 'claude-haiku-4-5', smart: 'claude-sonnet-5' });
  assert.deepEqual(settings.models.openai, { fast: 'gpt-4o-mini', smart: 'gpt-4o' });
});

test('current model IDs are left alone and report no change', () => {
  const store = loadStore();
  const settings = { models: { gemini: { fast: 'gemini-3.6-flash', smart: 'gemini-3.6-pro' } } };
  assert.equal(store._retireDeadModels(settings), false);
  assert.equal(settings.models.gemini.fast, 'gemini-3.6-flash');
});
