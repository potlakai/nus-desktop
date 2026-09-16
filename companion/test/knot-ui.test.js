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
  assert.match(js, /if \(guideActive\(\)\) dismissGuide\('knot'\);\n\s+else if \(quickOpen\) closeQuickAsk\(\);/, 'the Knot winds the thread back, else opens or closes the quick ask');
  assert.match(js, /else openQuickAsk\(\);/, 'idle click = the quick ask, the sheet stays one click further');
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

// Ported 2026-09-15 from the main tree's 2026-09-10 "Companion disappeared" fixes.
test('a double-click on the Knot is one activation and never dismisses the composer', () => {
  // The second click of a double-click used to close the quick ask the first
  // click had just opened and hand the mouse back to the desktop.
  assert.match(js, /function knotClickRepeated\(e\)/);
  assert.match(js, /e\.detail > 1/, 'Chromium click counting decides what a double-click is');
  assert.match(js, /KNOT_CLICK_REPEAT_MS = 400/);
  assert.match(js, /if \(knotClickRepeated\(e\)\) \{ if \(quickOpen\) \$\('#quick-input'\)\.focus\(\); return; \}\n\s+if \(guideActive\(\)\) dismissGuide\('knot'\);/, 'the repeat guard runs before any toggle');
  assert.match(js, /\$\('#orb'\)\.addEventListener\('dblclick', \(e\) => \{ e\.preventDefault\(\);/);
  assert.match(js, /const repeated = \(e && e\.detail > 1\) \|\| at - lastKnotClick < KNOT_CLICK_REPEAT_MS;\n\s+lastKnotClick = at;/, 'repeat timing is against the previous click of any kind');
});

test('the overlay re-asserts always-on-top after a fullscreen app strips it', () => {
  const main = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
  assert.match(main, /function reassertTopmost\(\)/);
  assert.match(main, /if \(!win\.isAlwaysOnTop\(\)\) restoreTopmost\('guard'\); \} catch/, 'only re-assert when the OS bit is gone: an unconditional call strips it');
  assert.match(main, /win\.on\('focus', reassertTopmost\)/, 'a Knot click is the moment the bit can be restored');
  assert.match(main, /TOPMOST_GUARD_TICKS = 16/);
  assert.match(main, /if \(\+\+topmostTick >= TOPMOST_GUARD_TICKS\) \{ topmostTick = 0; reassertTopmost\(\); \}/, 'the guard rides the existing cursor probe timer');
  assert.doesNotMatch(main, /setInterval\([^)]*setAlwaysOnTop\(true\)/, 'never an unconditional periodic setAlwaysOnTop(true)');
});

test('showing the overlay restores a stripped always-on-top bit', () => {
  const main = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
  assert.match(main, /function showOverlayWindow\(\) \{\n\s+if \(!win \|\| win\.isDestroyed\(\)\) return;\n\s+if \(process\.platform === 'win32' && !win\.isAlwaysOnTop\(\)\) win\.show\(\);\n\s+else win\.showInactive\(\);/);
  assert.equal((main.match(/\bshowOverlayWindow\(\);/g) || []).length, 3, 'toggle, force show and re-enable all share it');
});

test('a stripped topmost bit is restored through the probe, with Electron as the fallback', () => {
  const main = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
  const ps = fs.readFileSync(path.join(root, 'src', 'win', 'probe.ps1'), 'utf8');
  assert.match(main, /const r = await probe\.request\('win\.topmost', \{ hwnd \}, 1500\);/);
  assert.match(main, /try \{ if \(win && !win\.isDestroyed\(\)\) win\.setAlwaysOnTop\(true\); \} catch \(_\) \{\}/, 'Electron call stays as the fallback');
  assert.match(ps, /'win\.topmost' \{/, 'the probe answers win.topmost');
  assert.match(ps, /SetWindowPos\(\$h, \[IntPtr\]\(-1\), 0, 0, 0, 0, \[uint32\]\(0x0001 -bor 0x0002 -bor 0x0010\)\)/, 'HWND_TOPMOST without activating (NOSIZE, NOMOVE, NOACTIVATE)');
  assert.match(ps, /public static extern bool SetWindowPos\(/);
  assert.match(ps, /public static extern long GetWindowLongPtrW\(/);
});
