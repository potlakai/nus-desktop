const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');
const net = require('net');
const { createAccount, pkcePair, authorizeUrl, parseCallback, toSession, SESSION_KEY, UNREACHABLE } = require('../src/account');

const URL_ = 'https://project.example';

function freePort() {
  return new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}

// A secret store in a Map, with the encryption switch the host would read
// from safeStorage.
function vault(available = true) {
  const m = new Map();
  return { m, available: () => available, get: k => (m.has(k) ? m.get(k) : null), set: (k, v) => { m.set(k, v); }, remove: k => { m.delete(k); } };
}

// The Supabase side: health, the PKCE trade (checks the verifier against the
// challenge it saw at /authorize), refresh, logout.
function project(opts = {}) {
  const calls = [];
  const challenges = new Map();
  let n = 0;
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ path: u.pathname + u.search, body, headers: init.headers || {} });
    if (opts.down) throw Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    const answer = (status, json) => ({ status, text: async () => (json == null ? '' : JSON.stringify(json)) });
    if (u.pathname === '/auth/v1/health') return answer(200, { ok: true });
    if (u.pathname === '/auth/v1/token' && u.searchParams.get('grant_type') === 'pkce') {
      const want = challenges.get(body.auth_code);
      const got = crypto.createHash('sha256').update(body.code_verifier).digest('base64url');
      if (!want || want !== got) return answer(400, { error: 'invalid_grant', error_description: 'code challenge does not match previously saved code verifier' });
      n += 1;
      return answer(200, { access_token: 'at' + n, refresh_token: 'rt' + n, expires_in: 3600, expires_at: opts.expiresAt || Math.floor(Date.now() / 1000) + 3600, user: { id: 'u1', email: 'a@b.co', user_metadata: { full_name: 'A' } }, provider_token: 'google-secret' });
    }
    if (u.pathname === '/auth/v1/token' && u.searchParams.get('grant_type') === 'refresh_token') {
      if (opts.refresh) return opts.refresh(answer, body);
      n += 1;
      return answer(200, { access_token: 'at' + n, refresh_token: 'rt' + n, expires_in: 3600, user: { id: 'u1', email: 'a@b.co' } });
    }
    if (u.pathname === '/auth/v1/logout') return answer(204, null);
    return answer(404, null);
  };
  // What Supabase does at /authorize: remember the challenge under a new code.
  const authorize = href => { const q = new URL(href).searchParams; const code = 'code' + crypto.randomBytes(6).toString('hex'); challenges.set(code, q.get('code_challenge')); return { code, redirect: q.get('redirect_to'), q }; };
  return { fetch, calls, authorize };
}

function get(href) {
  return new Promise((resolve, reject) => { http.get(href, res => { let b = ''; res.on('data', d => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); }).on('error', reject); });
}

test('the PKCE pair is a 43 character verifier and its S256 challenge', () => {
  const { verifier, challenge } = pkcePair();
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(challenge, crypto.createHash('sha256').update(verifier).digest('base64url'));
  const href = new URL(authorizeUrl({ url: URL_, port: 47821, challenge }));
  assert.equal(href.pathname, '/auth/v1/authorize');
  assert.equal(href.searchParams.get('provider'), 'google');
  assert.equal(href.searchParams.get('redirect_to'), 'http://127.0.0.1:47821/auth/callback');
  assert.equal(href.searchParams.get('code_challenge_method'), 's256');
  assert.equal(href.searchParams.get('code_challenge'), challenge);
  assert.equal(href.toString().includes(verifier), false, 'the verifier never leaves in the URL');
});

test('the callback parser takes one code and refuses the rest', () => {
  assert.deepEqual(parseCallback('/auth/callback?code=abcdefgh123'), { code: 'abcdefgh123' });
  assert.equal(parseCallback('/favicon.ico').ignore, true);
  assert.match(parseCallback('/auth/callback?code=abcdefgh1&code=abcdefgh2').error, /duplicate/);
  assert.match(parseCallback('/auth/callback?error=access_denied&error_description=User%20said%20no').error, /User said no/);
  assert.match(parseCallback('/auth/callback').error, /did not contain/);
  assert.match(parseCallback('/auth/callback?code=%3Cscript%3E').error, /did not contain/);
});

test('toSession keeps the tokens and the user id and email, never provider tokens or metadata', () => {
  const s = toSession({ access_token: 'a', refresh_token: 'r', expires_in: 60, user: { id: 'u', email: 'e@x', user_metadata: { picture: 'p' } }, provider_token: 'g' }, () => 1000_000);
  assert.deepEqual(s, { access_token: 'a', refresh_token: 'r', expires_at: 1000 + 60, user: { id: 'u', email: 'e@x' } });
  assert.equal(toSession({ access_token: 'a' }, Date.now), null);
});

