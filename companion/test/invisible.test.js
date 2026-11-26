const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '../..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

test('hidden from screen sharing is a setting, off by default since 2026-11-03, applied to the Knot alone', () => {
  const store = read('companion/src/store.js');
  assert.match(store, /hideFromCapture: false/);
  const main = read('companion/index.js');
  assert.match(main, /function captureHidden\(\)/);
  assert.match(main, /function applyCapturePolicy\(\)/);
  assert.match(main, /win\.setContentProtection\(hidden\)/, 'the overlay follows the setting');
  assert.match(main, /hooks\.onCapturePolicy\(hidden\)/, 'the host window follows the same switch');
  assert.match(main, /hasOwnProperty\.call\(patch, 'hideFromCapture'\)\) applyCapturePolicy\(\)/, 'a settings patch re-applies it at once');
  assert.match(main, /send\('capture:policy', \{ hidden \}\)/, 'the Knot is told');
  assert.match(main, /label: 'Hidden from screen sharing', type: 'checkbox'/, 'the tray has the switch');
  assert.doesNotMatch(main, /win\.setContentProtection\(!noProtect\)/, 'no build-time-only flag remains');
  const host = read('src/main-companion.js');
  assert.match(host, /home\.setContentProtection\(false\)/, 'the dashboard always shows in a share');
  assert.match(host, /onCapturePolicy: \(\) => \{/, 'the switch does not reach the dashboard');
  assert.match(host, /'hideFromCapture', 'sounds'/, 'Home may set it');
});

test('the Knot and Home say which state it is in, with honest copy', () => {
  assert.match(read('companion/preload.js'), /'capture:policy'/);
  assert.match(read('companion/renderer/index.html'), /id="share-state"/);
  assert.match(read('companion/renderer/renderer.js'), /'hidden from shares' : 'visible in shares'/);
  const home = read('companion/home/index.html');
  assert.match(home, /id="hide-from-capture"/);
  assert.match(home, /best effort, not a guarantee/);
  assert.match(home, /proctored exam/);
  assert.match(read('companion/home/home.js'), /'hide-from-capture':\['hideFromCapture'/);
});

test('founder stealth is untouched by the user-facing switch', () => {
  const main = read('companion/index.js');
  assert.match(main, /if \(settings\.stealth === true\) destroyTray\(\);/);
});
