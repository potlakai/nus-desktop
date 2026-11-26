'use strict';
// Feedback to the founder from the Companion. Three collectors, one pipe:
//
//   - "Tell Pranav ..." typed or said, or the Tell Pranav line from the tray:
//     the person's own words, sent only after they press Send (or typed them
//     into the Tell Pranav line, which is the same thing).
//   - A one-tap reaction after an answered ask: after the 1st, 5th and 25th
//     ask, never twice in a day. Yes / Not really; "Not really" asks why with
//     four fixed buttons.
//   - A day-3 check-in: "what should it do better?", once.
//
// Everything goes to the `submit-feedback` Edge Function, the same intake the
// site's feedback page uses (anonymous allowed, 5 per hour per install; no key
// and no auth header, like `track`: the function runs with verify_jwt off). A
// reaction is a fixed set of words, never what the person asked. Notes wait in
// feedback-outbox.json when the server cannot be reached (offline, or the
// function not deployed yet: a 404) and go the next time it answers. "Don't
// ask again" ends the reaction and check-in prompts for good; the Tell Pranav
// path stays, since it only ever runs when the person starts it.
//
// The install id rides along only while anonymous usage stats are on (the
// person already allowed that id); with stats off a note carries no id.
//
// Electron-free on purpose so it runs under node --test, like stats.js.
const fs = require('fs');
const path = require('path');

const FEEDBACK_URL = 'https://xnpkplcjurzwanotmwwt.supabase.co/functions/v1/submit-feedback';
const TIMEOUT_MS = 6000;
const DAY_MS = 86400000;
const REACTION_AT = [1, 5, 25];
const CHECKIN_AFTER_DAYS = 3;
// The thank-you (0.1.22): once, when this computer has asked this many times. The install ledger of
// 2026-11-11 puts the 99th percentile of lifetime asks at 47 to 62, so "among the people who use
// Nūs the most" is true from here. The count never leaves the computer for this.
const THANKS_AT = 50;
const OUTBOX_MAX = 50;
const OUTBOX_MAX_AGE_MS = 30 * DAY_MS;
const MESSAGE_MAX = 3000;
const REASONS = { wrong: 'wrong answer', slow: 'too slow', misheard: 'misunderstood me', other: 'something else' };
const MODES = ['voice', 'text', 'guide', 'hands', 'ask'];

function utcDay(t) { return new Date(t).toISOString().slice(0, 10); }
function readJson(file, fallback) { try { const v = JSON.parse(fs.readFileSync(file, 'utf8')); return v && typeof v === 'object' ? v : fallback; } catch { return fallback; } }
function writeJson(file, value) {
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2)); fs.renameSync(file + '.tmp', file); } catch { /* feedback never breaks the app */ }
}

// "Tell Pranav the voice is too slow" -> "the voice is too slow". Also "let
// the founder know ...", "feedback: ...", "send feedback to Pranav ...", and
// the usual voice spellings of his name. A bare "feedback" in a sentence is an
// ask ("give feedback on my essay"), so it needs the colon or his name. Returns
// null when the words are not addressed to him; '' when they are but nothing
// follows ("tell Pranav").
const NAME = '(?:pranav|pranab|pranov|pranaav|the founder|the nus team|the nūs team|nus team|nūs team)';
const LEAD = '^(?:hey\\s+)?(?:nus|nūs)?[\\s,]*(?:can you\\s+|please\\s+|could you\\s+)*';
const REST = '(?:\\s+that)?(?:[\\s,:.\\-]+(.*))?$';
const TELL_RE = new RegExp(LEAD + '(?:(?:tell|message)\\s+' + NAME + '|let\\s+' + NAME + '\\s+know)' + REST, 'i');
const SEND_RE = new RegExp(LEAD + '(?:send|give|leave)\\s+(?:some\\s+)?feedback\\s+(?:to|for)\\s+(?:' + NAME.slice(3, -1) + '|nus|nūs)' + REST, 'i');
const COLON_RE = /^feedback\s*:\s*(.*)$/i;

