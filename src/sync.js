const config = require('./config');
const auth = require('./auth');
const { createClient } = require('@supabase/supabase-js');

const SYNC_TABLE = 'nus_user_snapshots';

let syncClient = null;

function init() {
  if (!config.isSupabaseConfigured(config)) return false;
  if (syncClient) return true;
  syncClient = createClient(config.supabase.url, config.supabase.anonKey, {
    auth: { persistSession: false, autoRefreshToken: true },
  });
  return true;
}

async function isSyncEnabled() {
  // sync requires both config + an active session + an explicit user preference
  if (!init()) return false;
  const { getPreferences } = require('./db').api;
  const prefs = getPreferences();
  return prefs.cloud_sync_enabled === true && auth.getUserId() !== null;
}

async function setSyncEnabled(enabled) {
  const { api } = require('./db');
  api.setPreference('cloud_sync_enabled', Boolean(enabled));
  if (!enabled) await deleteCloudData();
  return { enabled: Boolean(enabled) };
}

async function pushSnapshot(snapshot) {
  if (!init()) return { error: 'not_configured' };
  if (!auth.getUserId()) return { error: 'not_authenticated' };
  const enabled = await isSyncEnabled();
  if (!enabled) return { skipped: true };

  const userId = auth.getUserId();
  const accessToken = auth.getAccessToken();
  const { error } = await syncClient
    .from(SYNC_TABLE)
    .upsert(
      {
        user_id: userId,
        snapshot,
        updated_at: new Date().toISOString(),
        schema_version: snapshot?.schema_version || 1,
      },
      { onConflict: 'user_id' }
    )
    .setHeaders(accessToken ? { Authorization: `Bearer ${accessToken}` } : {});

  if (error) return { error: error.message };
  return { ok: true };
}

async function pullSnapshot() {
  if (!init()) return { error: 'not_configured' };
  if (!auth.getUserId()) return { error: 'not_authenticated' };
  const userId = auth.getUserId();
  const accessToken = auth.getAccessToken();
  const { data, error } = await syncClient
    .from(SYNC_TABLE)
    .select('snapshot, updated_at')
    .eq('user_id', userId)
    .limit(1)
    .setHeader(accessToken ? 'Authorization' : null, accessToken ? `Bearer ${accessToken}` : null);
  if (error) return { error: error.message };
  if (!data || !data.length) return { snapshot: null };
  return { snapshot: data[0].snapshot, updated_at: data[0].updated_at };
}

async function deleteCloudData() {
  if (!init()) return { error: 'not_configured' };
  if (!auth.getUserId()) return { error: 'not_authenticated' };
  const userId = auth.getUserId();
  const accessToken = auth.getAccessToken();
  const { error } = await syncClient
    .from(SYNC_TABLE)
    .delete()
    .eq('user_id', userId)
    .setHeader(accessToken ? 'Authorization' : null, accessToken ? `Bearer ${accessToken}` : null);
  if (error) return { error: error.message };
  return { ok: true };
}

async function status() {
  return {
    configured: init(),
    authenticated: auth.getUserId() !== null,
    enabled: await isSyncEnabled(),
    userId: auth.getUserId(),
  };
}

module.exports = {
  init, isSyncEnabled, setSyncEnabled,
  pushSnapshot, pullSnapshot, deleteCloudData, status,
  SYNC_TABLE,
};