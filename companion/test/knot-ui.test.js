const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'renderer', 'styles.css'), 'utf8');
const js = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');

test('the persistent companion mark is the animated Nūs Knot', () => {
  assert.match(html, /class="nus-knot"/);
  assert.match(html, /id="knot-bloom"/);
  assert.doesNotMatch(html, /nus-statue-mark\.png/);
  assert.match(css, /@keyframes knotFlow/);
  assert.match(css, /@keyframes knotBreathe/);
});

test('hover states expose the four intended Nūs modes', () => {
  for (const state of ['idle', 'listening', 'thinking', 'ready']) {
    assert.match(html, new RegExp(`data-knot-state="${state}"`));
  }
  assert.match(css, /#knot-shell:hover #knot-bloom/);
});

test('the Knot remains wired to live companion state and commands', () => {
  assert.match(js, /function syncKnotUi\(\)/);
  assert.match(js, /function toggleCaptureFromUi\(\)/);
  assert.match(js, /runMode\('assist', ''\)/);
  assert.match(js, /panel\.classList\.add\('collapsed'\)/);
  assert.match(js, /#orb.*addEventListener\('click', toggleTiles\)/);
});

test('the command sheet and original behavior hooks remain present', () => {
  for (const id of ['panel', 'messages', 'input', 'smart-toggle', 'stop-btn', 'logo-btn']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
});
