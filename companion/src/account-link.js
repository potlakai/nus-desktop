// Linking this computer to the optional account (docs/accounts-b.md, stage 3).
// After Sign in with Google, the random install id from stats.js goes to the
// link-install function with the version of the consent words the Account
// card showed. Only while the stats switch is on: with stats off there is no
// usage to link, and the id stays on this computer, as feedback.js does.
// Signing out leaves the link; Unlink and Delete account end it.
//
// The last good link (account, install id, consent version) is remembered in
// the preferences table so a launch only calls the server when something
// changed or the first call missed.
const CONSENT_VERSION = '2026-10-31';
// The words the card shows above Sign in with Google. A change of wording is
// a new CONSENT_VERSION here and in link-install's list.
const CONSENT = "Signing in links this computer's anonymous stats to your Google account so your settings can follow you and Pranav can help if you write in. Unlink or delete any time.";
const OFFLINE = 'Nūs could not reach the server. Try again when you are online.';

/**
 * @param {object} o
 * @param {{status: () => object, call: Function, signOut: () => Promise<object>}} o.account
 * @param {() => string|null} o.installId  the stats install id, or null while stats are off
 * @param {{get: () => object|null, set: (value: object|null) => void}} o.memory  the remembered link
 * @param {string} o.appVersion
 * @param {string} [o.platform]
 */
function createLink(o) {
  let lastError = '';

  function remembered() { try { return o.memory.get() || null; } catch { return null; } }
  function linkedNow() {
    const a = o.account.status();
    const m = remembered();
    const id = o.installId();
    return !!(a.signedIn && m && id && m.userId === a.userId && m.installId === id && m.consent === CONSENT_VERSION);
  }

  async function link() {
    const a = o.account.status();
    if (!a.signedIn) return status();
    const id = o.installId();
    if (!id) return status();
    if (linkedNow()) return status();
    const r = await o.account.call('/functions/v1/link-install', { body: { install_id: id, consent_version: CONSENT_VERSION, app_version: String(o.appVersion || '').slice(0, 40), platform: o.platform || process.platform } });
    if (r.status === 200) { lastError = ''; o.memory.set({ userId: a.userId, installId: id, consent: CONSENT_VERSION, at: new Date().toISOString() }); }
    else if (r.status === 409) lastError = 'This account already has 20 computers linked. Unlink one first.';
    else if (r.status === 0) lastError = '';
    else lastError = 'Nūs could not link this computer. It tries again next time.';
    return status();
  }

  async function unlink() {
    const m = remembered();
    const id = (m && m.installId) || o.installId();
    if (!o.account.status().signedIn || !id) { o.memory.set(null); return status(); }
    const r = await o.account.call('/functions/v1/link-install', { method: 'DELETE', body: { install_id: id } });
    if (r.status !== 200) { lastError = r.status === 0 ? OFFLINE : 'Nūs could not unlink this computer. Try again.'; return status(); }
    lastError = '';
    o.memory.set({ unlinked: true, userId: o.account.status().userId });
    return status();
  }

  // The account and everything hanging off it go on the server; this
  // computer is then signed out. The anonymous install keeps working.
  async function deleteAccount() {
    if (!o.account.status().signedIn) return { ok: false, error: 'Sign in first.' };
    const r = await o.account.call('/functions/v1/delete-account', { body: {} });
    if (r.status === 409) return { ok: false, error: 'Cancel your Nūs plan first, then delete the account.' };
    if (r.status !== 200) return { ok: false, error: r.status === 0 ? OFFLINE : 'Nūs could not delete the account. Try again.' };
    o.memory.set(null);
    await o.account.signOut();
    return { ok: true };
  }

  // Unlinked by the person: no relink at the next launch until they sign in
  // again (a new sign-in clears this with forget()).
  function chosenUnlinked() { const m = remembered(); return !!(m && m.unlinked && m.userId === o.account.status().userId); }
  async function ensure() { return chosenUnlinked() ? status() : link(); }
  function forget() { if (chosenUnlinked()) o.memory.set(null); }

  function status() {
    const a = o.account.status();
    let state = 'signed_out';
    if (a.signedIn) state = linkedNow() ? 'linked' : !o.installId() ? 'stats_off' : chosenUnlinked() ? 'unlinked' : 'pending';
    return { link: state, linkError: lastError };
  }

  return { link, ensure, unlink, deleteAccount, forget, status };
}

module.exports = { createLink, CONSENT, CONSENT_VERSION };
