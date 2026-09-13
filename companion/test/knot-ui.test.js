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

test('a double-click on the Knot is one activation and never dismisses the composer', () => {
  // The second click of a double-click used to close the quick ask the first
  // click had just opened and hand the mouse back to the desktop.
  assert.match(js, /function knotClickRepeated\(e\)/);
  assert.match(js, /e\.detail > 1/, 'Chromium click counting decides what a double-click is');
  assert.match(js, /KNOT_CLICK_REPEAT_MS = 400/);
  assert.match(js, /if \(knotClickRepeated\(e\)\) \{ if \(quickOpen\) \$\('#quick-input'\)\.focus\(\); return; \}[\s\S]{0,400}?\n\s+if \(guideActive\(\)\) dismissGuide\('knot'\);/, 'the repeat guard runs before any toggle (the selection follow-up branch may sit between)');
  assert.match(js, /\$\('#orb'\)\.addEventListener\('dblclick', \(e\) => \{ e\.preventDefault\(\);/);
});

test('the overlay never throttles and the Knot pauses only on a real hide', () => {
  const main = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
  const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
  const knot3d = fs.readFileSync(path.join(root, 'renderer', 'knot3d.js'), 'utf8');
  assert.match(main, /backgroundThrottling: false/, 'the persistent transparent overlay keeps timers and animation running');
  assert.match(main, /win\.on\('show', \(\) => send\('overlay:visible', \{ visible: true \}\)\)/);
  assert.match(main, /win\.on\('hide', \(\) => send\('overlay:visible', \{ visible: false \}\)\)/);
  assert.match(preload, /'overlay:visible'/, 'the renderer may listen for overlay:visible');
  assert.match(js, /nus\.on\('overlay:visible'/);
  assert.match(js, /pauseWhenHidden: false/, 'the overlay Knot ignores the Page Visibility API');
  assert.match(knot3d, /const pauseWhenHidden = opts\.pauseWhenHidden !== false;/, 'dashboard and onboarding hosts keep the default');
  assert.match(knot3d, /if \(pauseWhenHidden\) document\.addEventListener\('visibilitychange', onVisibility\);/);
});

test('the overlay re-asserts always-on-top after a fullscreen app strips it', () => {
  const main = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
  assert.match(main, /function reassertTopmost\(\)/);
  assert.match(main, /if \(!win\.isAlwaysOnTop\(\)\) restoreTopmost\('guard'\); \} catch/, 'only re-assert when the OS bit is gone: an unconditional call strips it');
  assert.match(main, /win\.on\('focus', reassertTopmost\)/, 'a Knot click is the moment the bit can be restored');
  assert.match(main, /TOPMOST_GUARD_TICKS = 16/);
  assert.match(main, /if \(\+\+topmostTick >= TOPMOST_GUARD_TICKS\) \{ topmostTick = 0; reassertTopmost\(\); \}/, 'the guard rides the existing cursor probe timer');
});

test('with no Companion key, the sheet and the quick ask both answer through the desktop Claude connection', () => {
  const main = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
  const pointing = fs.readFileSync(path.join(root, 'src', 'guide', 'pointing.js'), 'utf8');
  assert.match(main, /function featureLlm\(settings\)/);
  assert.match(main, /async stream\(\{ system, turns, imageDataUrl, onToken \}\)/, 'the desktop fallback streams for the command sheet');
  assert.match(main, /const llm = featureLlm\(settings\);\n\s+const userBubble/, 'runFeature uses the fallback');
  assert.match(main, /safeIpc\.handle\('companion:ai:ready', \(\) => \{\n\s+const settings = store\.getSettings\(\);\n\s+const llm = featureLlm\(settings\);/, 'readiness reflects the fallback');
  assert.match(main, /function guideLlm\(\) \{ return featureLlm\(store\.getSettings\(\)\); \}/);
  assert.match(pointing, /If the user asked a question or wants information rather than something done on this screen, answer it/, 'questions typed at the Knot get an answer, not a refusal');
  assert.match(pointing, /const MAX_INSTRUCTION = 400;/);
});

test('showing the overlay restores a stripped always-on-top bit', () => {
  const main = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
  assert.match(main, /function showOverlay\(\) \{\n\s+overlayUserHidden = false;\n\s+if \(!win \|\| win\.isDestroyed\(\)\) return;[\s\S]{0,500}?if \(win\.webContents\.isCrashed\(\)\) \{\n\s+const dead = win; win = null;[\s\S]{0,200}?createOverlayWindow\(\);\n\s+return;\n\s+\}\n\s+if \(process\.platform === 'win32' && !win\.isAlwaysOnTop\(\)\) win\.show\(\);\n\s+else win\.showInactive\(\);/, 'an explicit Show rebuilds a crashed renderer instead of showing a blank window');
  assert.equal((main.match(/\bshowOverlay\(\);/g) || []).length, 4, 'toggle, desktop show, re-enable and inspection all share recovery');
});

test('a pointed target hidden under the conversation panel folds the panel away (fresh packaged run, 2026-09-10)', () => {
  assert.match(js, /function collapsePanelIfCovering\(bbox\) \{\r?\n\s+if \(!bbox \|\| panel\.classList\.contains\('collapsed'\)\) return false;/);
  assert.match(js, /const covers = !\(r\.right < bbox\.x \|\| r\.left > bbox\.x \+ bbox\.w \|\| r\.bottom < bbox\.y \|\| r\.top > bbox\.y \+ bbox\.h\);/);
  assert.match(js, /nus\.on\('guide:target', \(p\) => \{[\s\S]{0,400}?keepChip\.classList\.add\('hidden'\);\r?\n\s+collapsePanelIfCovering\(p\.bbox\);/, 'every pointed target checks the panel');
});

test('"Ask without screen" never captures the screen and a click burst never toggles the composer', () => {
  const main = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
  assert.match(js, /nus\.ask\(\{ mode: 'ask', text, screen: false \}\)/, 'the composer ask intent passes screen:false');
  assert.match(main, /runFeature\(payload\.mode, payload\.text, null, \{ screen: !\(payload && payload\.screen === false\) \}\)/);
  assert.match(main, /const wantScreen = !!def\.needsScreen && opts\.screen !== false;/);
  assert.match(main, /if \(wantScreen\) \{\n\s+send\('guide:state', \{ state: 'reading', task: 'ask' \}\);\n\s+try \{ imageDataUrl = await captureScreenshot\(\); \}/, 'capture and the reading state are both gated');
  assert.match(main, /No screen image is attached for this question/);
  assert.match(js, /const repeated = \(e && e\.detail > 1\) \|\| at - lastKnotClick < KNOT_CLICK_REPEAT_MS;\n\s+lastKnotClick = at;/, 'repeat timing is against the previous click of any kind');
});

test('a selection answer offers a same-snapshot follow-up from the Knot and from the bubble', () => {
  const main = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
  assert.match(js, /function showInspectionComposer\(p, followUp\)/);
  assert.match(js, /if \(!quickOpen && currentInspection && guideActive\(\)\) \{ showInspectionComposer\(currentInspection, true\); return; \}/, 'a Knot click over a selection answer opens the follow-up instead of dismissing');
  assert.match(js, /else if \(a\.id === 'inspect-ask'\) showInspectionComposer\(currentInspection, true\);/);
  assert.match(js, /Follow-up uses the same snapshot, no new capture\./);
  assert.match(main, /\{ id: 'inspect-ask', label: 'Ask more' \},\n\s+\{ id: 'inspect-dismiss', label: 'Done' \},/, 'Ask more and Done stay on every selection answer; Walk me through it is added only for the guide intent');
});

test('a stripped topmost bit is restored through the probe, from the guard and right after a selection focus', () => {
  const main = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
  assert.match(main, /if \(!win\.isAlwaysOnTop\(\)\) restoreTopmost\('guard'\);/);
  assert.match(main, /const r = await probe\.request\('win\.topmost', \{ hwnd \}, 1500\);/);
  assert.match(main, /win\.focus\(\);\n[\s\S]{0,300}?if \(!win\.isAlwaysOnTop\(\)\) \{ console\.log\('\[inspect\] focus\(\) stripped topmost; restoring'\); await restoreTopmost\('inspect'\); \}/);
  assert.match(main, /try \{ if \(win && !win\.isDestroyed\(\)\) win\.setAlwaysOnTop\(true\); \} catch \(_\) \{\}/, 'Electron call stays as the fallback');
});
