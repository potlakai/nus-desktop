const { createClient } = require('@supabase/supabase-js');
const config = require('./config');

let client = null;
let session = null;

function init() {
  if (!config.isSupabaseConfigured(config)) return false;
  if (client) return true;
  client = createClient(config.supabase.url, config.supabase.anonKey, {
    auth: { persistSession: false, autoRefreshToken: true, detectSessionInUrl: false },
  });
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

async function logout() {
  if (!client) { session = null; return { ok: true }; }
  await client.auth.signOut();
  session = null;
  return { ok: true };
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
  loginWithEmail, signUpWithEmail, loginWithGoogle, logout,
  getSession, getUser, getAccessToken, getUserId,
};