const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('both renderer windows keep Electron isolation enabled', () => {
  for (const file of ['src/main.js', 'companion/index.js']) {
    const source = read(file);
    assert.match(source, /contextIsolation:\s*true/, `${file} isolates the preload world`);
    assert.match(source, /nodeIntegration:\s*false/, `${file} denies Node to the renderer`);
    assert.match(source, /sandbox:\s*true/, `${file} enables Chromium sandboxing`);
    assert.match(source, /setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\)/,
      `${file} blocks renderer-created windows`);
    assert.match(source, /will-navigate/, `${file} blocks navigation away from its local page`);
  }
});

test('the desktop Content Security Policy permits no remote script execution', () => {
  const html = read('renderer/index.html');
  assert.match(html, /default-src 'self'/);
  assert.match(html, /script-src 'self'/);
  assert.doesNotMatch(html, /script-src[^;]*(?:unsafe-inline|unsafe-eval|https?:)/i);
});

test('quitting closes active Companion capture before the final save', () => {
  const main = read('src/main.js');
  assert.match(main, /if \(companion\?\.isCapturing\(\)\) companion\.setCapturing\(false\)/);
  const beforeQuit = main.indexOf("app.on('before-quit'");
  const stopCapture = main.indexOf('companion.setCapturing(false)', beforeQuit);
  const finalSave = main.indexOf('guardQuit(event)', beforeQuit);
  assert.ok(stopCapture > beforeQuit && finalSave > stopCapture);
});
