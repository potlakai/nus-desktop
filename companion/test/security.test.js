const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

test('media permissions are limited to the local Companion renderer', () => {
  assert.match(source, /TRUSTED_COMPANION_URL/);
  assert.match(source, /isTrustedCompanionWebContents\(webContents\)/);
  assert.match(source, /if \(!isTrustedCompanionUrl\(request\?\.frame\?\.url\)\)/,
    'screen capture rejects frames outside the bundled Companion page');
  assert.doesNotMatch(source, /setPermissionRequestHandler\(\(_wc, permission, cb\) => cb\(allowMedia\(permission\)\)\)/,
    'permissions are never granted based on the permission name alone');
});

test('the Companion cannot ask the OS to open arbitrary URLs', () => {
  assert.match(source, /ALLOWED_SYSTEM_PANES\.has\(url\)/);
  assert.doesNotMatch(source, /url\.startsWith\('https:\/\/'\)/);
});
