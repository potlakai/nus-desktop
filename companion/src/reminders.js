'use strict';
// Reminders and timers, read by code (no model call):
//   "remind me at 4 to email Professor Lee", "remind me in 20 minutes to
//   stretch", "remind me tomorrow at 9:30 am to submit lab 3",
//   "set a timer for 10 minutes", "cancel the timer", "what are my reminders".
//
// They are kept in companion/reminders.json under userData, so a restart
// keeps them. The host (index.js) shows the bubble and says the line when one
// is due. A "remind me ..." with no time in it is not claimed here: it stays
// a note, as before.
//
// Pure apart from the file: the clock and the timers are injected.
const fs = require('fs');
const path = require('path');

const LEAD = '^\\s*(?:(?:hey|ok|okay|so|um|uh|please|nus|can you|could you|would you|will you|just|now|and)[\\s,]+)*';
const NUM_WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, 'twenty five': 25, 'twenty-five': 25, thirty: 30, forty: 40, 'forty five': 45, 'forty-five': 45, fifty: 50, sixty: 60, ninety: 90, couple: 2, 'a couple of': 2, few: 3, 'a few': 3 };
const NUM = '(\\d+(?:\\.\\d+)?|a couple of|a few|twenty[- ]five|forty[- ]five|an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|ninety)';
const UNIT = '(seconds?|secs?|minutes?|mins?|hours?|hrs?)';
const UNIT_MS = { s: 1000, m: 60000, h: 3600000 };
const DUR_PART = NUM + '[\\s-]*' + UNIT;
// The same, with no capture groups inside, for use inside larger patterns.
const DUR_NC = DUR_PART.replace(/\((?!\?)/g, '(?:');
const DURATION = '(?:half an? hour|an? hour and a half|(?:a )?quarter (?:of an )?hour|' + DUR_NC + '(?:(?:\\s*,\\s*|\\s+and\\s+|\\s+)' + DUR_NC + ')?(?:\\s+and a half)?)';
const MAX_MS = 7 * 86400000;

function numberOf(word) {
  const w = String(word || '').toLowerCase().trim();
  if (/^\d/.test(w)) return Number(w);
  return NUM_WORDS[w] != null ? NUM_WORDS[w] : NUM_WORDS[w.replace(/-/g, ' ')];
}

// "20 minutes", "an hour and a half", "1 hour 30 minutes" -> ms, or null.
function parseDuration(text) {
  const t = String(text || '').toLowerCase().trim();
  if (/^half an? hour$/.test(t)) return 30 * 60000;
  if (/^an? hour and a half$/.test(t)) return 90 * 60000;
  if (/^(?:a )?quarter (?:of an )?hour$/.test(t)) return 15 * 60000;
  const re = new RegExp(DUR_PART, 'gi');
  let total = 0, found = false, m, lastUnit = 0;
  while ((m = re.exec(t))) {
    const n = numberOf(m[1]);
    if (!Number.isFinite(n)) return null;
    lastUnit = UNIT_MS[m[2][0]];
    total += n * lastUnit;
    found = true;
  }
  if (!found) return null;
  if (/and a half$/.test(t)) total += lastUnit / 2;
  return total > 0 ? Math.round(total) : null;
}

const CLOCK = '(?:(\\d{1,2})(?::(\\d{2}))?\\s*(a\\.?m\\.?|p\\.?m\\.?)?(?:\\s*o\'?\\s?clock)?|(noon|midday|midnight))';
const AT_CLOCK = new RegExp('\\b(?:at|for|by|around)\\s+' + CLOCK + '(?![\\d:])', 'i');
const BARE_CLOCK = new RegExp('\\b(\\d{1,2})(?::(\\d{2}))?\\s*(a\\.?m\\.?|p\\.?m\\.?)(?=\\s|$|[.,!?])', 'i');
const DAY_WORDS = /\b(tomorrow(?: morning| afternoon| evening| night)?|tonight|this (?:morning|afternoon|evening)|in the (?:morning|afternoon|evening)|today)\b/i;

// The clock time a person most likely means. Without am or pm: 1 to 6 is the
// afternoon, 7 to 11 the next one still ahead today, 12 is noon; "tonight"
// and "evening" mean pm, "morning" am.
function resolveClock({ hour, minute, ampm, word, day }, nowMs) {
  const now = new Date(nowMs);
  let h = hour, min = minute || 0;
  if (word) { h = /midnight/i.test(word) ? 0 : 12; min = 0; }
  if (h > 23 || min > 59) return null;
  const dayWord = String(day || '').toLowerCase();
  const tomorrow = /tomorrow/.test(dayWord) || (word && /midnight/i.test(word));
  const pmHint = /night|evening|afternoon/.test(dayWord), amHint = /morning/.test(dayWord);
  let candidates;
  if (word) candidates = [h];
  else if (ampm) { const pm = /^p/i.test(ampm); if (h > 12 || h === 0) return null; candidates = [h % 12 + (pm ? 12 : 0)]; }
  else if (h > 12 || h === 0) candidates = [h];
  else if (pmHint) candidates = [h === 12 ? 12 : h + 12];
  else if (amHint) candidates = [h === 12 ? 0 : h];
  else if (h === 12) candidates = [12];
  else if (h <= 6) candidates = [h + 12];
  else candidates = [h, h + 12];
  const at = (offset, hh) => { const d = new Date(now); d.setDate(d.getDate() + offset); d.setHours(hh, min, 0, 0); return d.getTime(); };
  if (tomorrow) return at(1, candidates[0]);
  for (const hh of candidates) if (at(0, hh) > nowMs) return at(0, hh);
  return at(1, candidates[0]);
}

// When in the words, or null: { at, phrase } with the words that said it.
function findWhen(text, nowMs) {
  const t = String(text || '');
  const dur = new RegExp('\\b(?:in|for|after)\\s+(' + DURATION + ')\\b', 'i').exec(t);
  if (dur) { const ms = parseDuration(dur[1]); if (ms && ms <= MAX_MS) return { at: nowMs + ms, ms, phrases: [dur[0]] }; }
  const day = DAY_WORDS.exec(t);
  const clock = AT_CLOCK.exec(t) || BARE_CLOCK.exec(t);
  if (clock) {
    const at = resolveClock({ hour: clock[1] != null ? Number(clock[1]) : null, minute: clock[2] != null ? Number(clock[2]) : 0, ampm: clock[3], word: clock[4], day: day && day[1] }, nowMs);
    if (at != null) return { at, phrases: [clock[0]].concat(day ? [day[0]] : []) };
  }
  if (day && /tomorrow/i.test(day[1])) {
    const hour = /afternoon/i.test(day[1]) ? 14 : /evening|night/i.test(day[1]) ? 19 : 9;
    return { at: resolveClock({ hour, minute: 0, day: 'tomorrow' }, nowMs), phrases: [day[0]] };
  }
  return null;
}

const REMIND_RE = new RegExp(LEAD + '(?:remind me|set (?:a |an )?reminder|add (?:a )?reminder|make (?:a )?reminder|create (?:a )?reminder|reminder)\\b', 'i');
const TIMER_RE = new RegExp(LEAD + '(?:(?:set|start|make|put on|create|give me)\\s+)?(?:(?:a|an|the|my)\\s+)?(?:(' + DURATION + ')\\s+)?timer(?:\\s+(?:for|of|on)?\\s*(' + DURATION + '|\\d+))?[\\s.!?]*$', 'i');
const TIMER_FOR_RE = new RegExp(LEAD + '(?:set|start)\\s+(?:a\\s+)?timer\\s+(?:for\\s+)?(\\d+)[\\s.!?]*$', 'i');
const CANCEL_RE = new RegExp(LEAD + '(?:cancel|stop|delete|remove|clear|turn off|kill|end|forget(?: about)?|never ?mind(?: about)?|get rid of)\\s+(?:(?:the|my|that|this|all(?: of)?(?: the| my)?|both)\\s+)*(timers?|reminders?|alarms?)(?:\\s+(?:to|about|for|that)\\s+(.{2,80}?))?[\\s.!?]*$', 'i');
const LIST_RE = new RegExp(LEAD + '(?:(?:what|which) (?:are )?(?:my |the )?reminders?(?: (?:do i have|are (?:there|set)))?|(?:what|which) reminders? (?:do i have|are (?:there|set))|(?:show|list|read)(?: me)? (?:my |the |all )?(?:reminders|timers)|do i have (?:any )?(?:reminders|timers)|how (?:much time|long) is (?:left|remaining)(?: on (?:the|my) timer)?|how long (?:until|till|left on) (?:the|my) timer)[\\s.!?]*$', 'i');

function cleanWhat(text, phrases) {
  let s = String(text || '').replace(REMIND_RE, ' ');
  for (const p of phrases || []) s = s.replace(p, ' ');
  s = s.replace(/\b(?:at|for|by|on)\s*$/i, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/^(?:for\s+)?(?:me\s+)?(?:to|that|about|of)\s+/i, '').replace(/^[,:;-]\s*/, '');
  s = s.replace(/\s+(?:please|thanks|thank you)$/i, '').replace(/[\s.!?,]+$/, '').trim();
  return s;
}

// -> null, or one of
//   { kind: 'reminder', at, what }
//   { kind: 'timer', at, ms, label }
//   { kind: 'cancel', which: 'timer'|'reminder', all, about }
//   { kind: 'list' }
function parseReminder(text, nowMs = Date.now()) {
  const t = String(text || '').trim();
  if (!t || t.length > 200) return null;
  if (LIST_RE.test(t)) return { kind: 'list' };
  const c = CANCEL_RE.exec(t);
  if (c) return { kind: 'cancel', which: /^timer/i.test(c[1]) ? 'timer' : 'reminder', all: /\b(?:all|both)\b/i.test(t) || /s$/i.test(c[1]), about: c[2] ? c[2].trim() : '' };
  const tm = TIMER_RE.exec(t);
  if (tm && (tm[1] || tm[2])) {
    const raw = tm[1] || tm[2];
    const ms = /^\d+$/.test(raw) ? Number(raw) * 60000 : parseDuration(raw);
    if (ms && ms <= MAX_MS) return { kind: 'timer', at: nowMs + ms, ms, label: durationLabel(ms) + ' timer' };
  }
  const tf = TIMER_FOR_RE.exec(t);
  if (tf) { const ms = Number(tf[1]) * 60000; if (ms > 0 && ms <= MAX_MS) return { kind: 'timer', at: nowMs + ms, ms, label: durationLabel(ms) + ' timer' }; }
  if (REMIND_RE.test(t)) {
    const when = findWhen(t, nowMs);
    if (!when) return null;
    const what = cleanWhat(t, when.phrases);
    return { kind: 'reminder', at: when.at, what: what || 'the thing you asked about' };
  }
  return null;
}

function durationLabel(ms) {
  const mins = Math.round(ms / 60000);
  if (ms < 60000) return Math.round(ms / 1000) + ' second';
  if (mins < 60) return mins + ' minute';
  const h = Math.floor(mins / 60), m = mins % 60;
  return m ? h + ' hour ' + m + ' minute' : h + ' hour';
}

// "10 minutes", "1 hour 30 minutes", "1 minute": the length in words.
function durationWords(ms) {
  return durationLabel(ms).replace(/\b(\d+) (second|minute|hour)\b/g, (m, n, u) => (n === '1' ? m : n + ' ' + u + 's'));
}

// "4:00 PM", "tomorrow at 9:30 AM", "in 20 minutes" for the bubble and Home.
function whenLabel(at, nowMs = Date.now()) {
  const d = new Date(at), now = new Date(nowMs);
  let h = d.getHours(); const m = d.getMinutes(); const pm = h >= 12; h = h % 12 || 12;
  const clock = h + ':' + String(m).padStart(2, '0') + ' ' + (pm ? 'PM' : 'AM');
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(now)) / 86400000);
  if (diff === 0) return 'today at ' + clock;
  if (diff === 1) return 'tomorrow at ' + clock;
  return d.toLocaleDateString(undefined, { weekday: 'long' }) + ' at ' + clock;
}

