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

test('the default sheet is one verb: guide, plus the composer', () => {
  assert.match(html, /id="primary-row"/);
  assert.match(html, /data-mode="guide"/);
  // Manual state buttons are gone: state is displayed, never set by the user.
  assert.doesNotMatch(html, /class="knot-state"/);
  // No Smart pill and no zoom chrome in the composer.
  assert.doesNotMatch(html, /id="smart-toggle"/);
  assert.doesNotMatch(html, /id="zoom-in-btn"/);
  assert.match(html, /id="smart-mode"/, 'Smart moved to Settings as a checkbox');
});

test('call and rehearsal tools only exist in context', () => {
  assert.match(html, /id="live-cluster" *(?:class="[^"]*hidden[^"]*")?/);
  assert.match(html, /class="mode-cluster hidden" id="live-cluster"/);
  assert.match(html, /class="mode-cluster hidden" id="rehearsal-cluster"/);
  assert.match(js, /#live-cluster'\)\.classList\.toggle\('hidden', !active\)/, 'live tools track the capture state');
  assert.match(js, /function syncRehearsalCluster/, 'rehearsal tools require a pack or founder mode');
});

test('the Knot remains wired to live companion state and commands', () => {
  assert.match(js, /function syncKnotUi\(\)/);
  assert.match(js, /function toggleCaptureFromUi\(\)/);
  assert.match(js, /runMode\('guide', ''\)/, 'guide is the default verb');
  assert.match(js, /#orb.*addEventListener\('click', toggleTiles\)/);
});

test('guide runs keyless and the daily line speaks first', () => {
  assert.match(js, /KEYLESS_MODES/, 'keyless modes skip the provider preflight');
  assert.match(js, /nus\.on\('daily:line'/, 'the renderer receives the daily line');
  assert.match(html, /id="daily-line"/);
  assert.match(js, /#daily-line/, 'the daily line is clickable through the overlay');
});

test('founder tooling is hidden from the student build', () => {
  assert.match(html, /data-founder/);
  assert.match(css, /html:not\(\.founder\) \[data-founder\] \{ display: none !important; \}/);
  assert.match(js, /_founderTools/);
});

test('the command sheet and original behavior hooks remain present', () => {
  for (const id of ['panel', 'messages', 'input', 'stop-btn', 'logo-btn']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
});
