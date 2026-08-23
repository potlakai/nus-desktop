const { test } = require('node:test');
const assert = require('node:assert');
const { createSecretStorage, parseCallbackUrl, completeOAuthCallback } = require('./auth');

test('Supabase sessions use the encrypted secret adapter and survive a new adapter', () => {
  const values = new Map();
  const fakeSecrets = {
    isAvailable: () => true,
    getSecret: (key) => values.get(key) || null,
    setSecret: (key, value) => values.set(key, value),
    deleteSecret: (key) => values.delete(key),
  };
  const first = createSecretStorage(fakeSecrets);
  first.setItem('sb-project-auth-token', 'session-json');
  assert.equal(createSecretStorage(fakeSecrets).getItem('sb-project-auth-token'), 'session-json');
  first.removeItem('sb-project-auth-token');
  assert.equal(first.getItem('sb-project-auth-token'), null);
});

test('session persistence refuses a plaintext fallback', () => {
  const storage = createSecretStorage({
    isAvailable: () => false,
    getSecret: () => null,
    setSecret: () => assert.fail('must not write plaintext'),
    deleteSecret: () => {},
  });
  assert.throws(() => storage.setItem('token', 'secret'), /Secure session storage/);
});

test('OAuth callback accepts only the registered Nūs auth route', () => {
  assert.deepEqual(parseCallbackUrl('nus-desktop://auth/callback?code=abc'), { code: 'abc' });
  assert.match(parseCallbackUrl('nus-desktop://auth/callback?code=abc&code=def').error, /duplicate/);
  assert.match(parseCallbackUrl('nus-desktop://settings/callback?code=abc').error, /unexpected/);
  assert.match(parseCallbackUrl('https://auth/callback?code=abc').error, /unexpected/);
});

test('PKCE callback exchanges its code and returns the session', async () => {
  const calls = [];
  const fakeClient = { auth: {
    exchangeCodeForSession: async (code) => {
      calls.push(code);
      return { data: { session: { access_token: 'a', user: { id: 'u1' } }, user: { id: 'u1' } }, error: null };
    },
  } };
  const result = await completeOAuthCallback(fakeClient, 'nus-desktop://auth/callback?code=pkce-code');
  assert.deepEqual(calls, ['pkce-code']);
  assert.equal(result.user.id, 'u1');
});