test('sign in: listens, opens the browser, trades the code with the verifier, keeps the session encrypted', async () => {
  const p = project();
  const store = vault();
  const ports = [await freePort()];
  let opened = null;
  const account = createAccount({ secrets: store, fetch: p.fetch, url: URL_, ports,
    openExternal: async href => { opened = href; const a = p.authorize(href); const r = await get(a.redirect + '?code=' + a.code); assert.equal(r.status, 200); assert.match(r.body, /signed in/); } });
  assert.equal(account.status().signedIn, false);
  const r = await account.signIn();
  assert.equal(r.ok, true);
  assert.equal(r.email, 'a@b.co');
  assert.ok(opened.startsWith(URL_ + '/auth/v1/authorize?'));
  const saved = JSON.parse(store.get(SESSION_KEY));
  assert.deepEqual(Object.keys(saved).sort(), ['access_token', 'expires_at', 'refresh_token', 'user']);
  assert.equal(JSON.stringify(saved).includes('google-secret'), false);
  const trade = p.calls.find(c => c.path === '/auth/v1/token?grant_type=pkce');
  assert.equal(trade.headers.apikey !== undefined, true);
  // The port is closed again once the callback came back.
  await assert.rejects(get(`http://127.0.0.1:${ports[0]}/auth/callback?code=abcdefgh123`));
});

test('a code minted for another verifier does not sign in', async () => {
  const p = project();
  const store = vault();
  const ports = [await freePort()];
  const account = createAccount({ secrets: store, fetch: p.fetch, url: URL_, ports,
    openExternal: async href => { const a = p.authorize(authorizeUrl({ url: URL_, port: ports[0], challenge: pkcePair().challenge })); await get(new URL(href).searchParams.get('redirect_to') + '?code=' + a.code); } });
  const r = await account.signIn();
  assert.equal(r.ok, false);
  assert.match(r.error, /code verifier/);
  assert.equal(store.get(SESSION_KEY), null);
  assert.equal(account.status().signedIn, false);
});

test('stray requests to the loopback port are ignored until the real callback arrives', async () => {
  const p = project();
  const ports = [await freePort()];
  const account = createAccount({ secrets: vault(), fetch: p.fetch, url: URL_, ports,
    openExternal: async href => { const a = p.authorize(href); assert.equal((await get(`http://127.0.0.1:${ports[0]}/favicon.ico`)).status, 404); await get(a.redirect + '?code=' + a.code); } });
  assert.equal((await account.signIn()).ok, true);
});

test('a busy first port moves to the next one', async () => {
  const busy = await freePort();
  const blocker = net.createServer().listen(busy, '127.0.0.1');
  await new Promise(r => blocker.once('listening', r));
  const p = project();
  const second = await freePort();
  let redirect = '';
  const account = createAccount({ secrets: vault(), fetch: p.fetch, url: URL_, ports: [busy, second],
    openExternal: async href => { const a = p.authorize(href); redirect = a.redirect; await get(a.redirect + '?code=' + a.code); } });
  try { assert.equal((await account.signIn()).ok, true); assert.equal(redirect, `http://127.0.0.1:${second}/auth/callback`); }
  finally { blocker.close(); }
});

test('unreachable: no browser opens, no port listens, the plain message comes back', async () => {
  const p = project({ down: true });
  let opened = false;
  const account = createAccount({ secrets: vault(), fetch: p.fetch, url: URL_, ports: [await freePort()], openExternal: () => { opened = true; } });
  const r = await account.signIn();
  assert.deepEqual([r.ok, r.error, opened], [false, UNREACHABLE, false]);
  assert.equal(account.status().offline, true);
});

test('the attempt times out and frees the port', async () => {
  const p = project();
  const port = await freePort();
  const account = createAccount({ secrets: vault(), fetch: p.fetch, url: URL_, ports: [port], timeoutMs: 50, openExternal: () => {} });
  const r = await account.signIn();
  assert.match(r.error, /timed out/);
  assert.equal(account.status().signingIn, false);
  await assert.rejects(get(`http://127.0.0.1:${port}/auth/callback?code=abcdefgh123`));
});

test('the provider saying no ends the attempt with its words', async () => {
  const p = project();
  const account = createAccount({ secrets: vault(), fetch: p.fetch, url: URL_, ports: [await freePort()],
    openExternal: async href => { await get(new URL(href).searchParams.get('redirect_to') + '?error=access_denied&error_description=Cancelled%20by%20user'); } });
  const r = await account.signIn();
  assert.deepEqual([r.ok, r.error], [false, 'Cancelled by user']);
});

