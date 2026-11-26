'use strict';
// 0.1.40 work: a third of new installs picked "Use my own key" at the sign-in window and a third of
// those never got an answer (read 2026-11-24, conditor/own-key-0140). Three changes:
//   1. which choose screen publik showed is counted (free use or a balance, a plan, none left);
//   2. "Use my own key" with publik's free use waiting and no key on this computer gets one check
//      first, in our window, with publik's own button labels; a second press goes through;
//   3. with nothing to answer, the tour's AI card comes right after the hello, with "Get a free key".
// Nothing here lets anyone past the gate: the module still decides, with the same two actions.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const mod = require('../src/publik/publik');
const G = require('../src/publik/gate-window');
const Tour = require('../src/tour');
const { STEPS } = require('../src/stats');

const root = path.join(__dirname, '..', '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8').replace(/\r\n/g, '\n');
const wallet = (o) => Object.assign({ plan: { kind: 'none' }, balance_micros: 0, account: { handle: 'someone' } }, o);
const freeScreen = () => mod.gateScreen('choose', wallet({ balance_micros: 200000 }));
const emptyScreen = () => mod.gateScreen('choose', wallet({ balance_micros: 0 }));
const planScreen = () => mod.gateScreen('choose', wallet({ plan: { kind: 'plan', label: 'Basic' } }));

test('the no-key check: our headline and line, publik\'s own labels, free asks first', () => {
  const v = G.view(freeScreen(), { confirmOwnKey: true });
  assert.equal(v.state, 'no_key');
  assert.equal(v.headline, 'No AI key on this computer yet');
  assert.match(v.line, /publik's free asks answer right now\. You can switch to your own key any time, in Settings\./);
  assert.deepEqual(v.buttons.map((b) => [b.action, b.label, b.primary]), [['connect', 'Connect your plan', true], ['own_key', 'Use my own key', false]], 'labels exactly as publik gives them');
  assert.equal(v.buttons[0].caption, 'Free. Starts Nūs.');
  assert.equal(v.buttons[1].caption, 'Only if you have a key or Claude Code');
  for (const s of [v.headline, v.line, ...v.buttons.map((b) => b.caption)]) assert.doesNotMatch(s, /[—–]/, 'no dashes');
  // No free use left: there is nothing else to offer, so the check never draws.
  assert.equal(G.view(emptyScreen(), { confirmOwnKey: true }).state, 'no_balance');
  assert.equal(G.view(freeScreen()).state, 'in', 'without the flag, the screen is as before');
});

function fakeElectron() {
  const made = [], handlers = {};
  class BrowserWindow {
    constructor() { this.calls = []; this.sent = []; this.destroyed = false; made.push(this);
      this.webContents = { isLoading: () => false, send: (ch, v) => { this.sent.push(v); this.last = v; }, once() {} }; }
    loadFile() {} on() {} once() {} isDestroyed() { return this.destroyed; } destroy() { this.destroyed = true; }
    show() {} focus() {} moveTop() {} isMinimized() { return false; } restore() {} minimize() {} isFocused() { return true; } isVisible() { return true; }
    setAlwaysOnTop() {} isAlwaysOnTop() { return false; } flashFrame() {}
  }
  const ipcMain = { on(ch, f) { handlers[ch] = f; }, removeListener() {} };
  return { made, handlers, electron: { BrowserWindow, ipcMain, shell: { openExternal() {} }, app: { quit() {}, focus() {} } } };
}
function gateWith(opts) {
  const fake = fakeElectron();
  const id = require.resolve('electron');
  const before = require.cache[id];
  require.cache[id] = { id, filename: id, loaded: true, exports: fake.electron };
  try { return Object.assign({ ui: G.createGateUI(Object.assign({ sleep: async () => {}, now: () => 0 }, opts)) }, fake); }
  finally { if (before) require.cache[id] = before; else delete require.cache[id]; }
}
const press = (g, action) => g.handlers['publik-gate:press']({ sender: g.made[0].webContents }, action);
const tick = () => new Promise((r) => setImmediate(r));

test('no key on this computer: the first "Use my own key" draws the check, the second goes through', async () => {
  const seen = { plan: [], noKey: 0, press: [] };
  const g = gateWith({ hasOwnAnswer: () => false, onPlan: (k) => seen.plan.push(k), onNoKey: () => { seen.noKey++; }, onPress: (a) => seen.press.push(a) });
  const answer = g.ui.show(freeScreen());
  await tick();
  assert.deepEqual(seen.plan, ['balance'], 'the kind of choose screen is counted once');
  press(g, 'own_key');
  assert.equal(g.made[0].last.state, 'no_key', 'the check is drawn');
  assert.equal(seen.noKey, 1);
  assert.equal(await Promise.race([answer, new Promise((r) => setTimeout(() => r('waiting'), 20))]), 'waiting', 'nothing resolved yet');
  press(g, 'own_key');
  assert.equal(await answer, 'own_key', 'the second press is the person\'s choice, as before');
  assert.deepEqual(seen.press, ['own_key']);
  g.ui.close();
});

test('the check\'s free asks button is publik\'s own connect', async () => {
  const g = gateWith({ hasOwnAnswer: () => false });
  const answer = g.ui.show(freeScreen());
  await tick();
  press(g, 'own_key');
  press(g, 'connect');
  assert.equal(await answer, 'connect');
  g.ui.close();
});

test('no check when a key is saved, when the account has no free use, or with no way to ask', async () => {
  for (const [opts, screen, kind] of [[{ hasOwnAnswer: () => true }, freeScreen(), 'balance'], [{ hasOwnAnswer: () => false }, emptyScreen(), 'none'], [{}, freeScreen(), 'balance'], [{ hasOwnAnswer: () => false }, planScreen(), 'plan']]) {
    const plans = [];
    const g = gateWith(Object.assign({ onPlan: (k) => plans.push(k) }, opts));
    const answer = g.ui.show(screen);
    await tick();
    assert.deepEqual(plans, [kind]);
    if (kind === 'plan') { press(g, 'own_key'); assert.equal(g.made[0].last.state, 'no_key', 'a plan answers too: the check draws'); press(g, 'own_key'); }
    else press(g, 'own_key');
    assert.equal(await answer, 'own_key');
    g.ui.close();
  }
});

test('the host counts the screen kinds as onboarding steps and says whether a key is saved', () => {
  for (const s of ['door_balance', 'door_plan', 'door_empty', 'door_nokey_seen', 'tour_ai_first', 'tour_get_key']) assert.ok(STEPS.includes(s), s);
  const main = read('src/main-companion.js');
  assert.match(main, /plan: kind => \{ stats\.onboardingStep\(kind === 'plan' \? 'door_plan' : kind === 'balance' \? 'door_balance' : 'door_empty'\); \}/);
  assert.match(main, /noKey: \(\) => \{ stats\.onboardingStep\('door_nokey_seen'\); \}/);
  assert.match(main, /onPlan: gateCount\.plan, onNoKey: gateCount\.noKey,\n\s+\/\/[^\n]*\n\s+hasOwnAnswer: \(\) => anyKeySaved\(\) \}\);/);
  assert.match(main, /const gateCount = SMOKE \? \{ screen\(\) \{\}, press\(\) \{\}, passed\(\) \{\}, plan\(\) \{\}, noKey\(\) \{\} \}/, 'a test run counts nothing');
  assert.doesNotMatch(read('companion/src/publik/publik.js'), /no_key|NO_KEY|hasOwnAnswer/, 'publik\'s module is not touched');
});

