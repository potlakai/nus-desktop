'use strict';
// A person who signed in with publik before opens Nūs when publik does not answer. Anyone else
// meets publik's gate exactly as before. The module under test never touches publik.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { passGate, NO_ANSWER_MS, BACKGROUND_RETRY_MS } = require('../src/publik/offline-pass');

const UNREACHABLE = { id: 'unreachable', buttons: [{ action: 'retry' }] };
const SIGN_IN = { id: 'sign_in', buttons: [{ action: 'sign_in' }] };
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
function fakeUi() {
  const shown = [];
  return { shown, closed: 0, show(screen) { shown.push(screen.id); return new Promise(() => {}); }, openUrl() {}, close() { this.closed += 1; } };
}

test('never signed in: publik is not reachable shows publik\'s own screen, nobody gets through', async () => {
  const ui = fakeUi();
  let settled = false;
  passGate({ ensureSignedIn: (w) => w.show(UNREACHABLE), ui, signedInBefore: () => false, noAnswerMs: 10 }).then(() => { settled = true; });
  await tick(40);
  assert.deepStrictEqual(ui.shown, ['unreachable']);
  assert.strictEqual(settled, false);
});

test('never signed in: the module\'s answer passes straight through', async () => {
  const ui = fakeUi();
  const r = await passGate({ ensureSignedIn: async () => ({ key: 'pk_x', choice: 'own_key' }), ui, signedInBefore: () => false });
  assert.deepStrictEqual(r, { signed: { key: 'pk_x', choice: 'own_key' }, offline: '' });
});

test('signed in before, publik answers: nothing changes', async () => {
  const ui = fakeUi();
  const r = await passGate({ ensureSignedIn: async () => ({ key: 'pk_x', choice: 'publik' }), ui, signedInBefore: () => true, noAnswerMs: 50 });
  assert.deepStrictEqual(r, { signed: { key: 'pk_x', choice: 'publik' }, offline: '' });
  assert.deepStrictEqual(ui.shown, []);
});

test('signed in before, publik not reachable: let through at once, no window, and the module keeps trying quietly', async () => {
  const ui = fakeUi();
  let tries = 0, alive = true;
  const ensureSignedIn = async (w) => { while (alive) { tries += 1; const a = await w.show(UNREACHABLE); assert.strictEqual(a, 'retry'); } };
  const t0 = Date.now();
  const r = await passGate({ ensureSignedIn, ui, signedInBefore: () => true, retryMs: 10, sleep: tick });
  assert.deepStrictEqual(r, { signed: null, offline: 'unreachable' });
  assert.ok(Date.now() - t0 < 200, 'did not wait for a timer');
  assert.deepStrictEqual(ui.shown, [], 'the Retry window never came up');
  await tick(60);
  alive = false;
  assert.ok(tries >= 3, 'retried in the background: ' + tries);
  assert.deepStrictEqual(ui.shown, []);
});

test('signed in before, publik back later in the session: the module finishes and onBack is told', async () => {
  const ui = fakeUi();
  let calls = 0, back = null;
  const ensureSignedIn = async (w) => { for (;;) { calls += 1; if (calls >= 3) return { key: 'pk_x', choice: 'publik' }; await w.show(UNREACHABLE); } };
  const r = await passGate({ ensureSignedIn, ui, signedInBefore: () => true, retryMs: 5, sleep: tick, onBack: (s) => { back = s; } });
  assert.strictEqual(r.offline, 'unreachable');
  await tick(60);
  assert.deepStrictEqual(back, { key: 'pk_x', choice: 'publik' });
});

test('signed in before, publik back but wants a screen (signed out there): no window mid-session', async () => {
  const ui = fakeUi();
  let step = 0;
  const ensureSignedIn = async (w) => { for (;;) { step += 1; await w.show(step === 1 ? UNREACHABLE : SIGN_IN); } };
  const r = await passGate({ ensureSignedIn, ui, signedInBefore: () => true, retryMs: 5, sleep: tick });
  assert.strictEqual(r.offline, 'unreachable');
  await tick(60);
  assert.deepStrictEqual(ui.shown, [], 'sign-in waits for the next start');
});

test('signed in before, publik hangs with no answer: let through after the limit', async () => {
  const ui = fakeUi();
  const t0 = Date.now();
  const r = await passGate({ ensureSignedIn: () => new Promise(() => {}), ui, signedInBefore: () => true, noAnswerMs: 40 });
  assert.deepStrictEqual(r, { signed: null, offline: 'no_answer' });
  assert.ok(Date.now() - t0 >= 35);
});

test('signed in before, but publik answered with a screen this start: nothing lets them through after that', async () => {
  const ui = fakeUi();
  let settled = false;
  const ensureSignedIn = async (w) => { w.show(SIGN_IN); await tick(20); await w.show(UNREACHABLE); };
  passGate({ ensureSignedIn, ui, signedInBefore: () => true, noAnswerMs: 30, retryMs: 5, sleep: tick }).then(() => { settled = true; });
  await tick(120);
  assert.deepStrictEqual(ui.shown, ['sign_in', 'unreachable'], 'both are publik\'s own screens, on the real window');
  assert.strictEqual(settled, false, 'neither the timer nor the unreachable screen opened Nūs');
});

test('a module failure before anyone is through is the caller\'s, as before; after, it is swallowed', async () => {
  const ui = fakeUi();
  await assert.rejects(passGate({ ensureSignedIn: async () => { throw new Error('boom'); }, ui, signedInBefore: () => true }), /boom/);
  const r = await passGate({ ensureSignedIn: async (w) => { await w.show(UNREACHABLE); throw new Error('later'); }, ui, signedInBefore: () => true, retryMs: 5, sleep: tick });
  assert.strictEqual(r.offline, 'unreachable');
  await tick(30);
});

test('a broken signedInBefore counts as never signed in', async () => {
  const ui = fakeUi();
  let settled = false;
  passGate({ ensureSignedIn: (w) => w.show(UNREACHABLE), ui, signedInBefore: () => { throw new Error('disk'); }, noAnswerMs: 10 }).then(() => { settled = true; });
  await tick(40);
  assert.strictEqual(settled, false);
  assert.deepStrictEqual(ui.shown, ['unreachable']);
});

test('the limits, and the wiring in the app', () => {
  assert.ok(NO_ANSWER_MS < 15000, 'under the module\'s own 15 s timeout');
  assert.strictEqual(BACKGROUND_RETRY_MS, 60000);
  const root = path.join(__dirname, '..', '..');
  const main = fs.readFileSync(path.join(root, 'src', 'main-companion.js'), 'utf8');
  assert.match(main, /passGate\(\{ ensureSignedIn: \(gateUi\) => publik\.module\.ensureSignedIn\(gateUi\), ui, signedInBefore: publik\.signedInBefore/);
  assert.match(main, /if \(gate\.offline\) \{[^}]*gateCount\.screen\('unreachable'\); \}/, 'a start with publik down is still counted');
  const index = fs.readFileSync(path.join(root, 'companion', 'src', 'publik', 'index.js'), 'utf8');
  assert.match(index, /function signedInBefore\(\) \{ return on\(\) && !process\.env\.PUBLIK_API_KEY && !!choice\(\); \}/);
  // publik's own module is not touched by this: the gate's words and its loop are still theirs.
  const mod = fs.readFileSync(path.join(root, 'companion', 'src', 'publik', 'publik.js'), 'utf8');
  assert.doesNotMatch(mod, /offline-pass|signedInBefore/);
  assert.match(mod, /publik is not reachable\. Check your connection\./);
});
