'use strict';
// 0.1.35. publik's paywall (402, "Your publik balance is too low") is where a person's free use
// ends. Until now the bubble's only button was Top up, a screen ask had no button at
// all, and a person who did paste a key kept getting the 402: publik answers while the stored
// choice is "publik", whatever keys are saved.
// Nothing here touches publik's sign-in: it is the same switch as "Use my own key or Claude Code"
// in Settings, Keys.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const P = require('../src/publik');

const root = path.join(__dirname, '..', '..');
// Read with LF whatever the checkout's line endings are: functions are lifted out by their text.
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8').replace(/\r\n/g, '\n');
const index = read('companion', 'index.js');
const main = read('src', 'main-companion.js');
const e402 = () => Object.assign(new Error('402 Not enough publik API balance.'), { status: 402, error: { message: 'Not enough publik API balance.', top_up_url: 'https://publikhq.com/wallet/add' } });

// publikTopUpAction lives in the Electron main file; it is lifted out with what it needs.
function topUpAction(hooks) {
  const src = /function publikTopUpAction\(e\) \{[\s\S]*?\n\}\n/.exec(index);
  assert.ok(src, 'publikTopUpAction');
  // eslint-disable-next-line no-new-func
  return new Function('require', 'hooks', 'let publikTopUp = null;\n' + src[0] + '\nreturn (e) => ({ actions: publikTopUpAction(e), url: publikTopUp });')((id) => (id === './src/publik' ? P : require(id)), hooks);
}

test('the paywall bubble: the person\'s own key first, then publik\'s top-up link', () => {
  let met = 0;
  const act = topUpAction({ publikPaywall: () => { met += 1; } });
  const r = act(e402());
  assert.deepEqual(r.actions, [{ id: 'publik-own-key', label: 'Use my own key' }, { id: 'publik-topup', label: 'Top up' }]);
  assert.equal(r.url, 'https://publikhq.com/wallet/add');
  assert.equal(met, 1, 'the host is told the wall was met');
});

test('with no link from publik the own-key button is still there; a link that is not https is never opened', () => {
  const act = topUpAction({});
  const noLink = Object.assign(new Error('402'), { status: 402, error: { message: 'Not enough publik API balance.' } });
  assert.deepEqual(act(noLink).actions, [{ id: 'publik-own-key', label: 'Use my own key' }]);
  const bad = Object.assign(new Error('402'), { status: 402, error: { message: 'x', top_up_url: 'file:///c:/x' } });
  const r = act(bad);
  assert.deepEqual(r.actions.map((a) => a.id), ['publik-own-key']); assert.equal(r.url, null);
});

test('any other error gets neither button, and the host is not told', () => {
  let met = 0;
  const act = topUpAction({ publikPaywall: () => { met += 1; } });
  for (const e of [Object.assign(new Error('401'), { status: 401 }), Object.assign(new Error('fetch failed'), { name: 'APIConnectionError' }), new Error('boom'), null]) assert.deepEqual(act(e).actions, []);
  assert.equal(met, 0);
});

test('a host that throws on the note does not lose the buttons', () => {
  const act = topUpAction({ publikPaywall: () => { throw new Error('no'); } });
  assert.equal(act(e402()).actions.length, 2);
});

test('the words: a free Gemini key keeps it going; publik\'s message and its free week stay', () => {
  const line = P.errorLine(e402());
  assert.match(line, /^Not enough publik API balance\. /);
  assert.ok(line.includes(P.FREE_WEEK_402));
  assert.match(line, /Or keep going for free with your own key: a free Gemini key works\./);
  assert.match(line, /Voice commands and reminders still work\.$/);
  assert.ok(!/[\u2014\u2013]/.test(line));
});

