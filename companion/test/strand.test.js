// The Knot strand: the overlay's thread across the screen. Contract test for
// the pieces that must exist together for a guide session to render.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const html = read('renderer', 'index.html');
const css = read('renderer', 'styles.css');
const js = read('renderer', 'renderer.js');
const strand = read('renderer', 'strand.js');
const knot = read('renderer', 'knot3d.js');
const preload = read('preload.js');
const main = read('index.js');
const store = read('src', 'store.js');

test('the strand is the Knot material continued across the screen', () => {
  assert.match(strand, /window\.NusStrand = \{ mount \}/);
  assert.match(strand, /NusKnot3D\.material/, 'same sprites and tube as the Knot');
  assert.match(strand, /getTailAnchor\(u\)|getTailAnchor \? knot\.getTailAnchor\(u\)/, 'the thread starts at the Knot\'s open tail');
  assert.match(strand, /knot\.setUnravel\(clamp\(progress \* 1\.6/, 'the Knot opens as the thread leaves it');
  assert.match(strand, /--thread-accent/, 'thread colour comes from the task, not the Knot state');
  assert.match(strand, /strandDebug=1/);
});

test('the shared Knot knows how to open, aim, and read', () => {
  assert.match(knot, /curvePoint\(t, u\)/, 'unravel primitive');
  assert.match(knot, /getTailAnchor\(u\)/);
  assert.match(knot, /reading: \{/, 'reading state for the amber glow');
  assert.match(knot, /setRotate\(rad\)/, 'the corner aims the tail at the screen centre');
  assert.match(knot, /focusGate/, 'full frame rate in the never-focused overlay');
  assert.match(knot, /window\.NusKnot3D = \{ mount, material/);
});

test('the overlay carries the strand canvas, the tip bubble, and the consent chip', () => {
  assert.match(html, /<canvas id="strand-layer"/);
  assert.match(html, /id="guide-bubble"/);
  assert.match(html, /id="keep-chip"/);
  assert.match(html, /id="keep-yes"/);
  assert.match(html, /id="keep-no"/);
  assert.match(html, /id="corner-pick"/);
  assert.match(html, /strand\.js\?v=/);
  assert.match(css, /#strand-layer \{ position: fixed; inset: 0;[^}]*pointer-events: none/);
  assert.match(js, /el\.closest\('[^']*#guide-bubble, #keep-chip, #quick-ask, #knot-hint'\)/, 'the bubble, chip, quick ask, and hint are clickable through the click-through window');
});

test('thread colour = task, Knot glow = state; amber is reading only', () => {
  assert.match(css, /\[data-task="guide"\] \{ --thread-accent: #7890FF; \}/);
  assert.match(css, /\[data-task="nudge"\] \{ --thread-accent: #69E2CF; \}/);
  assert.match(css, /\[data-task="ask"\] \{ --thread-accent: #D6DBEA; \}/);
  assert.match(css, /\[data-task="remember"\] \{ --thread-accent: #A78BFA; \}/);
  assert.match(css, /#orb\[data-state="reading"\] \{ --knot-accent: #E0B663/);
  assert.doesNotMatch(css, /--thread-accent: #E0B663/, 'amber never rides the thread');
  assert.match(css, /#orb\[data-state="listening"\] \{ --knot-accent: #D6DBEA/, 'listening is a silver pulse, mint belongs to plan nudges');
});

test('the Knot is pinned to a corner, never dragged', () => {
  assert.match(html, /<div id="app" data-corner="br">/);
  assert.match(css, /#app\[data-corner="tl"\]/);
  assert.match(css, /#app\[data-corner="tr"\]/);
  assert.doesNotMatch(css, /-webkit-app-region: drag/, 'no drag region: the window covers the work area');
  assert.match(js, /function aimKnot\(\)/);
  assert.match(js, /knot3d\.setRotate\(want - have\)/);
  assert.match(store, /knotCorner: 'br'/);
  assert.match(main, /resizable: false,\n    movable: false,/);
  assert.match(main, /function overlayBounds\(\)/);
  assert.match(main, /display-metrics-changed/);
});

test('guide IPC is allowlisted end to end', () => {
  for (const ch of ['guide:state', 'guide:target', 'guide:bubble', 'guide:done', 'knot:corner', 'daily:line']) {
    assert.match(preload, new RegExp(`'${ch}'`), ch + ' reaches the renderer');
  }
  for (const ch of ['companion:guide:ask', 'companion:guide:dismiss', 'companion:guide:keep', 'companion:guide:skip', 'companion:strand:arrived', 'companion:knot:corner:set']) {
    assert.match(preload, new RegExp(ch.replace(/[:]/g, '\\:')), ch + ' is exposed');
    assert.match(main, new RegExp(ch.replace(/[:]/g, '\\:')), ch + ' is handled');
  }
  assert.match(js, /nus\.on\('guide:target'/);
  assert.match(js, /nus\.on\('guide:done'/);
  assert.match(js, /function dismissGuide\(reason\)/);
  assert.match(js, /e\.key === 'Escape' && guideActive\(\)/, 'Esc winds the thread back');
});

test('dismissal always winds back before the Knot goes idle, and Skip is the default', () => {
  assert.match(js, /strand\.rewind\(\)/);
  assert.match(js, /keepTimer = setTimeout\(\(\) => answerKeep\(false, true\), 12000\)/);
  assert.match(main, /Escape/, 'the harness releases Esc when the thread is home');
  assert.match(main, /registerInspectionShortcut\(globalShortcut, inspectAtCursor\)/, 'public pointing shortcut registration is checked');
  assert.match(main, /'commandorcontrol\+shift\+t'/, 'reserved so the ask shortcut cannot take it');
});
