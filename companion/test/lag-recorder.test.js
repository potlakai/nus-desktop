'use strict';
// The lag recorder's core (companion/src/lag/recorder.js), its on/off rule, and
// the report that reads a recording back (scripts/lag-report.js).
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { createRecorder, createNoop } = require('../src/lag/recorder');
const lag = require('../src/lag');
const pageProbe = require('../src/lag/page-probe');
const { parse, summarize } = require('../../scripts/lag-report.js');

function rig(opts = {}) {
  const lines = []; let t = 1000000, h = 5000;
  const rec = createRecorder({ write: (l) => lines.push(JSON.parse(l)), now: () => t, hr: () => h, ...opts });
  return { rec, lines, wall: (ms) => { t += ms; h += ms; }, kinds: (k) => lines.filter((l) => l.k === k) };
}

test('lag: a late tick is a stall, with what the app was doing', () => {
  const r = rig();
  r.rec.channel('guide:state', { state: 'thinking' });
  r.rec.tick(); r.wall(50); r.rec.tick();
  assert.strictEqual(r.kinds('stall').length, 0, 'an on-time tick is not a stall');
  r.wall(50 + 480); r.rec.tick();
  const [s] = r.kinds('stall');
  assert.strictEqual(s.ms, 480);
  assert.strictEqual(s.s, 'thinking');
  assert.deepStrictEqual(s.held, []);
});

test('lag: a stall while the overlay holds the mouse says so, and the sample adds it up', () => {
  const r = rig();
  r.rec.mouseSet('overlay', true);
  r.rec.tick(); r.wall(50 + 300); r.rec.tick();
  assert.deepStrictEqual(r.kinds('stall')[0].held, ['overlay']);
  const s = r.rec.sample({});
  assert.strictEqual(s.stalls.n, 1);
  assert.strictEqual(s.stalls.heldMs, 300);
  assert.strictEqual(s.mouse.overlay.taking, true);
  assert.strictEqual(r.rec.sample({}).stalls.n, 0, 'each sample starts from nothing');
});

test('lag: the mouse held for a long stretch is written when it is let go', () => {
  const r = rig();
  r.rec.mouseSet('overlay', true); r.wall(400); r.rec.mouseSet('overlay', false);
  assert.strictEqual(r.kinds('mouse').length, 0, 'a hover over the Knot is not worth a line');
  r.rec.mouseSet('overlay', true); r.wall(2600); r.rec.mouseSet('overlay', false);
  assert.strictEqual(r.kinds('mouse')[0].heldMs, 2600);
  assert.strictEqual(r.rec.sample({}).mouse.overlay.heldMs, 3000);
});

test('lag: the state is read off the overlay channels', () => {
  const r = rig();
  assert.strictEqual(r.rec.state(), 'idle');
  r.rec.channel('ptt:state', { held: true }); assert.strictEqual(r.rec.activity(), 'listening');
  r.rec.channel('ptt:state', { held: false });
  r.rec.channel('guide:state', { state: 'transcribing' }); assert.strictEqual(r.rec.activity(), 'transcribing');
  r.rec.channel('guide:state', { state: 'thinking' }); assert.strictEqual(r.rec.activity(), 'thinking');
  r.rec.channel('guide:say', { text: 'x'.repeat(30) });
  r.rec.channel('guide:done', {});
  assert.strictEqual(r.rec.activity(), 'speaking');
  r.wall(900 + 30 * 70 + 1); assert.strictEqual(r.rec.activity(), 'idle', 'speaking ends by itself');
  r.rec.channel('hands:state', { active: true }); assert.strictEqual(r.rec.activity(), 'hands');
  r.rec.channel('hands:state', { active: false });
  r.rec.channel('voice:state', { downloading: { got: 1, total: 9 } }); assert.strictEqual(r.rec.activity(), 'download');
  r.rec.channel('voice:state', { downloading: null });
  r.rec.channel('tour:card', {}); r.rec.set({ dashboard: true, battery: true });
  assert.strictEqual(r.rec.state(), 'tour+dash+batt');
  r.rec.channel('ptt:state', { held: true });
  assert.strictEqual(r.rec.state(), 'listening+tour+dash+batt');
  assert.ok(r.kinds('state').length >= 8, 'each change is a line');
});

test('lag: named work is written only when slow, and a stall names the last of it', () => {
  const r = rig();
  let ran = 0;
  const quick = r.rec.timed('quick', () => { ran++; r.wall(5); return 7; });
  const slow = r.rec.timed((a) => 'slow ' + a[0], () => { r.wall(220); });
  assert.strictEqual(quick(), 7); assert.strictEqual(ran, 1);
  assert.strictEqual(r.kinds('slow').length, 0);
  r.rec.tick();
  slow('persist');
  r.rec.tick();
  assert.deepStrictEqual(r.kinds('slow').map((l) => [l.label, l.ms]), [['slow persist', 220]]);
  assert.strictEqual(r.kinds('stall')[0].last, 'slow persist');
  assert.throws(r.rec.timed('throws', () => { throw new Error('kept'); }), /kept/);
});