// The store: add, remove, cancel, list, and a single timer for the next one due.
//   onFire(item) is called when one is due (late ones fire at start, marked late).
function createReminders({ file, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout, onFire = () => {}, onChange = () => {}, log = () => {} } = {}) {
  let items = [];
  let timer = null;
  let seq = 0;
  load();

  function load() {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      items = (Array.isArray(raw) ? raw : raw.items || []).filter((r) => r && Number.isFinite(r.at) && r.id).map((r) => ({ id: String(r.id), kind: r.kind === 'timer' ? 'timer' : 'reminder', at: Number(r.at), what: String(r.what || ''), label: String(r.label || ''), createdAt: Number(r.createdAt) || 0 }));
    } catch (_) { items = []; }
  }
  function save() {
    if (!file) return;
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ items }, null, 2)); } catch (e) { log('reminders save failed: ' + e.message); }
  }
  function changed() { save(); schedule(); try { onChange(list()); } catch (_) { /* host gone */ } }
  function list() { return items.slice().sort((a, b) => a.at - b.at); }

  function add(parsed) {
    if (!parsed || !Number.isFinite(parsed.at)) return null;
    const item = { id: now().toString(36) + '-' + (++seq), kind: parsed.kind === 'timer' ? 'timer' : 'reminder', at: parsed.at, what: String(parsed.what || '').slice(0, 200), label: String(parsed.label || '').slice(0, 60), createdAt: now() };
    items.push(item);
    changed();
    return item;
  }
  function remove(id) {
    const before = items.length;
    items = items.filter((r) => r.id !== String(id));
    if (items.length !== before) changed();
    return before - items.length;
  }
  // "cancel the timer": the next one of that kind; "cancel all reminders":
  // every one; "cancel the reminder to stretch": the one whose words match.
  function cancel({ which = 'reminder', all = false, about = '' } = {}) {
    const mine = list().filter((r) => r.kind === which);
    let gone = [];
    if (about) {
      const words = about.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
      gone = mine.filter((r) => words.some((w) => r.what.toLowerCase().includes(w)));
    } else gone = all ? mine : mine.slice(0, 1);
    if (!gone.length) return [];
    const ids = new Set(gone.map((r) => r.id));
    items = items.filter((r) => !ids.has(r.id));
    changed();
    return gone;
  }

  function schedule() {
    if (timer) { clearTimer(timer); timer = null; }
    const next = list()[0];
    if (!next) return;
    // Timers in Node cap near 24.8 days; a long wait is broken into steps.
    const wait = Math.max(0, Math.min(next.at - now(), 2 ** 30));
    timer = setTimer(tick, wait);
    if (timer && timer.unref) timer.unref();
  }
  function tick() {
    timer = null;
    const t = now();
    const due = list().filter((r) => r.at <= t + 250);
    if (due.length) {
      const ids = new Set(due.map((r) => r.id));
      items = items.filter((r) => !ids.has(r.id));
      save();
      for (const r of due) { try { onFire(Object.assign({}, r, { late: t - r.at > 120000 })); } catch (e) { log('reminder fire failed: ' + e.message); } }
      try { onChange(list()); } catch (_) { /* host gone */ }
    }
    schedule();
  }
  // At launch: a timer that ran out while Nūs was closed is dropped (it means
  // nothing now); a reminder still fires, marked late.
  function start() {
    const t = now();
    const before = items.length;
    items = items.filter((r) => !(r.kind === 'timer' && r.at < t));
    if (items.length !== before) save();
    schedule();
  }
  function stop() { if (timer) { clearTimer(timer); timer = null; } }

  return { add, remove, cancel, list, start, stop, tick, file };
}

// The words for "what are my reminders".
function describeList(items, nowMs = Date.now()) {
  if (!items.length) return 'You have no reminders or timers.';
  const parts = items.slice(0, 5).map((r) => r.kind === 'timer'
    ? 'a ' + r.label + ' with ' + durationWords(Math.max(1000, r.at - nowMs)) + ' left'
    : '"' + r.what + '" ' + whenLabel(r.at, nowMs));
  return 'You have ' + (items.length === 1 ? 'one: ' : items.length + ': ') + parts.join('; ') + (items.length > 5 ? '; and more on the dashboard.' : '.');
}

// Rows for the Home window's Reminders card, words already made.
function panelRows(items, nowMs = Date.now()) {
  return items.map((r) => ({ id: r.id, kind: r.kind, title: r.kind === 'timer' ? (r.label || 'Timer') : r.what, when: r.kind === 'timer' ? 'ends ' + whenLabel(r.at, nowMs).replace(/^today at /, '') : whenLabel(r.at, nowMs) }));
}

module.exports = { parseReminder, parseDuration, findWhen, resolveClock, createReminders, whenLabel, durationLabel, durationWords, describeList, panelRows };
