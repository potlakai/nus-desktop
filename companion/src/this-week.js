'use strict';
// "This week: 3 deadlines, next is Lab 3 (Physics) Thursday Oct 15": one line
// from the Nūs desktop app's bridge file (context.json, written by the desktop
// app on every change), carried in every prompt with what Nūs knows about the
// person, so "what's due" works from the Knot.
//
// Only dates the desktop app wrote are used, never a guess. No file, an old
// file, or nothing dated this week: no line at all. A desktop app that writes
// `upcoming` (every pending deadline for two weeks) gives a full count; an
// older one only has its top five ranked moves, so the line lists those
// without claiming a total.
const fs = require('fs');
const path = require('path');
const { loadNusContext } = require('./nus-context');

const STALE_MS = 7 * 86400000;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Where the desktop app keeps it: installed ("Nus"), or a dev run ("nus-desktop").
function bridgeCandidates({ appData = process.env.APPDATA || '', env = process.env } = {}) {
  const out = [];
  if (env && env.NUS_DESKTOP_BRIDGE) out.push(env.NUS_DESKTOP_BRIDGE);
  if (appData) out.push(path.join(appData, 'Nus', 'context.json'), path.join(appData, 'nus-desktop', 'context.json'));
  return out;
}

// The newest readable bridge among the candidates, or null.
function readBridge(files) {
  let best = null;
  for (const f of files || []) {
    let mtime = 0;
    try { mtime = fs.statSync(f).mtimeMs; } catch (_) { continue; }
    if (best && mtime <= best.mtime) continue;
    const r = loadNusContext(f);
    if (r.ok) best = { file: f, mtime, context: r.context };
  }
  return best;
}

// "2026-10-15" as a local calendar day (not UTC midnight).
function localDay(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || ''));
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() : NaN;
}
function startOfDay(t) { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }
function dayName(t, today) {
  const diff = Math.round((t - today) / 86400000);
  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
  const d = new Date(t);
  return WEEKDAYS[d.getDay()] + ' ' + MONTHS[d.getMonth()] + ' ' + d.getDate();
}
function shortCourse(name) {
  const n = String(name || '').trim();
  if (!n || /^general$/i.test(n)) return '';
  return n.length > 32 ? n.slice(0, 30).trim() + '…' : n;
}
// Text from the file is data: no line breaks, no runaway length.
const clean = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

// -> { items: [{ title, due, course }], complete } for the next 7 days (today included).
function dueThisWeek(context, now = Date.now()) {
  const today = startOfDay(now), end = today + 7 * 86400000;
  const complete = Array.isArray(context && context.upcoming);
  const source = complete ? context.upcoming : [].concat((context && context.next_moves) || [], (context && context.tasks) || []);
  const seen = new Set(), items = [];
  for (const it of source) {
    if (!it || !it.title || !it.due_date || it.done || it.status === 'done' || it.status === 'submitted') continue;
    const due = localDay(it.due_date);
    if (!Number.isFinite(due) || due < today || due >= end) continue;
    const key = clean(it.title, 80).toLowerCase() + '|' + it.due_date;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ title: clean(it.title, 80), due, course: shortCourse(clean(it.course_name, 60)) });
  }
  items.sort((a, b) => a.due - b.due || a.title.localeCompare(b.title));
  return { items, complete };
}

// The one line, or '' when there is nothing honest to say.
function weekLine(context, { now = Date.now(), generatedAt } = {}) {
  if (!context) return '';
  const made = Date.parse(generatedAt || context.generated_at || '');
  if (Number.isFinite(made) && now - made > STALE_MS) return '';
  const { items, complete } = dueThisWeek(context, now);
  const today = startOfDay(now);
  const asOf = Number.isFinite(made) && startOfDay(made) < today ? ' as of ' + MONTHS[new Date(made).getMonth()] + ' ' + new Date(made).getDate() : '';
  const label = (it) => it.title + (it.course ? ' (' + it.course + ')' : '') + ' ' + dayName(it.due, today);
  if (!items.length) return complete ? 'This week, from the Nūs desktop app' + asOf + ': nothing due in the next 7 days.' : '';
  if (complete) {
    const n = items.length;
    const rest = items.slice(1, 5).map(label);
    return 'This week, from the Nūs desktop app' + asOf + ': ' + n + ' deadline' + (n === 1 ? '' : 's') + ', next is ' + label(items[0]) + (rest.length ? '; then ' + rest.join('; ') : '') + (n > 5 ? '; and ' + (n - 5) + ' more' : '') + '.';
  }
  return 'This week, from the Nūs desktop app' + asOf + ', top deadlines only, there may be more: ' + items.slice(0, 5).map(label).join('; ') + '.';
}

// Reads the bridge at most once per change (file time) and per day.
function createThisWeek({ files = () => bridgeCandidates(), now = () => Date.now(), live = null } = {}) {
  let cache = { key: '', line: '' };
  return function line() {
    try {
      // Inside the desktop app the state is live, no file needed.
      const snap = typeof live === 'function' ? live() : null;
      if (snap && (snap.next_moves || snap.upcoming)) return weekLine(snap, { now: now() });
      const list = typeof files === 'function' ? files() : files;
      let stamp = '';
      for (const f of list) { try { stamp += f + ':' + fs.statSync(f).mtimeMs + ';'; } catch (_) { stamp += f + ':-;'; } }
      const key = stamp + startOfDay(now());
      if (key === cache.key) return cache.line;
      const b = readBridge(list);
      cache = { key, line: b ? weekLine(b.context, { now: now() }) : '' };
      return cache.line;
    } catch (_) { return ''; }
  };
}

module.exports = { bridgeCandidates, readBridge, dueThisWeek, weekLine, createThisWeek, localDay };
