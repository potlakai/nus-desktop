// Content sync is deliberately not shipped.
//
// Syllabi, courses, tasks, sources, memory, chat, and Companion transcripts
// live on the device and nowhere else. The only thing Nus keeps server-side is
// identity and subscription state (src/license.js). This module stays as an
// explicit, inert seam: the surface main.js, preload.js and the renderer
// already call keeps working, and whoever builds real sync later has one
// obvious place to build it.
//
// The previous implementation chained .setHeaders() / .setHeader() onto a
// supabase-js v2 query builder. Neither method exists there, so every call in
// this file would have thrown. It was never caught because Supabase was never
// configured, so the code never ran. Do not revive it without replacing those
// calls (pass the access token to createClient's global.headers instead).

const SYNC_TABLE = 'nus_user_snapshots';

const UNAVAILABLE = 'sync_not_available';

function init() {
  return false;
}

async function isSyncEnabled() {
  return false;
}

async function setSyncEnabled() {
  return { error: UNAVAILABLE };
}

// Called from writeBridge()'s neighbourhood in older builds. Kept resolvable so
// nothing has to null-check it, but it is a no-op and never touches the network.
async function pushSnapshot() {
  return { skipped: true, reason: UNAVAILABLE };
}

async function pullSnapshot() {
  return { error: UNAVAILABLE };
}

// Logout calls this. There is no cloud content to remove, so it succeeds.
async function deleteCloudData() {
  return { ok: true, noop: true };
}

async function status() {
  return {
    available: false,
    configured: false,
    authenticated: false,
    enabled: false,
    userId: null,
  };
}

module.exports = {
  init, isSyncEnabled, setSyncEnabled,
  pushSnapshot, pullSnapshot, deleteCloudData, status,
  SYNC_TABLE,
};
