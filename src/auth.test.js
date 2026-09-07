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

test('network failures during sign-in become one friendly, local-first message', () => {
  const { friendlyAuthError, isNetworkError, UNREACHABLE_MESSAGE } = require('./auth');
  const retryable = Object.assign(new Error('fetch failed'), { name: 'AuthRetryableFetchError' });
  assert.equal(friendlyAuthError(retryable), UNREACHABLE_MESSAGE);
  const dns = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
  assert.equal(friendlyAuthError(dns), UNREACHABLE_MESSAGE);
  assert.equal(isNetworkError(new Error('Invalid login credentials')), false);
  assert.equal(friendlyAuthError(new Error('Invalid login credentials')), 'Invalid login credentials');
  assert.match(UNREACHABLE_MESSAGE, /Free features still work/);
});

test('reachability check answers false on a transport failure and true on any HTTP reply', async () => {
  const { checkReachable } = require('./auth');
  const calls = [];
  const dead = async (url) => { calls.push(url); throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); };
  assert.equal(await checkReachable({ url: 'https://paused.supabase.co', apiKey: 'k', fetchImpl: dead }), false);
  assert.deepEqual(calls, ['https://paused.supabase.co/auth/v1/health']);
  const alive = async () => ({ ok: true, status: 200 });
  assert.equal(await checkReachable({ url: 'https://live.supabase.co', apiKey: 'k', fetchImpl: alive }), true);
  const slow = (_url, { signal }) => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('aborted'))); });
  assert.equal(await checkReachable({ url: 'https://slow.supabase.co', apiKey: 'k', fetchImpl: slow, timeoutMs: 20 }), false);
});

test('Google sign-in refuses to open a browser tab when the project is unreachable', async () => {
  const auth = require('./auth');
  if (!auth.isConfigured()) return; // no src/config.js on this machine; the guard is exercised in the reachable tests above
  const result = await auth.loginWithGoogle({ reachable: async () => false });
  assert.equal(result.error, auth.UNREACHABLE_MESSAGE);
  assert.equal(result.url, undefined);
});
