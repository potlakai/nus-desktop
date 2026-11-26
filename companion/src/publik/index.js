'use strict';
// Everything Publik, behind one build switch. The rest of the Companion only asks this file:
// is the switch on, is publik answering on this computer, which key and base URL, and what a
// publik error means. Pure Node (no Electron at load), so llm.js and the tests can require it.
//
// The switch: `publik: true` in the packaged package.json, set by extraMetadata in
// electron-builder.companion.config.js. Off (or this folder left out of the build), the
// Companion starts with no gate and no publik provider, exactly like 0.1.16.
// NUS_PUBLIK=1 turns it on for a development start; nothing turns it off in a publik build.
const fs = require('fs');
const path = require('path');
const mod = require('./publik');

function on() {
  if (process.env.NUS_PUBLIK === '1') return true;
  try { return require(path.join(__dirname, '..', '..', '..', 'package.json')).publik === true; } catch (_) { return false; }
}

// The person picked "Connect your plan" (choice "publik") on the gate or in Settings.
function choice() { const c = mod.readCredential(); return (c && c.choice) || null; }
function active() { return on() && mod.resolveProvider(null).kind === 'publik'; }
function provider() { const p = mod.resolveProvider(null); return p.kind === 'publik' ? { baseURL: p.baseURL, apiKey: p.apiKey } : null; }
function setChoice(c) { mod.setChoice(c === 'publik' || c === 'own_key' ? c : null); }
// Signed in with publik on this computer, and answering with an own key or Claude Code: the
// person can move to publik in one tap when that key stops working (0.1.22).
function canSwitch() { return on() && !process.env.PUBLIK_API_KEY && !!mod.readCredential() && choice() !== 'publik'; }
// This computer has been all the way through Sign in with publik before: its key is on disk and the
// "who answers" choice was made, which the module only writes after publik said the account is
// signed in. offline-pass.js lets such a person open Nūs when publik does not answer.
function signedInBefore() { return on() && !process.env.PUBLIK_API_KEY && !!choice(); }

// Who publik says this computer is signed in as. null when publik cannot be reached or nobody is signed in.
// -> { handle: '@name' | '', claimed: boolean }
async function who() {
  if (!on()) return null;
  const c = mod.readCredential();
  if (!c) return null;
  try {
    const r = await mod.readWallet(c.key);
    if (!r.wallet) return null;
    const h = r.wallet.account && r.wallet.account.handle;
    return { handle: h ? '@' + String(h).replace(/^@/, '').slice(0, 60) : '', claimed: r.wallet.claim_state === 'claimed' };
  } catch (_) { return null; }
}
// Sign this computer out of publik: its key is forgotten, so the next start sets the computer up
// again and shows "Sign in with publik". Which account that becomes is decided in the browser, so
// a person who wants another account signs out of publikhq.com there first. A key from the
// environment (development) is not ours to forget. (2026-11-16: a tester's Mac stayed signed in to
// the developer's account, with no way out but deleting the file by hand.)
function signOut() {
  if (!on() || process.env.PUBLIK_API_KEY) return false;
  const file = mod.credentialPath();
  try {
    if (!fs.existsSync(file)) return true;
    fs.writeFileSync(file, '{}', { mode: 0o600 });
    return mod.readCredential() === null;
  } catch (_) { return false; }
}

// Which tier answers. Everyday asks and the Smart switch; a vendor model name is never sent.
const TIERS = { fast: mod.MODELS.fast, smart: mod.MODELS.smart, hands: mod.MODELS.balanced };
function model(tier, requested) {
  if (typeof requested === 'string' && /^publik-(fast|balanced|smart|default)$/.test(requested)) return requested;
  return TIERS[tier] || TIERS.fast;
}

// publik API takes requests under 4 MB, pictures included. The Companion's screenshots are PNG at
// 1280 px; a busy screen can come near that, so a large one goes as JPEG (Electron, when there).
const MAX_IMAGE_CHARS = 3_000_000;
function prepareImage(dataUrl) {
  const s = String(dataUrl || '');
  if (s.length <= MAX_IMAGE_CHARS) return dataUrl;
  try {
    const { nativeImage } = require('electron');
    const img = nativeImage.createFromDataURL(s);
    for (const q of [80, 65, 50]) { const out = 'data:image/jpeg;base64,' + img.toJPEG(q).toString('base64'); if (out.length <= MAX_IMAGE_CHARS) return out; }
  } catch (_) { /* not in Electron: send it as it is */ }
  return dataUrl;
}

// A publik error, read from the OpenAI client's error (or a plain one). -> { kind, message, url }
// kind: 'balance' (402), 'signed_out' (401), 'offline', or ''.
function readError(e) {
  if (!e) return { kind: '', message: '', url: null };
  const status = Number(e.status) || 0;
  const body = e.error && typeof e.error === 'object' ? (e.error.error && typeof e.error.error === 'object' ? e.error.error : e.error) : null;
  if (status === 402) { const t = mod.topUpUrlFrom402({ error: body || {} }); return { kind: 'balance', message: t.message, url: t.url }; }
  if (status === 401) return { kind: 'signed_out', message: '', url: null };
  const text = String((e && e.message) || e);
  if (e.name === 'APIConnectionError' || /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed|Connection error/i.test(text)) return { kind: 'offline', message: '', url: null };
  return { kind: '', message: '', url: null };
}
// The words in the Knot's bubble. A 402 shows Publik's own message, our lines, and (as the
// bubble's button) Publik's one top-up link. From 0.1.22 our lines name publik's free week, with
// its card and its charge (pricing page, read 2026-11-15), and never an amount of money.
const FREE_WEEK_402 = 'publik gives new subscribers a free week: it needs a card and is paid after the week unless you cancel.';
function errorLine(e) {
  const r = readError(e);
  if (r.kind === 'balance') return (r.message ? r.message.replace(/\s*$/, '') + ' ' : '') + FREE_WEEK_402 + ' Or keep going for free with your own key: a free Gemini key works. Voice commands and reminders still work.';
  if (r.kind === 'signed_out') return 'publik signed this computer out. Restart Nūs to sign in again, or switch to your own key in Settings.';
  if (r.kind === 'offline') return 'publik is not reachable. Check your connection. Voice commands and reminders still work.';
  return '';
}

module.exports = { on, active, choice, provider, setChoice, canSwitch, signedInBefore, who, signOut, model, TIERS, prepareImage, readError, errorLine, FREE_WEEK_402, MAX_IMAGE_CHARS, module: mod };