test('the tour: with nothing to answer, the AI card right after the hello, then card 1, and never twice', () => {
  assert.equal(Tour.aiFirst({ aiKnown: true }), true);
  assert.equal(Tour.aiFirst({}), false, 'not before the host has said who answers');
  for (const c of [{ keyReady: true }, { cli: true }, { publik: true }]) assert.equal(Tour.aiFirst(Object.assign({ aiKnown: true }, c)), false, JSON.stringify(c));
  // tourNextStep from index.js, run on a stand-in tour.
  const src = read('companion/index.js');
  const fn = src.slice(src.indexOf('function tourNextStep() {'), src.indexOf('function tourNext() {'));
  const steps = [];
  const run = (caps) => {
    const ctx = { tour: { step: Tour.STEP.hello, caps }, noted: [] };
    const next = new Function('Tour', 'ctx', 'noteStep', 'let tour = ctx.tour;\n' + fn + '\nreturn () => { tour.step = tourNextStep(); return tour.step; };')(Tour, ctx, (s) => ctx.noted.push(s));
    const seq = []; for (let i = 0; i < 12 && ctx.tour.step < Tour.OF; i++) seq.push(next());
    return { seq, noted: ctx.noted };
  };
  const S = Tour.STEP;
  const none = run({ aiKnown: true });
  assert.deepEqual(none.seq, [S.ai, S.mic, S.key, S.questions, S.home, S.sharing, S.guide, S.hands, S.dashboard, S.done]);
  assert.deepEqual(none.noted, ['tour_ai_first']);
  const pub = run({ aiKnown: true, publik: true });
  assert.deepEqual(pub.seq, [S.mic, S.key, S.questions, S.home, S.sharing, S.ai, S.guide, S.hands, S.dashboard, S.done], 'publik answers: the tour as before');
  steps.push(none, pub);
});

test('the AI card offers "Get a free key", which opens AI Studio and waits for the paste', () => {
  const c = Tour.card(Tour.STEP.ai, { caps: {} });
  assert.deepEqual(c.actions.map((a) => a.id), ['tour-get-key', 'tour-next']);
  assert.equal(c.actions[0].label, 'Get a free key');
  assert.equal(c.input.action, 'tour-key');
  assert.doesNotMatch(Tour.GET_KEY_LINE, /[—–]/);
  const src = read('companion/index.js');
  assert.match(src, /action === 'tour-get-key' && tour\.step === S\.ai\) \{ noteStep\('tour_get_key'\); shell\.openExternal\('https:\/\/aistudio\.google\.com\/apikey'\)/);
  assert.match(src, /T\.caps\.source = !!\(r\.cli \|\| r\.key\); T\.caps\.aiKnown = true;/);
  assert.ok(Tour.card(Tour.STEP.ai, { caps: { publik: true } }).actions.every((a) => a.id !== 'tour-get-key'), 'not when publik answers');
});

test('a new account with the free $0.20 reads as free, with Free. Starts Nūs. under Connect', () => {
  const v = G.view(freeScreen());
  assert.equal(v.state, 'in');
  assert.equal(v.line, 'About 450 asks for free. Nothing to buy.', 'not "on your publik balance", which reads like paying');
  assert.equal(v.buttons.find((b) => b.action === 'connect').caption, 'Free. Starts Nūs.');
  const paid = G.view(mod.gateScreen('choose', wallet({ balance_micros: 5000000 })));
  assert.match(paid.line, /on your publik balance\.$/, 'a balance above the grant is a balance');
  assert.equal(paid.buttons.find((b) => b.action === 'connect').caption, 'Starts Nūs.');
});
