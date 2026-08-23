const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

for (const file of ['gcal.js', 'outlook.js']) {
  test(`${file} listens before opening the browser and clears transient PKCE state`, () => {
    const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
    const listenAt = source.indexOf('server.listen(redirectPort');
    const openAt = source.indexOf('shell.openExternal(authUrl)', listenAt);
    assert.ok(listenAt >= 0 && openAt > listenAt, 'callback server must listen before the browser can return');
    assert.match(source, /deleteSecret\(['"](?:gcal|outlook)_pkce_verifier['"]\)/);
    assert.match(source, /callbackInProgress/);
  });
}
