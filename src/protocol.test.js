const { test } = require('node:test');
const assert = require('node:assert');
const { findProtocolUrl, routeProtocolUrl, dataDirFromArgv, friendlySignInError } = require('./protocol');

test('protocol callback is found in Windows second-instance arguments', () => {
  const url = 'nus-desktop://auth/callback?code=abc';
  assert.equal(findProtocolUrl(['Nus.exe', '--flag', url]), url);
  assert.equal(findProtocolUrl(['Nus.exe', '--flag']), null);
});

test('protocol matching is case-insensitive but rejects lookalike schemes', () => {
  assert.equal(findProtocolUrl(['NUS-DESKTOP://auth/callback?code=abc']), 'NUS-DESKTOP://auth/callback?code=abc');
  assert.equal(findProtocolUrl(['nus-desktop-evil://auth/callback?code=abc']), null);
});

test('protocol links route to auth, billing, or nowhere', () => {
  assert.equal(routeProtocolUrl('nus-desktop://auth/callback?code=abc'), 'auth');
  assert.equal(routeProtocolUrl('nus-desktop://billing/success'), 'billing');
  assert.equal(routeProtocolUrl('nus-desktop://billing/success?session_id=cs_test'), 'billing');
  assert.equal(routeProtocolUrl('nus-desktop://auth/other'), 'ignore');
  assert.equal(routeProtocolUrl('nus-desktop://evil/callback'), 'ignore');
  assert.equal(routeProtocolUrl('https://auth/callback?code=abc'), 'ignore');
  assert.equal(routeProtocolUrl('not a url'), 'ignore');
});

test('an isolated profile rides along in the protocol registration', () => {
  assert.equal(dataDirFromArgv(['Nus.exe', '--data-dir=C:/tmp/p']), 'C:/tmp/p');
  assert.equal(dataDirFromArgv(['Nus.exe', '--data-dir', 'D:/x']), 'D:/x');
  const calls = [];
  const app = { setAsDefaultProtocolClient: (...args) => { calls.push(args); return true; } };
  const { registerProtocolClient } = require('./protocol');
  registerProtocolClient(app, ['Nus.exe', '--data-dir=C:/tmp/p']);
  assert.equal(calls[0][0], 'nus-desktop');
  assert.match(calls[0][2][calls[0][2].length - 1], /^--data-dir=/);
});

test('sign-in errors are rewritten for students', () => {
  assert.match(friendlySignInError('PKCE code verifier not found in storage. For SSR frameworks...'), /different copy of Nūs/);
  assert.match(friendlySignInError('fetch failed'), /reach the sign-in service/);
  assert.equal(friendlySignInError('Something else'), 'Something else');
});
