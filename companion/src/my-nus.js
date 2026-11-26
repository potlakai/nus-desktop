'use strict';
// My Nus: the page about the person (plan 2026-11-06, section 5). Worked out
// here, on this computer, from the local record (companion/src/retention.js)
// and counts of what the person keeps. Nothing in it is sent anywhere.
//
// "Time given back" is an estimate and says so: a deliberately low number of
// minutes each kind of task would take by hand, times the tasks that worked.
// Some numbers unlock only after a few days of use, the way Raycast Wrapped
// waits 14 days and Wispr Flow 500 words, so there is something to come back for.
//
// Pure Node, no Electron, so it runs under node --test.
const { localDay } = require('./retention');

const DAY_MS = 86400000;
const LABELS = {
  guide: 'Showing you where things are', chat: 'Answering your questions', reflex: 'Quick commands', hands: 'Doing it for you',
  rewrite: 'Rewriting your text', recall: 'Finding your old chats', memory: 'Remembering for you', reminder: 'Reminders',
  focus_guard: 'Keeping feeds away', page_read: 'Summing up pages', project: 'Picking up projects',
};
// Minutes by hand, kept low on purpose so the estimate never flatters.
const MINUTES_BY_HAND = { guide: 1, chat: 1, reflex: 0.25, hands: 1.5, rewrite: 2, recall: 1.5, memory: 0.25, reminder: 0.5, focus_guard: 0, page_read: 2, project: 1 };
const UNLOCKS = [
  { key: 'busiest_hour', label: 'Your busiest hour', days: 5 },
  { key: 'best_day', label: 'Your best day of the week', days: 7 },
  { key: 'week_compare', label: 'This week next to last week', days: 10 },
];
const MILESTONES = [1, 10, 50, 100, 250, 500, 1000];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function startOfDay(t) { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); }
// Monday of the week t falls in, on the person's clock.
function mondayOf(t) { const d = new Date(startOfDay(t)); const back = (d.getDay() + 6) % 7; d.setDate(d.getDate() - back); return d.getTime(); }
function addDays(t, n) { const d = new Date(t); d.setDate(d.getDate() + n); return d.getTime(); }
function hourWords(h) { const pm = h >= 12; const x = h % 12 || 12; return x + (pm ? ' PM' : ' AM'); }
function sumOver(byDay, from, to) { let n = 0; for (const [k, v] of Object.entries(byDay || {})) if (k >= from && k <= to) n += Number(v) || 0; return n; }

// The workday streak: weekdays in a row with Nus used, counted back from
// today. Weekends never break it, today not used yet never breaks it, and one
// missed weekday in a run is forgiven by itself (Duolingo's weekend amulet and
// streak freeze, Apple's paused rings: no punishment for a normal life).
function workdayStreak(days, now) {
  const used = new Set(days || []);
  let t = startOfDay(now), streak = 0, forgiven = 0;
  if (!used.has(localDay(t))) t = addDays(t, -1);
  for (let guard = 0; guard < 800; guard++, t = addDays(t, -1)) {
    const wd = new Date(t).getDay();
    if (wd === 0 || wd === 6) continue;
    if (used.has(localDay(t))) { streak++; continue; }
    if (forgiven === 0 && streak > 0) { forgiven++; continue; }
    break;
  }
  return { days: streak, forgiven };
}

/**
 * @param {object} o
 * @param {object} o.record  getRetention().record()
 * @param {number} [o.now]
 * @param {object} [o.kept]  { memories, projects, routines, reminders, walkthroughs }: counts
 */
function summary(o) {
  const now = o.now || Date.now();
  const r = o.record || {};
  const days = r.days || [];
  const wins = r.wins || {};
  const daysUsed = days.length;
  const today = localDay(now);

  // This week, Monday to Sunday: a dot for each day used.
  const mon = mondayOf(now);
  const week = [];
  for (let i = 0; i < 7; i++) {
    const t = addDays(mon, i), k = localDay(t);
    week.push({ day: WEEKDAYS[new Date(t).getDay()], date: k, used: days.includes(k), wins: (r.winsByDay || {})[k] || 0, today: k === today, future: k > today });
  }
  const weekFrom = localDay(mon), weekTo = localDay(addDays(mon, 6));
  const lastFrom = localDay(addDays(mon, -7)), lastTo = localDay(addDays(mon, -1));

  const top = Object.entries(wins).filter(([f, n]) => LABELS[f] && n > 0).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([feature, count]) => ({ feature, label: LABELS[feature], count }));
  let minutes = 0;
  for (const [f, n] of Object.entries(wins)) minutes += (MINUTES_BY_HAND[f] || 0) * (Number(n) || 0);

  const unlocks = UNLOCKS.map((u) => ({ ...u, unlocked: daysUsed >= u.days, daysLeft: Math.max(0, u.days - daysUsed) }));
  const isOpen = (key) => unlocks.find((u) => u.key === key).unlocked;
  let busiestHour = null;
  if (isOpen('busiest_hour')) {
    const best = Object.entries(r.winsByHour || {}).sort((a, b) => b[1] - a[1])[0];
    if (best) busiestHour = hourWords(Number(best[0]));
  }
  let bestDay = null;
  if (isOpen('best_day')) {
    const byWeekday = {};
    for (const [k, v] of Object.entries(r.winsByDay || {})) { const [y, m, d] = k.split('-').map(Number); const wd = WEEKDAYS[new Date(y, m - 1, d).getDay()]; byWeekday[wd] = (byWeekday[wd] || 0) + v; }
    const best = Object.entries(byWeekday).sort((a, b) => b[1] - a[1])[0];
    if (best) bestDay = best[0];
  }
  const weekCompare = isOpen('week_compare') ? { thisWeek: sumOver(r.winsByDay, weekFrom, weekTo), lastWeek: sumOver(r.winsByDay, lastFrom, lastTo) } : null;

  const total = r.winsTotal || 0;
  const nextMilestone = MILESTONES.find((m) => m > total) || null;
  const firstDay = r.firstDay || null;
  let since = 0;
  if (firstDay) { const [y, m, d] = firstDay.split('-').map(Number); since = Math.max(0, Math.round((startOfDay(now) - new Date(y, m - 1, d).getTime()) / DAY_MS)); }

  return {
    thingsDone: total,
    daysUsed,
    firstDay,
    daysSinceFirst: since,
    week,
    weekDone: sumOver(r.winsByDay, weekFrom, weekTo),
    weekBlocked: sumOver(r.blockedByDay, weekFrom, weekTo),
    streak: workdayStreak(days, now),
    topUses: top,
    minutesBack: Math.round(minutes),
    minutesBackIsEstimate: true,
    feedsBlocked: r.blockedTotal || 0,
    busiestHour,
    bestDay,
    weekCompare,
    unlocks,
    nextMilestone,
    kept: { memories: 0, projects: 0, routines: 0, reminders: 0, walkthroughs: 0, ...(o.kept || {}) },
  };
}

// The milestone a win just reached, or null: 1st, 10th, 50th, 100th...
function milestoneAt(total) { return MILESTONES.includes(total) ? total : null; }

module.exports = { summary, workdayStreak, milestoneAt, LABELS, MINUTES_BY_HAND, UNLOCKS, MILESTONES, mondayOf };
