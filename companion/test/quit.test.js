'use strict';
// Quit must end the process. will-quit is held once so the session's minutes go
// out; after that, a second app.quit() is ignored by Electron and the process
// stayed up (every Quit and every smoke run hung from 64773b5 to 0.1.8).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('the held will-quit ends in app.exit, never a second app.quit', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main-companion.js'), 'utf8');
  const hold = main.slice(main.indexOf("app.on('will-quit'"), main.indexOf("app.on('window-all-closed'"));
  assert.match(hold, /event\.preventDefault\(\);/);
  // 0.1.38: the stop carries why the run ended (app_exit), none on a smoke test.
  assert.match(hold, /stats\.stop\(SMOKE \? '' : exitReason \|\| 'other'\)\.catch\(\(\) => \{\}\)\.finally\(\(\) => app\.exit\(0\)\)/);
  assert.doesNotMatch(hold, /app\.quit\(\)/);
});