test('every kind of ask shows the buttons: the typed or spoken ask and the screen ask', () => {
  assert.match(index, /actions: \[\{ id: 'dismiss', label: 'OK', primary: true \}, \.\.\.publikTopUpAction\(e\), \.\.\.publikSwitchAction\(/);
  assert.match(index, /failActions: \(provider, err\) => \[\.\.\.publikTopUpAction\(err\), \.\.\.publikSwitchAction\(provider, err\)\]/);
  assert.match(index, /if \(p && p\.action === 'publik-own-key'\) \{ publikOwnKey\(\); return; \}/);
});

test('the button: switched says so; otherwise Settings opens at Keys and says what to paste', () => {
  const fn = /function publikOwnKey\(\) \{[\s\S]*?\n\}\n/.exec(index);
  assert.ok(fn, 'publikOwnKey');
  const run = (answer, extra = {}) => {
    const said = [], opened = [];
    const hooks = Object.assign({ publikOwnKey: () => answer, showSettings: (s) => opened.push(s) }, extra);
    // eslint-disable-next-line no-new-func
    const r = new Function('hooks', 'flash', 'routeLog', 'OWN_KEY_NOW', 'OWN_KEY_PASTE', fn[0] + '\nreturn publikOwnKey();')(hooks, (t) => said.push(t), () => {}, 'NOW', 'PASTE');
    return { r, said, opened };
  };
  assert.deepEqual(run('switched'), { r: 'switched', said: ['NOW'], opened: [] });
  assert.deepEqual(run('needs_key'), { r: 'needs_key', said: ['PASTE'], opened: ['keys'] });
  assert.deepEqual(run('no'), { r: 'no', said: ['PASTE'], opened: ['keys'] }, 'never a dead button');
  assert.deepEqual(run(null, { publikOwnKey: () => { throw new Error('x'); } }), { r: 'no', said: ['PASTE'], opened: ['keys'] });
  assert.match(index, /const OWN_KEY_NOW = 'Your own key answers now\. Ask again\.';/);
  assert.match(index, /const OWN_KEY_PASTE = 'Paste a key in Settings, Keys\. A free Gemini key works\. Nūs switches to it by itself\.';/);
});

test('the app: the answers move only when publik was answering, a key for the chosen provider is saved, and the wall was met', () => {
  const fn = /function answerWithOwnKey\(\) \{[\s\S]*?\n\}\n/.exec(main);
  assert.ok(fn, 'answerWithOwnKey');
  const run = ({ choice = 'publik', ready = true, sticks = true } = {}) => {
    const calls = [];
    const publik = { choice: () => choice, setChoice: (c) => { calls.push('set:' + c); if (sticks) choice = c; } };
    // eslint-disable-next-line no-new-func
    const out = new Function('publik', 'ownKeyReady', 'stats', 'send', 'publicSettings', 'let paywallMet = true;\n' + fn[0] + '\nconst r = answerWithOwnKey(); return { r, paywallMet };')(
      publik, () => ready, { aiSource: (c) => calls.push('stat:' + c) }, (ch) => calls.push('send:' + ch), () => ({}));
    return Object.assign(out, { calls, choice });
  };
  assert.deepEqual(run(), { r: true, paywallMet: false, calls: ['set:own_key', 'stat:own_key', 'send:home:settings'], choice: 'own_key' });
  assert.deepEqual(run({ ready: false }), { r: false, paywallMet: true, calls: [], choice: 'publik' }, 'no key yet: nothing moves');
  assert.deepEqual(run({ choice: 'own_key' }), { r: false, paywallMet: true, calls: [], choice: 'own_key' }, 'already on their own key');
  assert.equal(run({ sticks: false }).r, false, 'a choice that could not be saved is not called a switch');
  // A pasted key takes over only after the wall was met in this run.
  assert.match(main, /if \(paywallMet && Object\.values\(clean\.apiKeys \|\| \{\}\)\.some\(Boolean\) && answerWithOwnKey\(\)\) \{ try \{ companion\.ownKeyTookOver\(\); \}/);
  assert.match(main, /publikPaywall: \(\) => \{ if \(publik && publik\.active\(\)\) paywallMet = true; \},/);
  assert.match(main, /publikOwnKey: \(\) => \{\s+if \(!publik \|\| !publik\.active\(\)\) return 'no';\s+paywallMet = true;\s+return answerWithOwnKey\(\) \? 'switched' : 'needs_key';\s+\},/);
  assert.match(main, /function ownKeyReady\(\) \{ try \{ const s = store\.getSettings\(\); return !!String\(\(s\.apiKeys \|\| \{\}\)\[s\.provider\] \|\| ''\)\.trim\(\); \}/);
  assert.match(index, /ownKeyTookOver: \(\) => flash\(OWN_KEY_NOW, 4500\),/);
});

test('publik\'s sign-in is not touched: no way past the gate was added', () => {
  const pass = fs.readFileSync(path.join(root, 'companion', 'src', 'publik', 'offline-pass.js'), 'utf8');
  assert.ok(!/cap_own_key|onOwnKeyToday/.test(pass + main + index), 'the own-key start at the cap is not in this build');
  const gate = fs.readFileSync(path.join(root, 'companion', 'src', 'publik', 'gate-window.js'), 'utf8');
  assert.ok(!/Full for today|own key for now/i.test(gate.replace(/^\/\/.*$/gm, '')), 'no cap screen, no own-key button on the sign-in window');
});
