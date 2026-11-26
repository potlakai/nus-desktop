// The Knot really on top (src/win/on-top.js): the guard that asks what is
// drawn over the Knot's window instead of trusting the always-on-top flag.
// Found 2026-11-20 on Companion 0.1.30: flag on, eleven windows over the Knot.
// The live check on a real desktop is `node scripts/on-top-check.cjs`.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createOnTopGuard, line, CHECK_EVERY_MS } = require('../src/win/on-top');
const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

function rig(answers, opts = {}) {
  const asked = [], logged = [];
  let t = 0;
  const guard = createOnTopGuard(Object.assign({
    check: async (o) => { asked.push(o); const a = answers.shift(); if (a instanceof Error) throw a; return a; },
    log: (m) => logged.push(m),
    now: () => t,
  }, opts));
  return { guard, asked, logged, later: (ms) => { t += ms; } };
}

test('a Knot with nothing over it is left alone and nothing is logged', async () => {
  const r = rig([{ ok: true, above: 0, topmost: true, raised: false }]);
  await r.guard.tick();
  assert.deepEqual(r.asked, [{ raise: true, unless: 0 }]);
  assert.deepEqual(r.logged, []);
  assert.deepEqual(r.guard.status(), { checks: 1, lifts: 0, outranked: 0 });
});

test('the 2026-11-20 case: flag still on, eleven windows over the Knot, lifted and logged once', async () => {
  const r = rig([{ ok: true, above: 11, first: 500, firstClass: 'Chrome_WidgetWin_1', topmost: true, raised: true, left: 0, leftFirst: 0 }]);
  await r.guard.tick();
  assert.deepEqual(r.logged, ['the Knot was under 11 windows with its on-top flag still on (first: Chrome_WidgetWin_1); lifted']);
  assert.equal(r.guard.status().lifts, 1);
});

test('the line never carries a window title, only how many and the first one\'s class', () => {
  assert.equal(line({ above: 1, topmost: true, firstClass: 'CabinetWClass', firstTitle: 'private folder name' }), 'the Knot was under 1 window with its on-top flag still on (first: CabinetWClass)');
  assert.equal(line({ above: 2, topmost: false }), 'the Knot was under 2 windows with its on-top flag off');
});

test('it asks at most once per interval, and never twice at the same time', async () => {
  let release;
  const asked = [];
  let t = 0;
  const guard = createOnTopGuard({ check: (o) => { asked.push(o); return new Promise((res) => { release = res; }); }, now: () => t });
  const first = guard.tick();
  t += CHECK_EVERY_MS * 3;
  assert.equal(await guard.tick(), null, 'a check is still out');
  release({ ok: true, above: 0 });
  await first;
  const again = guard.tick();
  release({ ok: true, above: 0 });
  await again;
  t += CHECK_EVERY_MS - 1;
  assert.equal(await guard.tick(), null, 'too soon after the last one');
  assert.equal(asked.length, 2);
});

test('a window the lift cannot pass is not lifted against again while it is the one on top', async () => {
  const r = rig([
    { ok: true, above: 1, first: 77, firstClass: 'Shell_Band', topmost: true, raised: true, left: 1, leftFirst: 77 },
    { ok: true, above: 1, first: 77, firstClass: 'Shell_Band', topmost: true, raised: false },
    { ok: true, above: 0, topmost: true, raised: false },
    { ok: true, above: 1, first: 77, firstClass: 'Shell_Band', topmost: true, raised: true, left: 0, leftFirst: 0 },
  ]);
  await r.guard.tick();
  assert.equal(r.guard.status().outranked, 77);
  assert.deepEqual(r.logged, ['the Knot was under 1 window with its on-top flag still on (first: Shell_Band); lifted, 1 still over it']);
  r.later(CHECK_EVERY_MS);
  await r.guard.tick();
  assert.deepEqual(r.asked[1], { raise: true, unless: 77 }, 'the probe is told which window not to fight');
  assert.equal(r.logged.length, 1, 'and it is not logged again');
  r.later(CHECK_EVERY_MS);
  await r.guard.tick();
  assert.equal(r.guard.status().outranked, 0, 'gone from over the Knot: forgotten');
  r.later(CHECK_EVERY_MS);
  await r.guard.tick();
  assert.deepEqual(r.asked[3], { raise: true, unless: 0 });
  assert.equal(r.guard.status().lifts, 1);
});

test('no probe, a probe that times out, or a window that is not there: no throw, no log, asked again later', async () => {
  const r = rig([null, new Error('win.covered timed out after 1500ms'), { ok: true, above: -1 }, { ok: true, above: 0 }]);
  for (let i = 0; i < 4; i++) { await r.guard.tick(); r.later(CHECK_EVERY_MS); }
  assert.equal(r.asked.length, 4);
  assert.deepEqual(r.logged, []);
  assert.equal(r.guard.status().checks, 1);
});

test('the probe answers win.covered: counts ordinary windows over a window and lifts without activating', () => {
  const ps = read('src', 'win', 'probe.ps1');
  assert.match(ps, /'win\.covered' \{/);
  const op = ps.slice(ps.indexOf("'win.covered' {"), ps.indexOf("'uia.list' {"));
  assert.match(op, /Covering\(\$h\)/);
  assert.match(op, /\$req\.raise -and \$c\[1\] -ne \$unless/, 'raise is opt-in and skips the outranking window');
  assert.match(op, /0x0001 -bor 0x0002 -bor 0x0010/, 'no size, no move, no activate');
  const fn = ps.slice(ps.indexOf('public static long[] Covering'), ps.indexOf('public static string Title'));
  assert.match(fn, /IsIconic\(h\)/, 'minimised windows cover nothing');
  assert.match(fn, /& 8\) != 0\) continue/, 'topmost windows may be over the Knot');
  assert.match(fn, /DwmGetWindowAttribute\(h, 14/, 'cloaked windows (another desktop, a suspended app) cover nothing');
});

test('the main process asks on the guard tick only while the flag is on, and the flag-off path is unchanged', () => {
  const main = read('index.js');
  const fn = main.slice(main.indexOf('function reassertTopmost()'), main.indexOf('const onTopGuard'));
  assert.match(fn, /if \(!win\.isAlwaysOnTop\(\)\) \{ restoreTopmost\('guard'\); return; \}/);
  assert.match(fn, /onTopGuard\.tick\(\)/);
  assert.match(main, /probe\.request\('win\.covered', Object\.assign\(\{ hwnd: win\.getNativeWindowHandle\(\)\.readUInt32LE\(0\) \}, o\), 1500\)/);
  assert.match(main, /log: \(m\) => routeLog\(m\)/);
});
