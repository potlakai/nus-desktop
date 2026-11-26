// The account's plan, read the way the desktop app reads it (docs/accounts-b.md,
// stage 5): src/license.js's createLicense, unchanged, calling the
// entitlement() RPC, with its 72 hour offline grace for a paid plan. Nothing
// in the Companion is gated on it yet; Home only shows the plan.
//
// The cache sits in the secret store (safeStorage), so a hand-edited file
// cannot make a plan; with no encryption on the PC there is no cache and an
// offline paid plan reads as free. Signed out: free, and no network call.
const { createLicense } = require('../../src/license');
const { SUPABASE_URL, ANON_KEY } = require('./account');

const CACHE_KEY = 'companion-entitlement';
// No token (offline, or the refresh failed): createLicense must still take its
// offline path, so the request fails here without touching the network.
const NO_TOKEN = 'offline-no-token';

/**
 * @param {object} o
 * @param {{status: () => object, accessToken: () => Promise<string|null>}} o.account
 * @param {{available: () => boolean, get: Function, set: Function, remove: Function}} o.secrets
 * @param {Function} [o.fetch]
 * @param {() => number} [o.now]
 * @param {string} [o.appVersion]
 */
function createEntitlement(o) {
  const fetchFn = o.fetch || globalThis.fetch;
  let token = null;
  const secure = () => { try { return !!o.secrets.available(); } catch { return false; } };
  const license = createLicense({
    auth: { getUser: () => { const s = o.account.status(); return s.signedIn ? { id: s.userId } : null; }, getAccessToken: () => token },
    config: { supabase: { url: o.url || SUPABASE_URL, anonKey: o.anonKey || ANON_KEY }, isSupabaseConfigured: () => true },
    cacheStore: { get: () => (secure() ? o.secrets.get(CACHE_KEY) : null), set: value => { if (secure()) o.secrets.set(CACHE_KEY, value); } },
    fetchImpl: (url, init) => (token === NO_TOKEN ? Promise.reject(new Error('offline')) : fetchFn(url, init)),
    clock: o.now || Date.now,
    appVersion: o.appVersion || null,
  });

  async function refresh() {
    if (!o.account.status().signedIn) { token = null; return status(); }
    token = (await o.account.accessToken()) || NO_TOKEN;
    await license.refresh();
    token = null;
    return status();
  }

  // Sign out or delete: the cached plan goes with the session.
  function clear() { try { o.secrets.remove(CACHE_KEY); } catch { /* nothing cached */ } }

  function status() {
    const signedIn = o.account.status().signedIn;
    const s = signedIn ? license.status() : { plan: 'free', isPro: false, source: 'signed_out', currentPeriodEnd: null };
    return { plan: s.isPro ? 'pro' : 'free', isPro: !!s.isPro, planSource: s.source, planUntil: s.isPro ? s.currentPeriodEnd : null };
  }

  return { refresh, status, clear };
}

module.exports = { createEntitlement, CACHE_KEY };
