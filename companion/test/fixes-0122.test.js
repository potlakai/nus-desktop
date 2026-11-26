'use strict';
// Companion 0.1.22, from the feedback of 2026-11-08 to 11-15:
//   - an own key that stopped answering offers one tap to publik;
//   - the empty-balance line names publik's free week with its card and its charge, and no amount;
//   - Nvidia's removed model is retired;
//   - a thank-you, once, for the people who use Nūs the most.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ownKeyStuck, plainAskError } = require('../src/ask-error');
const { createFeedback, thanksText, THANKS_AT, THANKS_WEEK } = require('../src/feedback');

const root = path.resolve(__dirname, '../..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const MONEY = /\$\s?\d|\d\s?(dollars|cents)\b/i;

test('the week\'s real error reports read as "the own key is stuck"; passing trouble does not', () => {
  const stuck = [
    ['gemini', '{"error":{"message":"{\\n \\"error\\": {\\n \\"code\\": 429,\\n \\"message\\": \\"You exceeded your current quota, please check your plan and billing details."}}'],
    ['gemini', '{"error":{"code":403,"message":"Gemini API has not been used in project 1 before or it is disabled."}}'],
    ['', 'cli_spawn_failed: spawn C:/Users/someone/AppData/Roaming/npm/claude ENOENT'],
    ['', 'no AI is set up. Paste a free Gemini key in the Companion settings, or sign in to Claude Code'],
    ['', 'No AI is set up'],
    ['cli', 'cli_not_logged_in'],
    ['anthropic', '400 Your credit balance is too low'],
    ['nvidia', '404 model meta/llama-3.2-11b-vision-instruct not found'],
    ['gemini', 'API key not valid. Please pass a valid API key.'],
  ];
  for (const [p, t] of stuck) assert.equal(ownKeyStuck(p, new Error(t)), true, p + ': ' + t.slice(0, 60));
  const passing = [
    ['gemini', '{"error":{"code":503,"message":"This model is currently experiencing high demand."}}'],
    ['gemini', 'fetch failed'], ['openai', 'ETIMEDOUT'], ['gemini', 'AbortError'], ['anthropic', 'model timed out'],
    ['gemini', 'SAFETY'], ['', ''],
  ];
  for (const [p, t] of passing) assert.equal(ownKeyStuck(p, new Error(t)), false, p + ': ' + t);
  // publik's own failures have their own button (Top up), never this one.
  assert.equal(ownKeyStuck('publik', new Error('429 quota')), false);
});

test('the switch button is wired: answer bubble, guide, the no-AI bubbles, and its handler', () => {
  const index = read('companion/index.js');
  assert.match(index, /function publikSwitchAction\(provider, e\)/);
  assert.match(index, /\.\.\.publikTopUpAction\(e\), \.\.\.publikSwitchAction\(llm && llm\.provider, e\)/, 'the answer bubble');
  assert.equal((index.match(/\.\.\.publikSwitchAction\('', NO_KEY_COPY\)/g) || []).length, 2, 'both no-AI bubbles');
  assert.match(index, /failActions: \(provider, err\) => \[\.\.\.publikTopUpAction\(err\), \.\.\.publikSwitchAction\(provider, err\)\]/, 'the guide (0.1.35: with the paywall buttons too)');
  assert.match(index, /p\.action === 'publik-switch'\) \{ publikSwitch\(\); return; \}/);
  assert.match(index, /label: 'Switch to publik'/);
  const session = read('companion/src/guide/session.js');
  assert.match(session, /this\.d\.failActions\(opts\.provider, opts\.err\)/);
  const main = read('src/main-companion.js');
  assert.match(main, /publikSwitch: \(\) => \{\s*if \(!publik \|\| !publik\.canSwitch\(\)\) return false;/);
  // The unknown-id path in the overlay page forwards the press to the main process.
  assert.match(read('companion/renderer/renderer.js'), /else if \(nus\.guideAsk\) nus\.guideAsk\(\{ action: a\.id, text: '' \}\)/);
});

test('the switch is only offered to someone signed in with publik who answers another way', () => {
  const pub = require('../src/publik');
  const saved = { on: process.env.NUS_PUBLIK, local: process.env.LOCALAPPDATA, key: process.env.PUBLIK_API_KEY };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nus-publik-'));
  const cred = path.join(dir, 'publik', 'apps', 'nus.json');
  const put = (c) => { fs.mkdirSync(path.dirname(cred), { recursive: true }); fs.writeFileSync(cred, JSON.stringify(c)); };
  try {
    process.env.LOCALAPPDATA = dir; delete process.env.PUBLIK_API_KEY;
    if (process.platform !== 'win32') return; // the publik folder follows LOCALAPPDATA on Windows only
    process.env.NUS_PUBLIK = '1';
    assert.equal(pub.canSwitch(), false, 'not signed in on this computer');
    put({ key: 'pk_test_1', choice: 'own_key' }); assert.equal(pub.canSwitch(), true);
    put({ key: 'pk_test_1', choice: null }); assert.equal(pub.canSwitch(), true);
    put({ key: 'pk_test_1', choice: 'publik' }); assert.equal(pub.canSwitch(), false, 'already on publik');
    put({ key: 'pk_test_1', choice: 'own_key' }); pub.setChoice('publik'); assert.equal(pub.choice(), 'publik'); assert.equal(pub.active(), true);
    delete process.env.NUS_PUBLIK;
    put({ key: 'pk_test_1', choice: 'own_key' }); assert.equal(pub.canSwitch(), false, 'a build without publik');
  } finally {
    for (const [k, v] of [['NUS_PUBLIK', saved.on], ['LOCALAPPDATA', saved.local], ['PUBLIK_API_KEY', saved.key]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an empty publik balance: publik\'s message, the free week with its card and charge, no amount of ours', () => {
  const pub = require('../src/publik');
  const e = Object.assign(new Error('402'), { status: 402, error: { message: 'Not enough publik API balance.', top_up_url: 'https://publikhq.com/wallet/add' } });
  const line = plainAskError('publik', e);
  assert.match(line, /^Not enough publik API balance\. /);
  assert.match(line, /free week/); assert.match(line, /needs a card/); assert.match(line, /paid after the week unless you cancel/);
  assert.match(line, /your own key: a free Gemini key works/); assert.match(line, /Voice commands and reminders still work\.$/);
  assert.doesNotMatch(line.replace('Not enough publik API balance. ', ''), MONEY);
  assert.doesNotMatch(line, /—/);
  assert.equal(pub.readError(e).url, 'https://publikhq.com/wallet/add');
});

test('Nvidia\'s removed 11b vision model is retired, in the defaults and in a saved settings file', () => {
  // 0.1.36: the 90b it moved to was ended too (2026-11-16); both now go to Nemotron 3.5 Super VL
  // (companion/test/nvidia-model-0136.test.js loads a saved file through the store).
  const store = read('companion/src/store.js');
  assert.match(store, /nvidia: \{ fast: 'nvidia\/nemotron-3\.5-super-vl-120b-a12b', smart: 'nvidia\/nemotron-3\.5-super-vl-120b-a12b' \}/);
  assert.match(store, /'meta\/llama-3\.2-11b-vision-instruct': 'nvidia\/nemotron-3\.5-super-vl-120b-a12b',/);
});

function rig(asks, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nus-thanks-'));
  const clock = { t: Date.parse('2026-11-15T10:00:00Z') };
  const calls = [];
  const fb = createFeedback({ userData: dir, appVersion: '0.1.22', platform: 'win32', arch: 'x64', packaged: true, env: {},
    installId: () => '11111111-2222-4333-8444-555555555555', fetch: async (url, init) => { calls.push(JSON.parse(init.body)); return { status: 200 }; }, now: () => clock.t });
  for (let i = 0; i < asks; i++) fb.noteAsk('guide');
  return { fb, clock, calls, dir, ...extra };
}

test('the thank-you: once, from the 50th ask, after the day-3 check-in and never after "do not ask again"', () => {
  assert.equal(THANKS_AT, 50);
  const few = rig(49); few.fb.shown('checkin');
  few.clock.t += 86400000; assert.notEqual(few.fb.due(), 'thanks');
  const many = rig(50);
  // The first prompts in line (check-in is not due on day 0; the reaction milestones are) come first, one a day.
  let seen = [];
  for (let day = 0; day < 8; day++) { const d = many.fb.due(); if (d) { seen.push(d); many.fb.shown(d); } many.clock.t += 86400000; }
  assert.equal(seen.filter((d) => d === 'thanks').length, 1, 'shown once: ' + seen.join(','));
  assert.equal(seen[0], 'thanks', 'a heavy user sees the thank-you before another reaction question');
  const never = rig(80); never.fb.never(); assert.equal(never.fb.due(), null);
});

test('the thank-you\'s words: true, plain, and the free week only as publik\'s offer with its card and charge', () => {
  const plain = thanksText(149);
  assert.match(plain, /^You have asked Nūs 149 times on this computer\./);
  assert.match(plain, /among the people who use it the most/); assert.match(plain, /thank you\.$/);
  assert.doesNotMatch(plain, /publik|free week/);
  const week = thanksText(87, { freeWeek: true });
  assert.ok(week.endsWith(THANKS_WEEK));
  assert.match(week, /publik gives new subscribers a free week/); assert.match(week, /needs a card/); assert.match(week, /paid after the week unless you cancel/);
  for (const t of [plain, week]) { assert.doesNotMatch(t, MONEY); assert.doesNotMatch(t, /—/); assert.doesNotMatch(t, /\b(gift|reward|exclusive|just for you|only you)\b/i, 'not sold as a gift from Nūs'); }
  assert.match(thanksText(3), /asked Nūs 50 times/, 'never a smaller number than the one that earns it');
});

test('pressing the thank-you\'s button sends fixed words, never an ask', async () => {
  const r = rig(60);
  await r.fb.thanksOpened();
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].message, 'Thank-you card: opened the free week');
  assert.equal(r.calls[0].diagnostics.collector, 'thanks');
  const index = read('companion/index.js');
  assert.match(index, /which === 'thanks'\) \{\s*thanksCard\(\)/);
  assert.match(index, /id === 'fb-week'\) \{ if \(freeWeekUrl\) shell\.openExternal\(freeWeekUrl\)/);
  assert.match(index, /week = !!w && !\(w\.plan && w\.plan\.kind === 'plan'\)/, 'not offered to someone who already has a plan');
});

test('the build config and publik\'s module carry the same release version', () => {
  const build = /version: '(\d+\.\d+\.\d+)'/.exec(read('electron-builder.companion.config.js'));
  const mod = /const APP_VERSION = "(\d+\.\d+\.\d+)";/.exec(read('companion/src/publik/publik.js'));
  assert.ok(build && mod, 'both name a version');
  assert.equal(mod[1], build[1]);
  assert.equal(build[1], '0.1.39');
});