// Pure: the thank-you's words. The free week is publik's own offer to every new subscriber, so it
// is said as that, with its card and its charge; it is never called a gift from Nūs.
const THANKS_WEEK = 'If you ever want more than the free asks, publik gives new subscribers a free week. It needs a card, and it is paid after the week unless you cancel.';
function thanksText(asks, { freeWeek = false } = {}) {
  const n = Math.max(THANKS_AT, Math.floor(Number(asks) || 0));
  return 'You have asked Nūs ' + n + ' times on this computer. That puts you among the people who use it the most. I build Nūs by myself, and I wanted to say thank you.'
    + (freeWeek ? '\n\n' + THANKS_WEEK : '');
}
function tellText(text) {
  const t = String(text || '').trim().replace(/\s+/g, ' ');
  if (!t) return null;
  const m = TELL_RE.exec(t) || SEND_RE.exec(t) || COLON_RE.exec(t);
  if (!m) return null;
  return String(m[1] || '').trim().replace(/^(?:that|this)\s+/i, '').slice(0, MESSAGE_MAX);
}

/**
 * @param {object} o
 * @param {string} o.userData           folder for feedback-state.json and feedback-outbox.json
 * @param {string} o.appVersion
 * @param {string} [o.platform]
 * @param {string} [o.arch]
 * @param {() => string|null} [o.installId]  the stats install id, or null when stats are off
 * @param {boolean} o.packaged          app.isPackaged; a dev run never sends unless NUS_FEEDBACK=1
 * @param {object} [o.env]
 * @param {Function} [o.fetch]
 * @param {() => number} [o.now]
 */