test('no encryption on the PC: signed in for this run only, nothing written', async () => {
  const p = project();
  const store = vault(false);
  const account = createAccount({ secrets: store, fetch: p.fetch, url: URL_, ports: [await freePort()],
    openExternal: async href => { const a = p.authorize(href); await get(a.redirect + '?code=' + a.code); } });
  assert.equal((await account.signIn()).ok, true);
  assert.equal(account.status().signedIn, true);
  assert.equal(account.status().secure, false);
  assert.equal(store.m.size, 0);
  const later = createAccount({ secrets: store, fetch: p.fetch, url: URL_, openExternal: () => {} });
  assert.equal(later.status().signedIn, false);
});

function signedInStore(expiresAt) {
  const store = vault();
  store.set(SESSION_KEY, JSON.stringify({ access_token: 'old', refresh_token: 'rt0', expires_at: expiresAt, user: { id: 'u1', email: 'a@b.co' } }));
  return store;
}

test('a stored session restores with no network call', () => {
  let calls = 0;
  const account = createAccount({ secrets: signedInStore(2e9), fetch: async () => { calls += 1; }, url: URL_, openExternal: () => {} });
  assert.deepEqual([account.status().signedIn, account.status().email, calls], [true, 'a@b.co', 0]);
});

test('a signed-out install makes no network call at all', async () => {
  let calls = 0;
  const account = createAccount({ secrets: vault(), fetch: async () => { calls += 1; }, url: URL_, openExternal: () => {} });
  account.restore();
  assert.equal(await account.accessToken(), null);
  assert.equal((await account.call('/rest/v1/x')).signedOut, true);
  assert.equal(calls, 0);
});

test('a fresh token is used as is; a lapsing one refreshes once even with two callers', async () => {
  const fresh = createAccount({ secrets: signedInStore(Math.floor(Date.now() / 1000) + 3600), fetch: project().fetch, url: URL_, openExternal: () => {} });
  assert.equal(await fresh.accessToken(), 'old');
  const p = project();
  const store = signedInStore(Math.floor(Date.now() / 1000) + 10);
  const account = createAccount({ secrets: store, fetch: p.fetch, url: URL_, openExternal: () => {} });
  const [a, b] = await Promise.all([account.accessToken(), account.accessToken()]);
  assert.equal(a, 'at1');
  assert.equal(b, 'at1');
  assert.equal(p.calls.filter(c => c.path.includes('refresh_token')).length, 1);
  assert.equal(JSON.parse(store.get(SESSION_KEY)).refresh_token, 'rt1');
});

test('offline refresh keeps the session; a revoked refresh token signs this computer out', async () => {
  const store = signedInStore(1);
  const down = createAccount({ secrets: store, fetch: project({ down: true }).fetch, url: URL_, openExternal: () => {} });
  assert.equal(await down.accessToken(), null);
  assert.deepEqual([down.status().signedIn, down.status().offline], [true, true]);
  assert.ok(store.get(SESSION_KEY));
  const revoked = createAccount({ secrets: store, fetch: project({ refresh: answer => answer(400, { error: 'invalid_grant' }) }).fetch, url: URL_, openExternal: () => {} });
  assert.equal(await revoked.accessToken(), null);
  assert.equal(revoked.status().signedIn, false);
  assert.match(revoked.status().error, /expired/);
  assert.equal(store.get(SESSION_KEY), null);
});

test('sign out clears this computer first and tells the server for this session only', async () => {
  const p = project();
  const store = signedInStore(2e9);
  const account = createAccount({ secrets: store, fetch: p.fetch, url: URL_, openExternal: () => {} });
  const s = await account.signOut();
  assert.equal(s.signedIn, false);
  assert.equal(store.get(SESSION_KEY), null);
  const out = p.calls.find(c => c.path.startsWith('/auth/v1/logout'));
  assert.equal(out.path, '/auth/v1/logout?scope=local');
  assert.equal(out.headers.Authorization, 'Bearer old');
});

test('sign out offline still signs out here', async () => {
  const store = signedInStore(2e9);
  const account = createAccount({ secrets: store, fetch: project({ down: true }).fetch, url: URL_, openExternal: () => {} });
  assert.equal((await account.signOut()).signedIn, false);
  assert.equal(store.get(SESSION_KEY), null);
});

test('call sends the apikey and bearer to the project', async () => {
  const p = project();
  const account = createAccount({ secrets: signedInStore(2e9), fetch: p.fetch, url: URL_, openExternal: () => {} });
  const r = await account.call('/rest/v1/rpc/thing', { body: { a: 1 } });
  assert.equal(r.status, 404);
  const c = p.calls.at(-1);
  assert.deepEqual([c.path, c.headers.Authorization, typeof c.headers.apikey, c.body], ['/rest/v1/rpc/thing', 'Bearer old', 'string', { a: 1 }]);
});
