// Proactive, not watching. The Knot may speak first for exactly two reasons:
//   plan  something in the user's own Nūs plan is due or about to start
//   app   the app that just came to the front has walkthroughs the user kept
// Never "you look stuck", never from a screenshot. Every trigger has a key;
// "not now" snoozes that key for the day; at most one nudge per cooldown;
// nothing fires while a session is running, the overlay is hidden, or the
// Companion is listening to a meeting. Pure: time and state are passed in.
'use strict';

const SOON_MS = 60 * 60 * 1000;         // an event starting within the hour
const COOLDOWN_MS = 20 * 60 * 1000;     // between any two nudges
const EVENING_HOUR = 18;                // "due tomorrow" only from the evening on

function dayKey(t) {
  const d = new Date(t);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function parseDay(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() : null;
}

function eventStart(ev) {
  const s = ev && ev.start;
  if (!s) return null;
  const raw = typeof s === 'string' ? s : (s.dateTime || s.date);
  if (!raw) return null;
  const t = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? parseDay(raw) : Date.parse(raw);
  return Number.isFinite(t) ? t : null;
}

function minutesWord(ms) {
  const m = Math.max(1, Math.round(ms / 60000));
  return m === 1 ? '1 minute' : m + ' minutes';
}

// Candidates from the desktop snapshot, most urgent first.
function planCandidates(snapshot, now) {
  const out = [];
  const today = dayKey(now);
  const todayStart = parseDay(today);
  const hour = new Date(now).getHours();
  for (const ev of (snapshot && snapshot.gcal_events) || []) {
    const start = eventStart(ev);
    if (start == null) continue;
    const dt = start - now;
    if (dt > -5 * 60000 && dt <= SOON_MS) {
      const title = ev.summary || ev.title || 'Your next event';
      out.push({ key: 'event:' + (ev.id || title) + ':' + dayKey(start), kind: 'plan', urgency: 0, text: dt <= 0 ? title + ' is starting now.' : title + ' starts in ' + minutesWord(dt) + '.', task: title });
    }
  }
  const seen = new Set();
  const items = [...((snapshot && snapshot.next_moves) || []), ...((snapshot && snapshot.tasks) || [])];
  for (const it of items) {
    if (!it || !it.title || !it.due_date) continue;
    const due = parseDay(it.due_date);
    if (due == null) continue;
    const id = String(it.id || it.title);
    if (seen.has(id)) continue;
    seen.add(id);
    const course = it.course_name ? ' (' + it.course_name + ')' : '';
    const days = Math.round((due - todayStart) / 86400000);
    if (days < 0) out.push({ key: 'overdue:' + id + ':' + today, kind: 'plan', urgency: 1, text: it.title + course + ' was due ' + it.due_date + '.', task: it.title });
    else if (days === 0) out.push({ key: 'due:' + id + ':' + today, kind: 'plan', urgency: 2, text: it.title + course + ' is due today.', task: it.title });
    else if (days === 1 && hour >= EVENING_HOUR) out.push({ key: 'tomorrow:' + id + ':' + today, kind: 'plan', urgency: 3, text: it.title + course + ' is due tomorrow.', task: it.title });
  }
  out.sort((a, b) => a.urgency - b.urgency);
  return out;
}

function createProactive(opts = {}) {
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  let lastNudgeAt = 0;
  let lastApp = '';
  const shown = new Map();   // key -> dayKey it was shown

  // -> null or { key, kind:'plan'|'app', text, task, hint }
  function tick(input) {
    const t = now();
    const today = dayKey(t);
    const snoozes = input.snoozes || {};
    const fresh = (key) => shown.get(key) !== today && snoozes[key] !== today;

    // App-open is tracked even while quiet, so a window that was already in
    // front when the session ended does not fire the moment it is over.
    const proc = input.fgWindow && input.fgWindow.process ? String(input.fgWindow.process).toLowerCase() : '';
    const appChanged = proc && proc !== lastApp;
    if (proc) lastApp = proc;

    if (input.quiet) return null;
    if (t - lastNudgeAt < COOLDOWN_MS) return null;

    if (appChanged && input.walkthroughs && typeof input.walkthroughs.forApp === 'function') {
      const saved = input.walkthroughs.forApp(proc);
      const key = 'app:' + proc + ':' + today;
      if (saved.length && fresh(key)) {
        const title = input.fgWindow.title ? String(input.fgWindow.title).split(/ [-–|] /)[0].trim().slice(0, 24) : proc;
        const trig = { key, kind: 'app', text: (title || proc) + ': ' + saved.length + ' saved', task: saved[0].task, hint: saved.length === 1 ? 'Ask "' + saved[0].task + '" to replay it.' : saved.length + ' walkthroughs replay here. Ask for one.' };
        shown.set(key, today);
        lastNudgeAt = t;
        return trig;
      }
    }

    for (const c of planCandidates(input.snapshot, t)) {
      if (!fresh(c.key)) continue;
      shown.set(c.key, today);
      lastNudgeAt = t;
      return c;
    }
    return null;
  }

  return { tick, planCandidates: (snapshot) => planCandidates(snapshot, now()), reset() { lastNudgeAt = 0; lastApp = ''; shown.clear(); } };
}

module.exports = { createProactive, planCandidates, dayKey, SOON_MS, COOLDOWN_MS };
