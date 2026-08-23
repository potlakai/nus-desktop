const { test } = require('node:test');
const assert = require('node:assert');
const { createQuitGuard } = require('./quit-guard');

function fakeEvent() {
  return {
    prevented: false,
    preventDefault() { this.prevented = true; },
  };
}

test('a successful final save allows quit without prompting', () => {
  let prompts = 0;
  const guard = createQuitGuard({
    flush: () => ({ ok: true }),
    ask: () => { prompts += 1; return 'stay'; },
    retryQuit: () => {},
  });
  const event = fakeEvent();

  assert.equal(guard(event), true);
  assert.equal(event.prevented, false);
  assert.equal(prompts, 0);
});

test('a failed final save keeps the app open by default', async () => {
  let retried = false;
  const guard = createQuitGuard({
    flush: () => ({ ok: false, kind: 'disk_full', message: 'disk full' }),
    ask: () => 'stay',
    retryQuit: () => { retried = true; },
  });
  const event = fakeEvent();

  assert.equal(guard(event), false);
  assert.equal(event.prevented, true);
  assert.equal(retried, false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(retried, false);
});

test('quit without saving is explicit and does not create a quit loop', async () => {
  let flushes = 0;
  let retries = 0;
  const guard = createQuitGuard({
    flush: () => { flushes += 1; return { ok: false, kind: 'locked', message: 'locked' }; },
    ask: () => 'quit_without_saving',
    retryQuit: () => { retries += 1; },
  });
  const first = fakeEvent();

  assert.equal(guard(first), false);
  assert.equal(first.prevented, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(retries, 1);

  const second = fakeEvent();
  assert.equal(guard(second), true);
  assert.equal(second.prevented, false);
  assert.equal(flushes, 1);
});

test('an unexpected flush exception is treated as an unsafe save', () => {
  let seen;
  const guard = createQuitGuard({
    flush: () => { throw new Error('verification exploded'); },
    ask: (outcome) => { seen = outcome; return 'stay'; },
    retryQuit: () => {},
  });
  const event = fakeEvent();

  assert.equal(guard(event), false);
  assert.equal(event.prevented, true);
  assert.equal(seen.kind, 'integrity');
  assert.match(seen.message, /verification exploded/);
});

test('repeated quit attempts do not stack save-failure prompts', async () => {
  let resolvePrompt;
  let prompts = 0;
  const guard = createQuitGuard({
    flush: () => ({ ok: false, kind: 'disk_full', message: 'disk full' }),
    ask: () => {
      prompts += 1;
      return new Promise((resolve) => { resolvePrompt = resolve; });
    },
    retryQuit: () => {},
  });

  assert.equal(guard(fakeEvent()), false);
  assert.equal(guard(fakeEvent()), false);
  assert.equal(prompts, 1);
  resolvePrompt('stay');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(guard(fakeEvent()), false);
  assert.equal(prompts, 2);
  resolvePrompt('stay');
});
