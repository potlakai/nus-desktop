const OFFLINE_GRACE_MS = 72 * 60 * 60 * 1000;

// Event names the server accepts (public.events CHECK constraint). Anything
// else is dropped here so a typo never becomes a 400 in the logs.
const TRACKABLE_EVENTS = new Set([
  'app_open', 'signin', 'key_connected', 'first_import',
  'limit_hit', 'upgrade_click', 'checkout_started', 'companion_session',
]);

function freeState(reason = 'free') {
  return {
    plan: 'free',
    status: 'none',
    isPro: false,
    source: reason,
    checkedAt: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
  };
}

function isStripeUrl(value) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:') return null;
  if (!(url.hostname === 'stripe.com' || url.hostname.endsWith('.stripe.com'))) return null;
  return url.toString();
}

function createLicense({ auth, config, cacheStore, fetchImpl = global.fetch, clock = () => Date.now(), appVersion = null }) {
  let state = freeState('not_checked');

  function cachedFor(userId) {
    let cache = null;
    try { cache = JSON.parse(cacheStore?.get() || 'null'); } catch { return null; }
    if (!cache || cache.userId !== userId || !cache.isPro) return null;
    const checkedAt = Date.parse(cache.checkedAt || '');
    const periodEnd = Date.parse(cache.currentPeriodEnd || '');
    if (!Number.isFinite(checkedAt) || clock() - checkedAt > OFFLINE_GRACE_MS) return null;
    if (!Number.isFinite(periodEnd) || periodEnd <= clock()) return null;
    return { ...cache, source: 'offline_cache' };
  }

  function remember(userId, next) {
    try { cacheStore?.set(JSON.stringify({ userId, ...next })); } catch {}
  }

  function authHeaders(token) {
    return {
      apikey: config.supabase.anonKey,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
  }

  async function refresh() {
    const user = auth.getUser();
    const token = auth.getAccessToken();
    if (!config.isSupabaseConfigured(config) || !user || !token) {
      state = freeState(user ? 'session_missing' : 'signed_out');
      return status();
    }

    try {
      const response = await fetchImpl(`${config.supabase.url}/rest/v1/rpc/entitlement`, {
        method: 'POST',
        headers: authHeaders(token),
        body: '{}',
      });
      if (!response.ok) throw new Error(`entitlement_${response.status}`);
      const payload = await response.json();
      const row = Array.isArray(payload) ? payload[0] : payload;
      const periodEnd = row?.current_period_end || null;
      const isPro = Boolean(row?.is_pro)
        && Number.isFinite(Date.parse(periodEnd || ''))
        && Date.parse(periodEnd) > clock();
      state = {
        plan: isPro ? 'pro' : 'free',
        status: row?.status || 'none',
        isPro,
        source: 'online',
        checkedAt: new Date(clock()).toISOString(),
        currentPeriodEnd: periodEnd,
        cancelAtPeriodEnd: Boolean(row?.cancel_at_period_end),
      };
      remember(user.id, state);
      return status();
    } catch (error) {
      const cached = cachedFor(user.id);
      state = cached || { ...freeState('offline_no_valid_cache'), error: error?.message || 'offline' };
      return status();
    }
  }

  function status() {
    return { ...state };
  }

  // Both billing functions answer with a Stripe-hosted URL and nothing else.
  // The URL guard is the client-side half of "only Stripe ever sees a card".
  async function callBillingFunction(name) {
    const user = auth.getUser();
    const token = auth.getAccessToken();
    if (!user || !token) return { error: 'sign_in_required' };
    try {
      const response = await fetchImpl(`${config.supabase.url}/functions/v1/${name}`, {
        method: 'POST',
        headers: authHeaders(token),
        body: '{}',
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) return { error: body.error || `${name.replace(/-/g, '_')}_unavailable`, detail: body.detail || null };
      const url = isStripeUrl(body.url);
      if (!url) return { error: `${name.replace(/-/g, '_')}_unavailable` };
      return { url };
    } catch {
      return { error: 'network' };
    }
  }

  async function createCheckout() {
    if (state.isPro) return { error: 'already_subscribed' };
    const result = await callBillingFunction('create-checkout');
    if (result.error && result.error === 'create_checkout_unavailable') return { error: 'checkout_unavailable' };
    return result;
  }

  async function createPortal() {
    const result = await callBillingFunction('create-portal');
    if (result.error && result.error === 'create_portal_unavailable') return { error: 'portal_unavailable' };
    return result;
  }

  // Funnel counters only. Fire-and-forget: a failed insert never surfaces to
  // the student, and nothing here carries content (see public.events).
  async function track(name, props = {}) {
    if (!TRACKABLE_EVENTS.has(name)) return false;
    const user = auth.getUser();
    const token = auth.getAccessToken();
    if (!user || !token || !config.isSupabaseConfigured(config)) return false;
    const safeProps = {};
    for (const [key, value] of Object.entries(props || {})) {
      if (['string', 'number', 'boolean'].includes(typeof value)) safeProps[String(key).slice(0, 40)] = typeof value === 'string' ? value.slice(0, 80) : value;
    }
    try {
      const response = await fetchImpl(`${config.supabase.url}/rest/v1/events`, {
        method: 'POST',
        headers: { ...authHeaders(token), Prefer: 'return=minimal' },
        body: JSON.stringify({ user_id: user.id, name, app_version: appVersion, props: safeProps }),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  return { refresh, status, createCheckout, createPortal, track };
}

module.exports = { createLicense, OFFLINE_GRACE_MS, TRACKABLE_EVENTS, isStripeUrl };
