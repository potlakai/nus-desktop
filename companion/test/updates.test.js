'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createUpdateCheck, newestCompanion, newer } = require('../src/updates');

const RELEASES = [
  { tag_name: 'v0.2.7', html_url: 'x', draft: false },
  { tag_name: 'companion-v0.1.4', html_url: 'https://github.com/potlakai/nus-desktop/releases/tag/companion-v0.1.4', draft: false, prerelease: true, published_at: '2026-10-11T00:00:00Z' },
  { tag_name: 'companion-v0.1.10', html_url: 'https://github.com/potlakai/nus-desktop/releases/tag/companion-v0.1.10', draft: false, prerelease: true },
  { tag_name: 'companion-v0.2.0', html_url: 'd', draft: true },
  { tag_name: 'companion-v0.1.3', html_url: 'y', draft: false, prerelease: true },
];

test('the newest Companion tag wins by number, pre-releases count, drafts and Desktop tags do not', () => {
  const best = newestCompanion(RELEASES);
  assert.equal(best.version, '0.1.10');
  assert.ok(newer('0.1.10', '0.1.4')); assert.ok(!newer('0.1.4', '0.1.4')); assert.ok(!newer('bad', '0.1.4'));
  assert.equal(newestCompanion([]), null);
});

function rig({ current, releases = RELEASES, fail = false }) {
  const prefs = {};
  let t = Date.parse('2026-10-11T12:00:00Z'), calls = 0;
  const fetchImpl = async () => { calls++; if (fail) throw new Error('offline'); return { ok: true, json: async () => releases }; };
  const u = createUpdateCheck({ current, store: { get: k => prefs[k], set: (k, v) => { prefs[k] = v; } }, fetchImpl, now: () => t, log: () => {} });
  return { u, prefs, calls: () => calls, tick: ms => { t += ms; } };
}

test('one request a day, the newer version is offered, Later hides it for that version only', async () => {
  const r = rig({ current: '0.1.4' });
  let s = await r.u.check();
  assert.equal(r.calls(), 1);
  assert.equal(s.available.version, '0.1.10');
  assert.equal(s.dismissed, false);
  s = await r.u.check();
  assert.equal(r.calls(), 1, 'asked again within the day: no request');
  s = r.u.dismiss();
  assert.equal(s.dismissed, true);
  r.tick(2 * 86400000);
  s = await r.u.check();
  assert.equal(r.calls(), 2);
  assert.equal(s.dismissed, true, 'still the same version, still hidden');
});

test('on the newest version nothing is offered; offline is quiet and retried tomorrow', async () => {
  const same = rig({ current: '0.1.10' });
  assert.equal((await same.u.check()).available, null);
  const off = rig({ current: '0.1.4', fail: true });
  const s = await off.u.check();
  assert.equal(s.available, null); assert.ok(s.checkedAt);
  await off.u.check();
  assert.equal(off.calls(), 1, 'a failure is not retried until tomorrow');
});
