'use strict';
// The one ask for an email, so Nūs has a way to reach the people who use it.
// Built for Pranav to rule on (2026-11-11, docs/contact-ask.md); nothing here
// is an account: no password, no sign-in, one address.
//
// When: only after something worked (a first win), never before it, never
// while the tour is on screen, and not on top of the answer: a few minutes
// later. The Knot asks at most twice, on different days, inside the shared
// pop-up budget; the dashboard shows one card until it is answered. "No
// thanks" hides both for good.
//
// Where it goes: the same place the site's Mac waitlist goes (the feedback
// notes in Supabase, through submit-feedback and its outbox), as a note with a
// fixed first line and the address. Never to publik, and nothing from publik
// goes with it.
//
// The ruling still open: LINK_INSTALL. false (built): the address travels
// alone, with no install id and no usage counts, so the anonymous stats stay
// anonymous. true: the install id rides along, so Pranav can see which version
// and how active that person is, and the privacy page must say so.
//
// Pure Node, no Electron, so it runs under node --test.
const fs = require('fs');
const path = require('path');

const LINK_INSTALL = false;
const WAIT_AFTER_WIN_MS = 3 * 60 * 1000;
const MAX_BUBBLES = 2;
const NOTE = 'Updates list: email me when something new ships in Nūs.';
const COLLECTOR = 'contact';
const EMAIL_MAX = 200;

// Every word the person sees. One place, so the ruling can change them.
const WORDS = {
  kicker: 'from Pranav',
  bubble: 'Want a heads-up when something new ships? Leave your email and Pranav writes to you when there is news. Nothing else, and no account.',
  yes: 'Leave my email',
  no: 'No thanks',
  placeholder: 'Your email, then Enter',
  saved: 'Saved. One email when there is news, nothing else.',
  savedLater: 'Saved. It goes to Pranav as soon as Nūs can reach him.',
  bad: 'That email does not look right. Try once more.',
  cardTitle: 'Want a heads-up when something new ships?',
  cardBody: LINK_INSTALL
    ? 'Leave your email and Pranav writes to you when there is news. Nothing else, and no account. It is kept with this computer\'s install id so he can see which version you are on. Ask any time and it is deleted.'
    : 'Leave your email and Pranav writes to you when there is news. Nothing else, and no account. It is kept apart from your usage stats. Ask any time and it is deleted.',
  cardButton: 'Keep me posted',
  cardPlaceholder: 'Your email',
};

function pad(n) { return String(n).padStart(2, '0'); }
function localDay(t) { const d = new Date(t); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { return {}; } }
function writeJson(file, value) {
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2)); fs.renameSync(file + '.tmp', file); } catch { /* never breaks the app */ }
}

// The same test the site's Mac box and submit-feedback use.
function cleanEmail(raw) {
  const mail = String(raw || '').trim();
  return mail && mail.length <= EMAIL_MAX && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail) ? mail : '';
}

/**
 * @param {object} o
 * @param {string} o.file            userData/companion/contact.json
 * @param {() => number} [o.now]
 * @param {{submit: Function}} [o.feedback]  the host's feedback module (submit-feedback and its outbox)
 */
function createContact(o) {
  const now = o.now || Date.now;
  let state = null;
  function st() { if (!state) state = readJson(o.file); return state; }
  function save(patch) { state = { ...st(), ...patch }; writeJson(o.file, state); }

  // Something worked. The first time starts the clock; nothing is asked yet.
  function noteWin() { if (!st().firstWinAt) save({ firstWinAt: now() }); }
  function answered() { const a = st().answer; return a === 'saved' || a === 'declined' ? a : null; }
  // The ask may be on screen: a win happened a few minutes ago at least, and it has no answer yet.
  function due() {
    const at = Number(st().firstWinAt) || 0;
    return !answered() && at > 0 && now() - at >= WAIT_AFTER_WIN_MS;
  }
  // The Knot may raise it itself: twice at most, never twice in a day.
  function bubbleDue() {
    if (!due()) return false;
    if ((Number(st().bubbles) || 0) >= MAX_BUBBLES) return false;
    return st().lastBubbleDay !== localDay(now());
  }
  function bubbleShown() { save({ bubbles: (Number(st().bubbles) || 0) + 1, lastBubbleDay: localDay(now()) }); }

  // The address, as typed. -> { ok, delivered } or { ok: false, reason }.
  // The address is not kept on this computer: only that it was given, and when.
  async function give(raw) {
    const email = cleanEmail(raw);
    if (!email) return { ok: false, reason: 'bad_email' };
    if (!o.feedback || typeof o.feedback.submit !== 'function') return { ok: false, reason: 'no_pipe' };
    let r = null;
    try { r = await o.feedback.submit({ message: NOTE, kind: 'other', email, collector: COLLECTOR, bare: !LINK_INSTALL }); } catch { r = null; }
    if (!r || r.empty) return { ok: false, reason: 'not_saved' };
    save({ answer: 'saved', at: now() });
    return { ok: true, delivered: !!r.delivered };
  }
  function decline() { if (!answered()) save({ answer: 'declined', at: now() }); }

  function status() { return { due: due(), answer: answered(), words: { title: WORDS.cardTitle, body: WORDS.cardBody, button: WORDS.cardButton, no: WORDS.no, placeholder: WORDS.cardPlaceholder } }; }

  return { noteWin, due, bubbleDue, bubbleShown, give, decline, answered, status, state: () => ({ ...st() }) };
}

module.exports = { createContact, cleanEmail, WORDS, NOTE, COLLECTOR, LINK_INSTALL, WAIT_AFTER_WIN_MS, MAX_BUBBLES };
