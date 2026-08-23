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

test('billing secrets remain server-side and Checkout URLs are allowlisted', () => {
  const license = read('src/license.js');
  const checkout = read('supabase/functions/create-checkout/index.ts');
  assert.doesNotMatch(license, /STRIPE_SECRET_KEY|SUPABASE_SERVICE_ROLE_KEY|STRIPE_WEBHOOK_SECRET/);
  assert.match(license, /url\.hostname\.endsWith\('\.stripe\.com'\)/);
  assert.match(checkout, /supabase\.auth\.getUser\(\)/);
});

test('Google account sign-in opens only the configured Supabase auth origin', () => {
  const main = read('src/main.js');
  assert.match(main, /candidate\.origin === project\.origin/);
  assert.match(main, /candidate\.pathname\.startsWith\('\/auth\/v1\/'\)/);
  assert.match(main, /isTrustedSupabaseAuthUrl\(result\.url\)/);
});

test('the renderer cannot overwrite license or usage bookkeeping', () => {
  const main = read('src/main.js');
  assert.match(main, /RENDERER_PREFERENCE_KEYS = new Set/);
  assert.match(main, /if \(!RENDERER_PREFERENCE_KEYS\.has\(key\)\)/);
  const allowedBlock = main.slice(main.indexOf('RENDERER_PREFERENCE_KEYS'), main.indexOf('RENDERER_PREFERENCE_KEYS') + 260);
  assert.doesNotMatch(allowedBlock, /license_|usage_/);
});

test('offline Pro grace comes only from OS-encrypted storage', () => {
  const main = read('src/main.js');
  const license = read('src/license.js');
  assert.match(main, /secrets\.isAvailable\(\).*secrets\.getSecret\('license-cache'\)/s);
  assert.match(main, /secrets\.isAvailable\(\).*secrets\.setSecret\('license-cache'/s);
  assert.doesNotMatch(license, /getPreferences|setPreference/);
});

test('quitting closes active Companion capture before the final save', () => {
  const main = read('src/main.js');
  assert.match(main, /if \(companion\?\.isCapturing\(\)\) companion\.setCapturing\(false\)/);
  const beforeQuit = main.indexOf("app.on('before-quit'");
  const stopCapture = main.indexOf('companion.setCapturing(false)', beforeQuit);
  const finalSave = main.indexOf('guardQuit(event)', beforeQuit);
  assert.ok(stopCapture > beforeQuit && finalSave > stopCapture);
});
