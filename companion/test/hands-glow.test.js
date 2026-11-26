// The Hands edge glow (renders-0115-2026-11-02, O3 direction A): one blue glow
// round the screen while Hands has the mouse, breathing by opacity alone at a
// low rate, half while a card waits, gone the instant it stops.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '../..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const spec = require('../renderer/knot-spec.js');

test('four edge strips, painted once, in one cool blue; only opacity moves', () => {
  const css = read('companion/renderer/styles.css');
  assert.match(css, /#hands-glow \{ position: fixed; inset: 0; z-index: 0; display: none; pointer-events: none; contain: strict; \}/, 'full screen, under everything, never takes the mouse');
  assert.match(css, /#hands-glow i \{ position: absolute; display: block; opacity: 0; will-change: opacity; \}/, 'each strip its own layer');
  for (const side of ['top', 'bottom', 'left', 'right']) assert.match(css, new RegExp('#hands-glow \\.' + side + '\\s+\\{[^}]*rgba\\(104,150,255,\\.58\\)'), side + ' strip in the one blue');
  assert.doesNotMatch(css.slice(css.indexOf('Hands edge glow'), css.indexOf('Island mode')).replace(/\/\*[\s\S]*?\*\//g, ''), /@keyframes|animation|transition/, 'no CSS animation and nothing fades');
  assert.deepEqual(spec.character.glow, { color: [104, 150, 255], edge: 130, period: 3.2, low: .72, high: 1, half: .5, fps: 12 });
});

test('the breath runs from the renderer at 12 updates a second; half while a card waits; gone at once', () => {
  const r = read('companion/renderer/renderer.js');
  assert.match(r, /glowTimer = setInterval\(glowTick, 1000 \/ GLOW\.fps\);/);
  assert.match(r, /const k = handsState\.waiting \? GLOW\.half : 1;/, 'half strength while a card waits');
  assert.match(r, /if \(!on && glowTimer\) \{ clearInterval\(glowTimer\); glowTimer = null; for \(const el of glowStrips\) el\.style\.opacity = '0'; \}/, 'stopped means stopped');
  assert.match(r, /if \(still\) return k \* \(GLOW\.low \+ GLOW\.high\) \/ 2;/, 'reduced motion holds still');
  assert.match(r, /function setHandsState\(active, waiting\) \{[\s\S]{0,900}?handsState = \{ active: !!active, waiting: !!waiting \};[\s\S]{0,900}?syncHandsGlow\(\); syncKnotUi\(\);\s*\}/, 'one setter, and it syncs the glow and the pill');
  assert.match(r, /nus\.on\('hands:state', \(p\) => setHandsState\(p && p\.active, p && p\.waiting\)\);/);
  assert.doesNotMatch(r, /hands-driving'[^\n]*guideState/, 'never guessed from guide states');
  const main = read('companion/index.js');
  assert.match(main, /onActive: \(on\) => \{ send\('hands:state', \{ active: !!on, waiting: false \}\);/);
  assert.match(main, /\.finally\(\(\) => send\('hands:state', \{ active: !!\(agent && agent\.active\(\)\), waiting: false \}\)\)/, 'a card answered or cancelled ends the wait');
});