function createFeedback(o) {
  const env = o.env || process.env;
  const fetchFn = o.fetch || globalThis.fetch;
  const now = o.now || Date.now;
  const url = o.url || FEEDBACK_URL;
  const stateFile = path.join(o.userData, 'feedback-state.json');
  const outboxFile = path.join(o.userData, 'feedback-outbox.json');
  let state = null;
  let flushing = null;

  function st() {
    if (!state) {
      state = readJson(stateFile, {});
      if (!state.firstSeen) { state.firstSeen = now(); writeJson(stateFile, state); }
    }
    return state;
  }
  function remember(patch) { state = { ...st(), ...patch }; writeJson(stateFile, state); }
  function outbox() { const v = readJson(outboxFile, { items: [] }); return Array.isArray(v.items) ? v.items : []; }
  function saveOutbox(items) { writeJson(outboxFile, { items }); }

  // A dev run sends nothing unless asked to; the outbox still fills, so the
  // whole path can be watched without a single request leaving the machine.
  function canSend() {
    if (String(env.NUS_FEEDBACK || '') === '0') return false;
    if (!o.packaged && String(env.NUS_FEEDBACK || '') !== '1') return false;
    return typeof fetchFn === 'function';
  }

  async function post(body) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetchFn(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal });
      return Number(res && res.status) || 0;
    } catch { return 0; } finally { clearTimeout(timer); }
  }

  // Send what is waiting, oldest first. 2xx: delivered. 400/413: the server
  // will never take it, so it is dropped. Anything else (no network, 404 while
  // the function is not deployed, 429, 5xx): stop and keep the rest for later.
  function flush() {
    if (flushing) return flushing;
    flushing = (async () => {
      let items = outbox().filter(i => i && i.body && now() - Number(i.at || 0) < OUTBOX_MAX_AGE_MS);
      let sent = 0;
      if (canSend()) {
        while (items.length) {
          const status = await post(items[0].body);
          if (status >= 200 && status < 300) { items.shift(); sent++; continue; }
          if (status === 400 || status === 413) { items.shift(); continue; }
          items[0].tries = (Number(items[0].tries) || 0) + 1;
          break;
        }
      }
      saveOutbox(items);
      return { sent, waiting: items.length };
    })().finally(() => { flushing = null; });
    return flushing;
  }

  // Queue one note and try to send it now. Resolves to { delivered, waiting }.
  // bare: the note travels alone, with no install id and no usage counts (the
  // contact card, companion/src/contact.js: an address must not name an install).
  async function submit({ message, collector, kind, rating, reason, mode, email, bare }) {
    const text = String(message || '').trim().slice(0, MESSAGE_MAX);
    if (!text) return { delivered: false, waiting: outbox().length, empty: true };
    const s = st();
    let id = null;
    try { id = !bare && o.installId ? o.installId() : null; } catch { id = null; }
    const diagnostics = bare ? { collector: String(collector || 'tell') }
      : { collector: String(collector || 'tell'), asks: Number(s.asks) || 0, days: Math.floor((now() - s.firstSeen) / DAY_MS) };
    if (rating) diagnostics.rating = String(rating);
    if (reason) diagnostics.reason = String(reason);
    if (MODES.includes(mode)) diagnostics.mode = mode;
    const body = { source: 'companion', kind: ['bug', 'idea', 'other'].includes(kind) ? kind : 'other', message: text, install_id: id || null,
      app_version: String(o.appVersion || '').slice(0, 40), platform: String(o.platform || process.platform).slice(0, 20), arch: String(o.arch || process.arch).slice(0, 20), diagnostics, website: '' };
    // A reply address only when the person typed one into the Home form.
    const mail = String(email || '').trim();
    if (mail && mail.length <= 200 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) body.email = mail;
    const before = outbox();
    const items = [...before, { at: now(), tries: 0, body }].slice(-OUTBOX_MAX);
    saveOutbox(items);
    const r = await flush();
    return { delivered: r.waiting < items.length, waiting: r.waiting };
  }

  // An ask was answered. The count drives the reaction prompts.
  function noteAsk(mode) { remember({ asks: (Number(st().asks) || 0) + 1, lastMode: MODES.includes(mode) ? mode : 'text' }); }

  // What, if anything, to ask the person at the next quiet moment (just after
  // they closed an answer). One prompt a day at most; the check-in first.
  function due() {
    const s = st();
    if (s.never) return null;
    const today = utcDay(now());
    if (s.lastPromptDay === today) return null;
    if (!s.checkinDone && now() - s.firstSeen >= CHECKIN_AFTER_DAYS * DAY_MS) return 'checkin';
    if (!s.thanksDone && (Number(s.asks) || 0) >= THANKS_AT) return 'thanks';
    const asked = Array.isArray(s.reactionsAt) ? s.reactionsAt : [];
    const next = REACTION_AT.find(n => !asked.includes(n));
    if (next && (Number(s.asks) || 0) >= next) return 'reaction';
    return null;
  }
  // The prompt went up: it counts for today, and for its milestone.
  function shown(which) {
    const s = st();
    const patch = { lastPromptDay: utcDay(now()) };
    if (which === 'checkin') patch.checkinDone = true;
    if (which === 'thanks') patch.thanksDone = true;
    if (which === 'reaction') {
      const asked = Array.isArray(s.reactionsAt) ? s.reactionsAt : [];
      const next = REACTION_AT.find(n => !asked.includes(n));
      if (next) patch.reactionsAt = [...asked, next];
    }
    remember(patch);
  }
  function never() { remember({ never: true }); }

  // The words a reaction sends: fixed, never the ask itself.
  function reaction(rating, reason) {
    const s = st();
    const why = REASONS[reason] ? ': ' + REASONS[reason] : '';
    const message = (rating === 'up' ? 'Reaction: useful' : 'Reaction: not useful' + why) + ' (ask ' + (Number(s.asks) || 0) + ', ' + (s.lastMode || 'text') + ')';
    return submit({ message, collector: 'reaction', rating: rating === 'up' ? 'up' : 'down', reason: REASONS[reason] ? reason : undefined, mode: s.lastMode });
  }
  function checkinGood() { return submit({ message: 'Day-3 check-in: it is good', collector: 'checkin', rating: 'up' }); }
  // The thank-you's button was pressed: fixed words, so the count of people who looked is known.
  function thanksOpened() { return submit({ message: 'Thank-you card: opened the free week', collector: 'thanks' }); }
  function tell(message, collector) { return submit({ message, collector: collector || 'tell', mode: st().lastMode }); }

  function status() { const s = st(); return { asks: Number(s.asks) || 0, never: !!s.never, waiting: outbox().length, due: due() }; }

  return { submit, flush, noteAsk, due, shown, never, reaction, checkinGood, thanksOpened, tell, status, canSend };
}

module.exports = { createFeedback, tellText, thanksText, FEEDBACK_URL, REACTION_AT, CHECKIN_AFTER_DAYS, THANKS_AT, THANKS_WEEK, REASONS };
