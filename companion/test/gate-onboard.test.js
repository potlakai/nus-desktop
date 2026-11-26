'use strict';
// The sign-in window for a brand-new person (onboard-0120): the friend test of 2026-11-11, then
// Pranav's picks the same evening. Large type, few words, his line ("About 100 asks for free, no
// card. Sign in to get started."), and publik's plan named in big type right on the sign-in screen:
// "You do not need to buy publik's plan." Publik's own titles and button labels are never changed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const mod = require('../src/publik/publik');
const G = require('../src/publik/gate-window');

const wallet = (over) => Object.assign({ claim_state: 'claimed', account: null, plan: { kind: 'none', label: null }, balance_micros: 0, top_up_url: 'https://publikhq.com/wallet' }, over);
const SALES = /\b(buy|purchase|pay|subscribe|upgrade|pricing)\b/i;
const count = (t) => t.split(/\s+/).filter(Boolean).length;

test('the first screen, both wordings: his line, publik\'s plan named in big type, the steps, Publik\'s labels kept', () => {
  for (const key of Object.keys(G.WORDING)) {
    const screen = mod.gateScreen('sign_in', null);
    const v = G.view(screen, { wording: key });
    const all = v.nus.join(' ') + ' ' + v.buttons.map((b) => b.caption).join(' ');
    assert.equal(v.state, 'sign_in');
    assert.equal(v.headline, 'Free to start');
    assert.match(v.line, /^About 100 asks for free, no card\. Sign in to get (started|your free asks)\.$/, key);
    assert.equal(v.callout, 'You do not need to buy publik\'s plan.', key + ': whose plan, and that buying it is not needed, on this screen');
    assert.deepEqual(v.steps, ['Sign in', 'Skip publik\'s plan', 'Back to Nūs']); assert.equal(v.step, 1);
    assert.match(all, /Opens your browser/, key + ': a page opens in the browser');
    assert.match(all, /Back to Nūs/, key + ': coming back');
    assert.ok(count(v.line) <= 14, key + ' line is short');
    assert.doesNotMatch(all, /—/, 'no em dashes');
    assert.equal(v.title, screen.title); assert.equal(v.footnote, '', 'Publik\'s repeated sentence is not drawn');
    assert.equal(v.buttons[0].label, 'Sign in with publik'); assert.equal(v.buttons[0].primary, true);
  }
  assert.equal(G.WORDING_PICK, 'A');
});

test('waiting in the browser: the plan line again, step 2 lit, the button quieter', () => {
  const v = G.view(mod.gateScreen('sign_in', null, 'Waiting for you to sign in in your browser.'));
  assert.equal(v.state, 'waiting');
  assert.deepEqual(v.nus.slice(0, 3), G.WAITING_LINES);
  assert.equal(v.callout, 'publik will show you a plan. You do not need to buy it.');
  assert.equal(v.step, 2);
  assert.equal(v.note, '', 'Publik\'s waiting note (with its doubled "in") is not drawn; the headline says it');
  assert.doesNotMatch(v.nus.join(' '), /\bin in\b/);
  assert.equal(v.buttons[0].label, 'Sign in with publik'); assert.equal(v.buttons[0].primary, false);
});

test('a new account with the free $0.05: You\'re in, about 100 asks, Connect leads, own key is small', () => {
  const screen = mod.gateScreen('choose', wallet({ balance_micros: 50000, account: { handle: 'newperson' } }));
  const v = G.view(screen);
  assert.equal(v.state, 'in'); assert.equal(v.headline, 'You\'re in'); assert.equal(v.step, 3);
  assert.equal(v.title, 'Connect your plan', 'Publik\'s title stays'); assert.equal(v.footnote, 'Signed in as @newperson.');
  assert.equal(v.line, 'About 100 asks for free. Nothing to buy.');
  const [connect, own] = v.buttons;
  assert.equal(connect.label, 'Connect your plan'); assert.equal(connect.primary, true); assert.match(connect.caption, /^Free\./);
  assert.equal(own.label, 'Use my own key'); assert.equal(own.small, true); assert.equal(own.primary, false);
  for (const t of [v.line, connect.caption]) assert.doesNotMatch(t.replace(/nothing to buy/i, ''), SALES, t);
  assert.match(v.privacy, /picture of your screen/, 'what gets sent is one click away');
});

test('a bigger balance and a plan read as what they are, never as free', () => {
  const big = G.view(mod.gateScreen('choose', wallet({ balance_micros: 1_000_050_000 })));
  assert.equal(big.line, 'Plenty of asks on your publik balance.'); assert.doesNotMatch(big.buttons[0].caption, /free/i);
  const plan = G.view(mod.gateScreen('choose', wallet({ plan: { kind: 'plan', label: 'Basic' } })));
  assert.equal(plan.state, 'in'); assert.equal(plan.line, 'Your publik plan (Basic) answers in Nūs.');
});

test('no amount of money is ever drawn, on any screen of the window (0.1.22, publik\'s rule)', () => {
  const screens = [mod.gateScreen('sign_in', wallet({})), mod.gateScreen('sign_in', wallet({}), 'Waiting for you to sign in in your browser.'),
    mod.gateScreen('choose', wallet({ balance_micros: 50000 })), mod.gateScreen('choose', wallet({ balance_micros: 1_000_050_000 })),
    mod.gateScreen('choose', wallet({ balance_micros: 7_300_000 })), mod.gateScreen('choose', wallet({ plan: { kind: 'plan', label: 'Basic' } })), mod.gateScreen('choose', wallet({}))];
  for (const s of screens) {
    const v = G.view(s);
    const ours = [...v.nus, v.footnote, v.privacy, ...v.buttons.map((b) => b.caption)].join(' ');
    assert.doesNotMatch(ours, /\$\s?\d|\d\s?(dollars|cents)\b/i, v.state + ': ' + ours);
  }
});

