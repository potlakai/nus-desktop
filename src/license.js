// Personal build: there is no subscription, so there is nothing to check.
//
// Upstream asked a Supabase function whether this account had paid, cached the
// answer for a 72 hour offline grace window, and handed Stripe a checkout or a
// portal URL on request. All of that is gone.
//
// What is left is the shape main.js reads: status() and refresh() answer with a
// plan that is always on. Nothing here calls the network. createCheckout() and
// createPortal() still exist so the IPC channels that mention them cannot throw,
// but they answer with an error instead of a URL, and no renderer path reaches
// them once the upgrade copy is gone.
//
// Attribution is unaffected: LICENSE keeps the upstream MIT notice.

// A plan that is always active. `isPro` stays true because parts of the UI and
// several limit checks upstream read that exact key.
function personalState() {
  return {
    plan: 'personal',
    status: 'active',
    isPro: true,
    source: 'personal_build',
    checkedAt: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
  };
}

// Kept for anything that imported the old name.
const freeState = personalState;

const OFFLINE_GRACE_MS = 72 * 60 * 60 * 1000;

function isStripeUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && (url.hostname === 'stripe.com' || url.hostname.endsWith('.stripe.com'));
  } catch {
    return false;
  }
}

function createLicense() {
  const state = personalState();
  return {
    async refresh() { return { ...state }; },
    status() { return { ...state }; },
    async createCheckout() { return { error: 'no_billing' }; },
    async createPortal() { return { error: 'no_billing' }; },
  };
}

module.exports = { createLicense, OFFLINE_GRACE_MS, isStripeUrl, personalState, freeState };