test('lag: a child process is written with how long starting it held the main thread', () => {
  const r = rig();
  const end = r.rec.spawnBegin('powershell.exe probe.ps1', 42);
  r.rec.tick(); r.wall(50 + 200); r.rec.tick();
  assert.deepStrictEqual(r.kinds('stall')[0].inflight, ['powershell.exe probe.ps1']);
  r.wall(1000); end(0); end(0);
  const [s] = r.kinds('spawn');
  assert.deepStrictEqual([s.name, s.syncMs, s.code], ['powershell.exe probe.ps1', 42, 0]);
  assert.strictEqual(r.kinds('spawn').length, 1, 'ending twice writes once');
  assert.strictEqual(r.rec.sample({}).spawns.syncMs, 42);
});

test('lag: off, every call is a no-op and timed() hands the function back untouched', () => {
  const n = createNoop();
  const fn = () => 1;
  assert.strictEqual(n.timed('x', fn), fn);
  assert.strictEqual(n.spawnBegin('x', 1)(0), undefined);
  n.channel('ptt:state', { held: true }); n.mouseSet('overlay', true); n.tick(); n.sample({});
  assert.deepStrictEqual(n.mouseHeld(), []);
  // The module the app requires: nothing is on until install() says so.
  assert.strictEqual(lag.on(), false);
  assert.strictEqual(lag.timed('x', fn), fn);
  lag.channel('ptt:state', { held: true }); lag.mouse('overlay', true);
});

test('lag: on in a dev run, off in an install unless asked for', () => {
  const none = { existsSync: () => false }, flagged = { existsSync: (p) => path.basename(p) === 'lag-on.txt' };
  assert.strictEqual(lag.wanted({ env: {}, packaged: false, userData: 'x', fs: none }), true);
  assert.strictEqual(lag.wanted({ env: { NUS_LAG: '0' }, packaged: false, userData: 'x', fs: none }), false);
  assert.strictEqual(lag.wanted({ env: {}, packaged: true, userData: 'x', fs: none }), false, 'a normal install records nothing');
  assert.strictEqual(lag.wanted({ env: { NUS_LAG: '1' }, packaged: true, userData: 'x', fs: none }), true);
  assert.strictEqual(lag.wanted({ env: {}, packaged: true, userData: 'x', fs: flagged }), true);
  assert.strictEqual(lag.wanted({ env: { NUS_LAG: '0' }, packaged: true, userData: 'x', fs: flagged }), false);
});

test('lag: windows are named by their page', () => {
  assert.strictEqual(lag.windowName('file:///C:/app/companion/renderer/index.html'), 'overlay');
  assert.strictEqual(lag.windowName('file:///C:/app/companion/home/index.html'), 'dashboard');
  assert.strictEqual(lag.windowName('file:///C:/app/companion/src/publik/gate.html'), 'signin');
  assert.strictEqual(lag.windowName('file:///C:/app/companion/renderer/touch-pad.html'), 'touchpad');
  assert.strictEqual(lag.windowName('https://example.com/'), null);
});

test('lag: the page probe never asks for a frame of its own', () => {
  // A watcher that calls requestAnimationFrame makes the frames it counts.
  const body = pageProbe.probe.toString();
  const own = body.replace(/window\.requestAnimationFrame = function[\s\S]*?\n  \};/, '');
  assert.ok(!/requestAnimationFrame\(/.test(own.replace('window.requestAnimationFrame.bind(window)', '')), 'only the wrapper touches requestAnimationFrame');
  assert.ok(/window\.__nusLag/.test(pageProbe.SOURCE) && /drain\(\)/.test(pageProbe.DRAIN));
});

test('lag report: a recording reads back as one row per state', () => {
  const r = rig();
  r.rec.emit('start', { version: 't', sampleMs: 5000, cpu: 'test' });
  r.rec.tick(); r.wall(50 + 250); r.rec.tick();
  r.rec.sample({ loop: { p50: 1, p99: 12, max: 260, mean: 2 }, cpu: { total: 20, list: [{ p: 'main', cpu: 4 }, { p: 'overlay', cpu: 16 }] },
    win: { overlay: { rt: 1.2, fr: { n: 100, sum: 0, max: 120, b: [90, 5, 3, 1, 1, 0, 0] }, lt: { n: 1, sum: 60, max: 60 }, loaf: { n: 1, sum: 60, max: 60, blk: 10, top: [{ ms: 60, fn: 'tick', src: 'knot-engine.js', js: 40 }] }, ev: { n: 0, max: 0, delay: 0 } } } });
  r.rec.channel('guide:state', { state: 'thinking' });
  r.wall(5000);
  r.rec.sample({ loop: { p50: 1, p99: 40, max: 90, mean: 3 }, cpu: { total: 50, list: [{ p: 'main', cpu: 10 }] }, win: {} });
  const sum = summarize(parse(r.lines.map((l) => JSON.stringify(l)).join('\n') + '\n{"torn'));
  const idle = sum.table.find((x) => x.state === 'idle'), thinking = sum.table.find((x) => x.state === 'thinking');
  assert.strictEqual(idle.stalls, 1); assert.strictEqual(idle.stallMax, 250); assert.strictEqual(idle.loopMax, 260);
  assert.strictEqual(idle.win.overlay.frames, 100); assert.strictEqual(idle.win.overlay.over34Pct, 5); assert.strictEqual(idle.win.overlay.over100, 1);
  assert.strictEqual(idle.cpu.overlay, 16);
  assert.strictEqual(thinking.loopP99, 40); assert.strictEqual(thinking.cpuTotal, 50);
});
