const { test } = require('node:test');
const assert = require('node:assert');
const { findProtocolUrl, routeProtocolUrl, dataDirFromArgv, friendlySignInError } = require('./protocol');

test('protocol callback is found in Windows second-instance arguments', () => {
  const url = 'jarvis://auth/callback?code=abc';
  assert.equal(findProtocolUrl(['Nus.exe', '--flag', url]), url);
  assert.equal(findProtocolUrl(['Nus.exe', '--flag']), null);
});

test('protocol matching is case-insensitive but rejects lookalike schemes', () => {
  assert.equal(findProtocolUrl(['JARVIS://auth/callback?code=abc']), 'JARVIS://auth/callback?code=abc');
  assert.equal(findProtocolUrl(['jarvis-evil://auth/callback?code=abc']), null);
});

test('protocol links route to auth, billing, acquire, or nowhere', () => {
  assert.equal(routeProtocolUrl('jarvis://auth/callback?code=abc'), 'auth');
  assert.equal(routeProtocolUrl('jarvis://billing/success'), 'billing');
  assert.equal(routeProtocolUrl('jarvis://billing/success?session_id=cs_test'), 'billing');
  assert.equal(routeProtocolUrl('jarvis://acquire?tok=N1.abc.0123456789'), 'acquire');
  assert.equal(routeProtocolUrl('jarvis://acquire/extra?tok=x'), 'ignore');
  assert.equal(routeProtocolUrl('jarvis://auth/other'), 'ignore');
  assert.equal(routeProtocolUrl('jarvis://evil/callback'), 'ignore');
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
  assert.equal(calls[0][0], 'jarvis');
  assert.match(calls[0][2][calls[0][2].length - 1], /^--data-dir=/);
});

test('sign-in errors are rewritten in plain words', () => {
  assert.match(friendlySignInError('PKCE code verifier not found in storage. For SSR frameworks...'), /different copy of J\.A\.R\.V\.I\.S/);
  assert.match(friendlySignInError('fetch failed'), /reach the sign-in service/);
  assert.equal(friendlySignInError('Something else'), 'Something else');
});
