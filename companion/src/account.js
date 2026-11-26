// The optional Nūs account (Option B, docs/accounts-b.md). Sign in with Google
// through Supabase Auth, offered in Home and never needed: a signed-out
// Companion is exactly the anonymous install it always was, and this module
// makes no network call until the person presses Sign in.
//
// Plain fetch and Node crypto, no SDK, like stats.js: the Companion build
// leaves @supabase out. The flow is PKCE (RFC 7636): a verifier made here, its
// S256 challenge sent to /auth/v1/authorize, the code that comes back to a
// loopback server on 127.0.0.1 traded for a session with the verifier. A code
// minted for any other verifier fails the trade, so a forged callback cannot
// sign anyone in. The loopback port is one of three fixed ones because the
// Supabase redirect allowlist matches exact URLs; it listens before the
// browser opens and closes after one callback or five minutes.
//
// The session is kept with the host's secret store (safeStorage, DPAPI). When
// the OS has no encryption the session lives in memory only, signed in until
// quit, and is never written in plain text. Offline, a stored session still
// counts as signed in; a refresh that fails on the network keeps it, and only
// the server saying the refresh token is dead signs this computer out.
//
// Electron-free on purpose so it runs under node --test: the host passes the
// secret store, fetch, a browser opener and the clock.
const http = require('http');
const crypto = require('crypto');

// The project's publishable key (src/config.js carries the same one). It only
// identifies the project to Supabase; row level security does the guarding.
const SUPABASE_URL = 'https://xnpkplcjurzwanotmwwt.supabase.co';
const ANON_KEY = 'sb_publishable_yBEA9loOsDI9E_HMFIVCRQ_PZvTD8rB';
const HOST = '127.0.0.1';
const PORTS = [47821, 47822, 47823];
const CALLBACK_PATH = '/auth/callback';
const SESSION_KEY = 'companion-account-session';
const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;
const HEALTH_TIMEOUT_MS = 5000;
const REQUEST_TIMEOUT_MS = 10000;
// Refresh a minute early so a request never leaves with a token about to lapse.
const REFRESH_EARLY_S = 60;

const UNREACHABLE = 'Nūs sign-in is unreachable right now. Everything else still works; try again in a few minutes.';
const DONE_PAGE = '<!doctype html><meta charset="utf-8"><title>Nūs</title><body style="font:16px system-ui;padding:40px;background:#0b0d12;color:#e8eaf0"><p>You are signed in to Nūs. You can close this tab.</p>';
const FAIL_PAGE = '<!doctype html><meta charset="utf-8"><title>Nūs</title><body style="font:16px system-ui;padding:40px;background:#0b0d12;color:#e8eaf0"><p>Sign-in did not finish. Go back to Nūs and try again.</p>';

function base64url(buf) { return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }

// 32 random bytes as base64url is 43 characters, the RFC's minimum length.
function pkcePair(random = crypto.randomBytes) {
  const verifier = base64url(random(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function redirectUrl(port) { return `http://${HOST}:${port}${CALLBACK_PATH}`; }

function authorizeUrl({ url = SUPABASE_URL, port, challenge }) {
  const q = new URLSearchParams({ provider: 'google', redirect_to: redirectUrl(port), code_challenge: challenge, code_challenge_method: 's256' });
  return `${url}/auth/v1/authorize?${q}`;
}

// What came back to the loopback server: one code, or the provider's error.
function parseCallback(rawPath) {
  let parsed;
  try { parsed = new URL(String(rawPath), `http://${HOST}`); } catch { return { error: 'Invalid sign-in callback.' }; }
  if (parsed.pathname !== CALLBACK_PATH) return { error: 'Rejected an unexpected sign-in callback.', ignore: true };
  const error = parsed.searchParams.get('error_description') || parsed.searchParams.get('error');
  if (error) return { error: String(error).slice(0, 300) };
  const codes = parsed.searchParams.getAll('code');
  if (codes.length > 1) return { error: 'Rejected a duplicate sign-in code.' };
  if (codes[0] && /^[A-Za-z0-9._~-]{8,512}$/.test(codes[0])) return { code: codes[0] };
  return { error: 'The sign-in callback did not contain a code.' };
}

function isNetworkError(error) {
  if (!error) return false;
  const text = [error.name, error.message, error.cause && error.cause.code, error.cause && error.cause.message].filter(Boolean).join(' ');
  return /AbortError|fetch failed|failed to fetch|network|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|ETIMEDOUT|aborted/i.test(text);
}

// Only what the Companion needs from Supabase's session answer. Never the
// provider tokens Google hands back, never the user metadata.
function toSession(body, now) {
  if (!body || typeof body.access_token !== 'string' || typeof body.refresh_token !== 'string' || !body.user || !body.user.id) return null;
  const expiresAt = Number.isFinite(Number(body.expires_at)) ? Number(body.expires_at)
    : Math.floor(now() / 1000) + (Number(body.expires_in) || 3600);
  return { access_token: body.access_token, refresh_token: body.refresh_token, expires_at: expiresAt,
    user: { id: String(body.user.id), email: typeof body.user.email === 'string' ? body.user.email : '' } };
}

/**
 * @param {object} o
 * @param {{available: () => boolean, get: (k: string) => string|null, set: (k: string, v: string) => void, remove: (k: string) => void}} o.secrets
 * @param {(url: string) => any} o.openExternal   opens the system browser
 * @param {Function} [o.fetch]
 * @param {() => number} [o.now]
 * @param {string} [o.url]  [o.anonKey]  [o.ports]  [o.timeoutMs]  for tests
 * @param {Function} [o.createServer]  http.createServer by default
 * @param {(state: object) => void} [o.onChange]
 */
function createAccount(o) {
  const fetchFn = o.fetch || globalThis.fetch;
  const now = o.now || Date.now;
  const url = o.url || SUPABASE_URL;
  const anonKey = o.anonKey || ANON_KEY;
  const ports = o.ports || PORTS;
  const timeoutMs = o.timeoutMs || SIGN_IN_TIMEOUT_MS;
  const createServer = o.createServer || http.createServer;
  let session = null;
  let restored = false;
  let pending = null;     // the sign-in in flight: { cancel }
  let refreshing = null;  // one refresh at a time
  let offline = false;
  let lastError = '';

  function secure() { try { return !!o.secrets.available(); } catch { return false; } }
  function changed() { try { if (o.onChange) o.onChange(status()); } catch { /* the host's problem */ } }

  function restore() {
    if (restored) return session;
    restored = true;
    if (!secure()) return null;
    try {
      const raw = o.secrets.get(SESSION_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      session = parsed && parsed.refresh_token && parsed.user && parsed.user.id ? parsed : null;
    } catch { session = null; }
    return session;
  }
  function keep(next) {
    session = next;
    restored = true;
    if (!secure()) return;
    try { if (next) o.secrets.set(SESSION_KEY, JSON.stringify(next)); else o.secrets.remove(SESSION_KEY); } catch { /* memory copy still holds */ }
  }

  async function request(path, { method = 'POST', body, token, timeout = REQUEST_TIMEOUT_MS } = {}) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    try {
      const headers = { apikey: anonKey, 'Content-Type': 'application/json' };
      if (token) headers.Authorization = `Bearer ${token}`;
      const res = await fetchFn(url + path, { method, headers, body: body == null ? undefined : JSON.stringify(body), signal: ctl.signal });
      const text = typeof res.text === 'function' ? await res.text() : '';
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = null; }
      return { status: Number(res.status) || 0, json };
    } finally { clearTimeout(timer); }
  }

  // Any HTTP answer counts as reachable; only a transport failure does not.
  async function reachable() {
    try { await request('/auth/v1/health', { method: 'GET', timeout: HEALTH_TIMEOUT_MS }); return true; } catch { return false; }
  }

  function listen(handler) {
    return new Promise((resolve, reject) => {
      let i = 0;
      const next = () => {
        if (i >= ports.length) { reject(new Error('Every sign-in port is busy. Close other Nūs windows and try again.')); return; }
        const port = ports[i++];
        const server = createServer(handler);
        server.once('error', err => { try { server.close(); } catch {} if (err && err.code === 'EADDRINUSE') next(); else reject(err); });
        server.listen(port, HOST, () => resolve({ server, port }));
      };
      next();
    });
  }

  async function exchange(code, verifier) {
    const r = await request('/auth/v1/token?grant_type=pkce', { body: { auth_code: code, code_verifier: verifier } });
    const next = r.status >= 200 && r.status < 300 ? toSession(r.json, now) : null;
    if (!next) return { error: (r.json && (r.json.error_description || r.json.msg || r.json.error)) || 'Sign-in did not finish. Try again.' };
    return { session: next };
  }

  // Resolves when the browser comes back (or the attempt ends). A second
  // press while one is open cancels the first: the newest browser tab wins.
  async function signIn() {
    if (pending) pending.cancel('A newer sign-in took over.');
    lastError = '';
    if (typeof fetchFn !== 'function') return { ok: false, error: UNREACHABLE };
    if (!(await reachable())) { offline = true; changed(); return { ok: false, error: UNREACHABLE }; }
    offline = false;
    const { verifier, challenge } = pkcePair();
    let finish;
    const done = new Promise(resolve => { finish = resolve; });
    let settled = false;
    let server = null;
    let timer = null;
    const end = result => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (server) { try { server.close(); } catch {} }
      if (pending && pending.done === done) pending = null;
      if (result.error) lastError = result.error;
      finish(result);
      changed();
    };
    let opened;
    try {
      opened = await listen(async (req, res) => {
        const cb = parseCallback(req.url);
        if (cb.ignore || settled) { res.writeHead(404); res.end(); return; }
        if (cb.error) { res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(FAIL_PAGE); end({ ok: false, error: cb.error }); return; }
        let r;
        try { r = await exchange(cb.code, verifier); } catch (e) { r = { error: isNetworkError(e) ? UNREACHABLE : 'Sign-in did not finish. Try again.' }; }
        res.writeHead(r.session ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(r.session ? DONE_PAGE : FAIL_PAGE);
        if (r.session) { keep(r.session); end({ ok: true, ...status() }); } else end({ ok: false, error: r.error });
      });
    } catch (e) { lastError = e.message; changed(); return { ok: false, error: e.message }; }
    server = opened.server;
    timer = setTimeout(() => end({ ok: false, error: 'Sign-in timed out. Try again.' }), timeoutMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    pending = { done, cancel: reason => end({ ok: false, error: reason || 'Sign-in cancelled.', cancelled: true }) };
    changed();
    try { await o.openExternal(authorizeUrl({ url, port: opened.port, challenge })); }
    catch { end({ ok: false, error: 'Could not open the browser for sign-in.' }); }
    return done;
  }

  function cancelSignIn() { if (pending) pending.cancel('Sign-in cancelled.'); return status(); }

  async function refresh() {
    if (refreshing) return refreshing;
    const current = session;
    refreshing = (async () => {
      try {
        const r = await request('/auth/v1/token?grant_type=refresh_token', { body: { refresh_token: current.refresh_token } });
        if (r.status >= 200 && r.status < 300) {
          const next = toSession(r.json, now);
          if (next) { offline = false; keep(next); return next.access_token; }
        }
        // 400 or 401: the refresh token was revoked or used up. This computer
        // is signed out; nothing else is touched.
        if (r.status === 400 || r.status === 401 || r.status === 403) { keep(null); lastError = 'Your sign-in expired. Sign in again to keep syncing.'; changed(); return null; }
        offline = true;
        return null;
      } catch { offline = true; return null; }
      finally { refreshing = null; }
    })();
    return refreshing;
  }

  // A token for a request now, refreshed when it is about to lapse. Null when
  // signed out or offline; the caller falls back to its cache.
  async function accessToken() {
    restore();
    if (!session) return null;
    if (Number(session.expires_at) - REFRESH_EARLY_S > now() / 1000) return session.access_token;
    return refresh();
  }

  // An authorised call to the project: apikey, bearer, JSON both ways.
  async function call(path, { method = 'POST', body } = {}) {
    const token = await accessToken();
    if (!token) return { status: 0, json: null, signedOut: !session };
    try { return await request(path, { method, body, token }); }
    catch (e) { offline = true; return { status: 0, json: null, error: isNetworkError(e) ? 'network' : 'failed' }; }
  }

  // Server sign-out for this session only (other computers stay signed in),
  // then local. Local always happens, online or not.
  async function signOut() {
    restore();
    if (pending) pending.cancel('Sign-in cancelled.');
    const current = session;
    keep(null);
    lastError = '';
    if (current && typeof fetchFn === 'function') {
      try { await request('/auth/v1/logout?scope=local', { token: current.access_token, timeout: 4000 }); } catch { /* signed out here regardless */ }
    }
    changed();
    return status();
  }

  function status() {
    restore();
    return { signedIn: !!session, email: session ? session.user.email : '', userId: session ? session.user.id : '',
      signingIn: !!pending, offline, secure: secure(), error: lastError };
  }

  return { restore, status, signIn, cancelSignIn, signOut, accessToken, call, refresh, reachable };
}

module.exports = { createAccount, pkcePair, authorizeUrl, parseCallback, redirectUrl, toSession, isNetworkError,
  SUPABASE_URL, ANON_KEY, PORTS, CALLBACK_PATH, SESSION_KEY, UNREACHABLE };