test('publik\'s newer plan words, with no amount in them, still read as ready and promise no number', () => {
  const body = 'You are signed in as @newperson. You have publik use ready. Connect it to use AI in this app, or use your own key.';
  assert.deepEqual(G.readPlan({ body }), { kind: 'balance', usd: null, plan: '' });
  const v = G.view({ id: 'choose', title: 'Connect your plan', body, note: null, buttons: [{ action: 'connect', label: 'Connect your plan' }, { action: 'own_key', label: 'Use my own key' }] });
  assert.equal(v.state, 'in'); assert.equal(v.line, 'Your publik account is ready to answer in Nūs.');
  assert.doesNotMatch(v.line, /\d/); assert.equal(v.buttons[0].caption, 'Starts Nūs.');
});

test('no balance left: honest, the own key leads, and the plan button is publik\'s free week with its card and charge said', () => {
  const screen = mod.gateScreen('choose', wallet({}));
  assert.equal(screen.title, 'Choose how to pay for AI');
  const v = G.view(screen);
  assert.equal(v.state, 'no_balance'); assert.equal(v.line, G.NO_BALANCE_LINE);
  assert.deepEqual(v.buttons.map((b) => b.label), ['Use my own key', 'Get a plan']);
  assert.equal(v.buttons[0].primary, true); assert.equal(v.buttons[1].caption, G.FREE_WEEK_CAPTION);
  assert.equal(v.callout, G.FREE_WEEK_LINE);
  // The week is free, and the words say what it costs to take it: a card now, a charge after.
  assert.match(v.callout, /free week/); assert.match(v.callout, /needs a card/); assert.match(v.callout, /paid after the week unless you cancel/);
  assert.match(v.buttons[1].caption, /then paid/);
});

test('publik not reachable: its own sentence is the line, Retry the button', () => {
  const v = G.view(mod.gateScreen('unreachable', null));
  assert.equal(v.state, 'unreachable'); assert.equal(v.line, 'publik is not reachable. Check your connection.');
  assert.deepEqual(v.buttons.map((b) => b.label), ['Retry']);
});

test('the balance is read from Publik\'s own words, and asks are rounded down', () => {
  assert.deepEqual(G.readPlan({ body: 'You are signed in to publik. Your balance: $0.05. Connect it to use AI in this app, or use your own key.' }), { kind: 'balance', usd: 0.05, plan: '' });
  assert.equal(G.readPlan({ body: 'Your plan: Basic. Connect it' }).plan, 'Basic');
  assert.equal(G.readPlan({ body: 'Your balance: $0.00.' }).kind, 'none');
  assert.equal(G.asksFor(0.05), 'about 100 asks');
  assert.equal(G.asksFor(0.02), 'about 40 asks');
  assert.equal(G.asksFor(0.002), 'about 4 asks');
  assert.equal(G.asksFor(0.0001), '');
  assert.equal(G.asksFor(5), 'plenty of asks');
});

test('comes forward only when the sign-in lands: sign-in screen to plan screen', () => {
  const choose = mod.gateScreen('choose', wallet({ balance_micros: 50000 }));
  assert.equal(G.comesForward('sign_in', choose), true);
  assert.equal(G.comesForward('', choose), false, 'a start already signed in is not pulled forward');
  assert.equal(G.comesForward('choose', choose), false);
  assert.equal(G.comesForward('sign_in', mod.gateScreen('sign_in', null)), false);
});

test('the window is large type, the plan line as big as the main line, brings itself forward, lets go once touched', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'publik', 'gate-window.js'), 'utf8');
  for (const s of ['setAlwaysOnTop(true)', 'moveTop()', 'focus()', 'flashFrame(true)', 'setAlwaysOnTop(false)', "'publik-gate:touch'"]) assert.ok(src.includes(s), s);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'src', 'publik', 'gate-preload.js'), 'utf8'), /publik-gate:touch/);
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'publik', 'gate.html'), 'utf8');
  assert.match(html, /publikGate\.touch\(\)/);
  assert.match(html, /\.headline \{[^}]*font-size: 31px/);
  assert.match(html, /\.line \{[^}]*font-size: 18px/);
  assert.match(html, /\.callout \{[^}]*font-size: 18px; font-weight: 650/, 'the plan line is as big as the main line');
  assert.match(html, /<summary>What gets sent\?<\/summary>/);
  assert.match(html, /overflow-x: hidden/, 'nothing scrolls sideways');
  for (const t of G.STEPS) assert.ok(t.length <= 18, 'short step label: ' + t);
  assert.match(html, /\.steps \{[^}]*flex-wrap: wrap/);
  assert.doesNotMatch(html, /line-through/, 'no strike-through on an instruction');
  // Came forward by itself: nothing focused and keys ignored for a second, so a key meant for the
  // browser cannot press Connect (walk 2026-11-11).
  assert.match(src, /forward \? \{ cameForward: true \} : \{\}/);
  assert.match(html, /quietUntil = v\.cameForward \? Date\.now\(\) \+ 1000 : 0;/);
  assert.match(html, /if \(Date\.now\(\) < quietUntil\) \{ e\.preventDefault\(\); e\.stopPropagation\(\); \}/);
  assert.match(html, /if \(v\.cameForward\) \{[^}]*blur\(\)/);
});
