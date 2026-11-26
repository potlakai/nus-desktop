'use strict';
// What Hands asks before doing, and when a spoken "yes" counts.
//
// A click or key that sends, buys, pays, submits, deletes, posts, publishes,
// quits or signs out is never taken on the model's say-so: a card drops by the
// Knot with Yes and Not now, and nothing else in that reply runs until the
// person answers. Typing with Enter into a message, chat or mail box asks too.
// A spoken "yes" that answers the Knot's own question counts once, for that
// step, never for money. Pure functions and one small pending-card store.

const RISKY_LABEL = /\b(buy|purchase|pay|checkout|check out|place order|order now|confirm order|send|submit|delete|remove|discard|erase|trash|transfer|subscribe|sign out|log out|logout|book|publish|post|share|merge|deploy|uninstall|reset|format|empty|clear all|apply|save changes|turn in|hand in)\b/i;
const SAFE_LABEL = /\b(apply (filters?|changes?|settings?)|sort|filter|search|cancel|close|back|next|previous|open|view|show|details?|more|less|expand|collapse|refresh|reload|home|help)\b/i;
const MONEY = /\b(buy|purchase|pay|checkout|check out|order|transfer|subscribe|donate|tip|card|price|\$)\b/i;
// Keys that end or send something on their own.
const RISKY_KEYS = /^(?:ctrl\+enter|ctrl\+return|alt\+f4|ctrl\+shift\+enter|ctrl\+q|shift\+ctrl\+q|delete|ctrl\+d)$/i;
const MESSAGE_FIELD = /\b(message|chat|reply|comment|compose|email|mail|to:|subject|post|tweet|status|dm|discord|slack|teams|whatsapp|messenger)\b/i;
const YES = /^\s*(?:(?:yes|yeah|yep|yup|sure|ok|okay|go ahead|do it|confirm|please do|go for it|send it|submit it|that's right|correct)[\s.!]*)+$/i;
const NO = /^\s*(?:(?:no|nope|nah|not now|stop|cancel|don't|do not|never mind|nevermind|wait|hold on)[\s.!]*)+$/i;
const PENDING_TTL_MS = 120000;
// Files Windows runs rather than shows (security validation 2026-11-01, L1).
const RUNS_CODE = /\.(exe|msi|bat|cmd|com|scr|pif|ps1|vbs|vbe|js|jse|wsf|wsh|hta|lnk|url|cpl|jar|reg|msc)$/i;
const ENTER_KEY = /^(?:enter|return)$/i;

function clip(s, n) { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

// The label on a control, plus what the model called it.
function riskyLabel(text) {
  const t = String(text || '');
  if (!t.trim()) return false;
  if (SAFE_LABEL.test(t) && !/\b(send|submit|buy|pay|delete|post|publish)\b/i.test(t)) return false;
  return RISKY_LABEL.test(t);
}
function riskyKeys(keys) { return RISKY_KEYS.test(String(keys || '').replace(/\s+/g, '').toLowerCase()); }
function moneyWords(text) { return MONEY.test(String(text || '')); }
// Typing that will be sent on Enter, into something that reads like a message box.
function riskyTyping({ submit, fieldName, windowTitle, nearby }) {
  if (!submit) return false;
  return MESSAGE_FIELD.test([fieldName, windowTitle, nearby].filter(Boolean).join(' '));
}

// -> null (go ahead) or { title, detail, firm } (a card; firm = a spoken yes is not enough).
function preview(action, ctx = {}) {
  const name = String(action && action.name || '');
  const a = (action && action.args) || {};
  const label = clip(a.label || a.text || ctx.targetName || '', 80);
  if (name === 'click') {
    const what = [label, ctx.targetName].filter(Boolean).join(' / ');
    if (riskyLabel(what)) return { title: clip('Click "' + (ctx.targetName || label) + '"?', 80), detail: 'This looks like it ' + verbFor(what) + '.', firm: moneyWords(what) };
    return null;
  }
  if (name === 'press') {
    if (riskyKeys(a.keys)) return { title: 'Press ' + clip(a.keys, 30) + '?', detail: 'That key combination sends, deletes or closes something.', firm: false };
    // Enter on its own in a message window sends what a separate type step put
    // in the box, which the type card never saw (L1).
    if (ENTER_KEY.test(String(a.keys || '').trim()) && MESSAGE_FIELD.test([ctx.fieldName, ctx.windowTitle].filter(Boolean).join(' '))) return { title: 'Press Enter?', detail: 'That may send what is in the box.', firm: false };
    return null;
  }
  if (name === 'type') {
    if (riskyTyping({ submit: Boolean(a.submit), fieldName: ctx.fieldName, windowTitle: ctx.windowTitle, nearby: ctx.nearby })) return { title: 'Send this?', detail: clip('"' + (a.text || '') + '" will be typed and sent with Enter.', 160), firm: false };
    return null;
  }
  if (name === 'drag') {
    if (/\b(trash|recycle|bin|delete)\b/i.test(String(ctx.toName || a.to_text || ''))) return { title: 'Drag to the ' + clip(ctx.toName || 'bin', 30) + '?', detail: 'That throws it away.', firm: false };
    return null;
  }
  if (name === 'open_app' && RUNS_CODE.test(String(a.name || ''))) return { title: 'Run ' + clip(a.name, 40) + '?', detail: 'That is a program or script, not an app by name.', firm: true };
  // open_file on a program runs it the same way open_app would (L1): same firm card.
  if (name === 'open_file' && RUNS_CODE.test(String(ctx.fileName || ''))) return { title: 'Run ' + clip(ctx.fileName, 40) + '?', detail: 'That is a program or script, not a document.', firm: true };
  if (name === 'tidy') return { title: 'Tidy ' + clip(a.folder || 'the folder', 40) + '?', detail: String(ctx.plan || 'Files move into folders by type. "Undo" puts them back.'), firm: false };
  return null;
}
function verbFor(text) {
  const t = String(text || '').toLowerCase();
  if (/buy|purchase|pay|checkout|check out|order|subscribe|transfer/.test(t)) return 'spends money';
  if (/delete|remove|discard|erase|trash|empty|clear all|reset|format|uninstall/.test(t)) return 'deletes something';
  if (/send|submit|post|publish|share|turn in|hand in|book|merge|deploy/.test(t)) return 'sends or submits something';
  if (/sign out|log out|logout|quit/.test(t)) return 'ends your session';
  return 'cannot be undone';
}

// The one pending card. ask() stores it; answer() resolves it from a button or
// a spoken word; anything else the person says cancels it.
function createPending({ now = () => Date.now() } = {}) {
  let pending = null;
  function ask(card, action, ctx) {
    return new Promise((resolve) => {
      pending = { card, action, ctx, at: now(), resolve };
    });
  }
  function current() { if (pending && now() - pending.at > PENDING_TTL_MS) { pending.resolve({ answered: false, reason: 'expired' }); pending = null; } return pending; }
  function answer(yes, how) {
    const p = current();
    if (!p) return false;
    pending = null;
    p.resolve({ answered: true, yes: Boolean(yes), how: how || 'button' });
    return true;
  }
  // Spoken words while a card is up: yes, no, or something else (which cancels).
  // opts.roomMic: the words came from the open mic, which hears the whole room,
  // so a yes there is not the user's yes (security audit 2026-11-01). opts.heardAt:
  // words heard before the card went up were not an answer to it.
  function spoken(text, opts = {}) {
    const p = current();
    if (!p) return null;
    const t = String(text || '');
    if (YES.test(t)) {
      if ((p.card && p.card.firm) || opts.roomMic || (opts.heardAt && opts.heardAt < p.at)) return 'needs-button';
      answer(true, 'voice'); return 'yes';
    }
    if (NO.test(t)) { answer(false, 'voice'); return 'no'; }
    answer(false, 'other'); return 'cancelled';
  }
  function cancel(reason) { const p = current(); if (!p) return false; pending = null; p.resolve({ answered: false, reason: reason || 'cancelled' }); return true; }
  return { ask, answer, spoken, cancel, current, get pending() { return current(); } };
}

module.exports = { preview, riskyLabel, riskyKeys, riskyTyping, moneyWords, createPending, YES, NO, PENDING_TTL_MS };
