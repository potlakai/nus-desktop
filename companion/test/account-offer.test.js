const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { countOpen, shouldOffer, OFFER_DAY } = require('../src/account-offer');

const root = path.resolve(__dirname, '../..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8').replace(/\r\n/g, '\n');

function days(n, start = new Date(2026, 10, 1, 9).getTime()) {
  let prefs = {};
  for (let i = 0; i < n; i++) {
    // Two opens on each day: the second one counts nothing.
    for (const hour of [0, 6]) { const p = countOpen(prefs, start + i * 86400000 + hour * 3600000); if (p) prefs = { ...prefs, ...p }; }
  }
  return prefs;
}

test('the offer waits for the third distinct day', () => {
  assert.equal(OFFER_DAY, 3);
  assert.equal(shouldOffer(days(1), false), false);
  assert.equal(shouldOffer(days(2), false), false);
  assert.equal(days(2).account_open_days, 2);
  assert.equal(shouldOffer(days(3), false), true);
  assert.equal(shouldOffer(days(9), false), true);
});

test('Not now hides it for good, and a signed-in person never sees it', () => {
  assert.equal(shouldOffer({ ...days(5), account_offer_dismissed: true }, false), false);
  assert.equal(shouldOffer(days(5), true), false);
});

test('the same day counts once', () => {
  const t = new Date(2026, 10, 1, 9).getTime();
  const first = countOpen({}, t);
  assert.deepEqual(first, { account_open_days: 1, account_last_open_day: '2026-11-01' });
  assert.equal(countOpen(first, t + 3600000), null);
});

test('Home wiring: the card, the offer, the IPC and the preload stay in step', () => {
  const html = read('companion/home/index.html');
  const js = read('companion/home/home.js');
  const preload = read('companion/home/preload.js');
  const main = read('src/main-companion.js');
  for (const id of ['account-card', 'account-offer', 'account-signin', 'account-signout', 'account-offer-signin', 'account-offer-later']) assert.match(html, new RegExp('id="' + id + '"'));
  for (const ch of ['account:status', 'account:signin', 'account:cancel', 'account:signout', 'account:dismiss']) {
    assert.match(preload, new RegExp("invoke\\('" + ch + "'"));
    assert.match(main, new RegExp("handle\\('home:" + ch + "'"));
  }
  assert.match(preload, /'home:account'/);
  assert.match(js, /api\.on\('home:account'/);
  // The offer is counted on real launches and Home windows, never in a smoke run.
  assert.match(main, /countOpen\(/);
  // No em dashes in the new copy.
  assert.doesNotMatch(html.slice(html.indexOf('id="account-')), /—/);
});
