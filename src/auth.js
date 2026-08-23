const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const config = require('./config');
const secrets = require('./secrets');

let client = null;
let session = null;

function storageKey(key) {
  return `supabase-session-${crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 24)}`;
}

function createSecretStorage(secretStore = secrets) {
  return {
    getItem(key) {
      return secretStore.getSecret(storageKey(key));
    },
    setItem(key, value) {
      if (!secretStore.isAvailable()) throw new Error('Secure session storage is unavailable on this device.');
      secretStore.setSecret(storageKey(key), value);
    },
    removeItem(key) {
      secretStore.deleteSecret(storageKey(key));
    },
  };
}

function init() {
  if (!config.isSupabaseConfigured(config)) return false;
  if (client) return true;
  client = createClient(config.supabase.url, config.supabase.anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      flowType: 'pkce',
      storage: createSecretStorage(),
    },
  });
  client.auth.onAuthStateChange((_event, nextSession) => { session = nextSession; });
  return true;
}

function isConfigured() {
  return init();
}

async function restoreSession() {
  if (!init()) return null;
  const { data, error } = await client.auth.getSession();
  if (error || !data.session) { session = null; return null; }
  session = data.session;
  return session;
}

async function loginWithEmail(email, password) {
  if (!init()) return { error: 'Supabase is not configured. See docs/credentials-needed.md.' };
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) return { error: error.message };
  session = data.session;
  return { session: data.session, user: data.user };
}

async function signUpWithEmail(email, password) {
  if (!init()) return { error: 'Supabase is not configured.' };
  const { data, error } = await client.auth.signUp({ email, password });
  if (error) return { error: error.message };
  session = data.session;
  return { session: data.session, user: data.user };
}

async function loginWithGoogle() {
  if (!init()) return { error: 'Supabase is not configured.' };
  const { data, error } = await client.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: 'nus-desktop://auth/callback' },
  });
  if (error) return { error: error.message };
  return { url: data?.url || null };
}

function parseCallbackUrl(callbackUrl) {
  let parsed;
  try { parsed = new URL(String(callbackUrl)); } catch { return { error: 'Invalid sign-in callback.' }; }
  if (parsed.protocol !== 'nus-desktop:' || parsed.hostname !== 'auth' || parsed.pathname !== '/callback') {
    return { error: 'Rejected an unexpected sign-in callback.' };
  }
  const error = parsed.searchParams.get('error_description') || parsed.searchParams.get('error');
  if (error) return { error };
  const codes = parsed.searchParams.getAll('code');
  if (codes.length > 1) return { error: 'Rejected a duplicate sign-in code.' };
  if (codes[0]) return { code: codes[0] };
  const hash = new URLSearchParams(parsed.hash.replace(/^#/, ''));
  const hashError = hash.get('error_description') || hash.get('error');
  if (hashError) return { error: hashError };
  const accessToken = hash.get('access_token');
  const refreshToken = hash.get('refresh_token');
  if (accessToken && refreshToken) return { accessToken, refreshToken };
  return { error: 'The sign-in callback did not contain a session.' };
}

async function completeOAuthCallback(authClient, callbackUrl) {
  const callback = parseCallbackUrl(callbackUrl);
  if (callback.error) return { error: callback.error };
  const result = callback.code
    ? await authClient.auth.exchangeCodeForSession(callback.code)
    : await authClient.auth.setSession({ access_token: callback.accessToken, refresh_token: callback.refreshToken });
  if (result.error) return { error: result.error.message };
  return { session: result.data.session, user: result.data.user || result.data.session?.user || null };
}

async function handleOAuthCallback(callbackUrl) {
  if (!init()) return { error: 'Supabase is not configured.' };
  const result = await completeOAuthCallback(client, callbackUrl);
  if (result.session) session = result.session;
  return result;
}

async function logout() {
  if (!client) { session = null; return { ok: true }; }
  const { error } = await client.auth.signOut();
  if (error) {
    // A network failure must not trap the user in a local signed-in state.
    await client.auth.signOut({ scope: 'local' }).catch(() => {});
  }
  session = null;
  return error ? { ok: true, warning: error.message } : { ok: true };
}

function getSession() {
  return session;
}

function getUser() {
  return session?.user || null;
}

function getAccessToken() {
  return session?.access_token || null;
}

function getUserId() {
  return session?.user?.id || null;
}

module.exports = {
  init, isConfigured, restoreSession,
  loginWithEmail, signUpWithEmail, loginWithGoogle, handleOAuthCallback, logout,
  getSession, getUser, getAccessToken, getUserId,
  createSecretStorage, parseCallbackUrl, completeOAuthCallback,
};
