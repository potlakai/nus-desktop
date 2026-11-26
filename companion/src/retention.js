'use strict';
// Retention loops (plan approved 2026-11-06, research in the vault at
// ventures/nus/research/retention-2026-11-06). This file decides; the host
// (companion/index.js) shows the bubbles and the toasts.
//
// - Start with Windows is offered right after the first thing that worked,
//   never at install, at most twice ("Not now" asks once more on a later day).
// - Every proactive pop-up shares one budget: one a day, three in seven days.
//   Three ignored in a row and the Knot says once that it will stay quiet, then
//   stays quiet until the person calls it. One install in ten (the holdout)
//   gets no proactive pop-ups at all.
// - The morning line: one short line from the person's own things (a reminder
//   due today, a project kept this week), once a day, or nothing.
// - The check-in: after the tour, the person's own "this week" answer becomes
//   an offer to check in tomorrow at 9.
// - A local record of the days Nus was used and the things that worked, for My
//   Nus and the streak. It never leaves this computer.
//
// Pure Node, no Electron, so it runs under node --test.
const fs = require('fs');
const path = require('path');

const DAY_MS = 86400000;
const BUDGET = { perDay: 1, perWeek: 3, quietAfterIgnored: 3 };
const AUTOSTART_MAX_OFFERS = 2;
// Pop-ups that answer something the person just did, or that they asked for
// themselves: outside the budget and the holdout.
const EXEMPT = new Set(['autostart_offer', 'reminder_toast', 'quiet_mode', 'milestone']);
const MAX_DAYS_KEPT = 400;
const CHECKIN_HOUR = 9;
const GOAL_MAX = 60;
// Wave 2 (plan 2026-11-06).
// Milestones the Knot marks; the first is left to the start-with-Windows offer.
const MILESTONES = [10, 50, 100, 250, 500, 1000];
// One line each for things the person has not tried yet: the day-3 win-back.
const TIPS = [
  ['focus_guard', 'Say "keep me off Reels for 20 minutes" and I close feed tabs until the time is up.'],
  ['reminder', 'Say "remind me at 4 to email Professor Lee" and I will.'],
  ['guide', 'Stuck in an app? Ask "where is the export button" and I point right at it.'],
  ['rewrite', 'Select some text and say "make this friendlier". I rewrite it where it is.'],
  ['memory', 'Say "remember that my exam is Friday" and I keep it for you.'],
];
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
// Minutes by hand per task, the same low numbers My Nus uses.
const MINUTES_BY_HAND = { guide: 1, chat: 1, reflex: 0.25, hands: 1.5, rewrite: 2, recall: 1.5, memory: 0.25, reminder: 0.5, focus_guard: 0, page_read: 2, project: 1 };
function addDays(t, n) { const d = new Date(t); d.setDate(d.getDate() + n); return d.getTime(); }
function dayStart(t) { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); }
function dayKeyTime(k) { const [y, m, d] = String(k).split('-').map(Number); return new Date(y, m - 1, d).getTime(); }

function pad(n) { return String(n).padStart(2, '0'); }
// The person's own calendar day, not UTC: "today" is the day on their clock.
function localDay(t) { const d = new Date(t); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { return {}; } }
function writeJson(file, value) {
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2)); fs.renameSync(file + '.tmp', file); } catch { /* never breaks the app */ }
}

// The person's "this week" answer, cut to something a bubble can say back.
function goalText(raw) {
  let t = String(raw || '').replace(/\s+/g, ' ').trim().replace(/[.!?]+$/, '');
  t = t.replace(/^(?:i\s+(?:want|would like|need|hope)\s+to\s+|to\s+|probably\s+|maybe\s+)/i, '');
  if (!t || t.length < 3) return '';
  if (t.length > GOAL_MAX) { t = t.slice(0, GOAL_MAX); const sp = t.lastIndexOf(' '); if (sp > 30) t = t.slice(0, sp); t += '...'; }
  return t;
}
// Tomorrow at 9 on the person's clock.
function tomorrowAt(now, hour = CHECKIN_HOUR) {
  const d = new Date(now); d.setDate(d.getDate() + 1); d.setHours(hour, 0, 0, 0); return d.getTime();
}
// "Morning." before noon, "Afternoon." before five, "Evening." after.
function hello(t) { const h = new Date(t).getHours(); return h < 12 ? 'Morning.' : h < 17 ? 'Afternoon.' : 'Evening.'; }
function clockWords(t) {
  const d = new Date(t); let h = d.getHours(); const m = d.getMinutes(); const pm = h >= 12; h = h % 12 || 12;
  return h + (m ? ':' + pad(m) : '') + (pm ? ' PM' : ' AM');
}

/**
 * @param {object} o
 * @param {string} o.file              userData/companion/retention.json
 * @param {() => number} [o.now]
 * @param {() => string} [o.nudgeGroup] 'on' | 'off' (the holdout), from stats
 */
function createRetention(o) {
  const now = o.now || Date.now;
  const group = o.nudgeGroup || (() => 'on');
  let state = null;
  function st() { if (!state) state = readJson(o.file); return state; }
  function save(patch) { state = { ...st(), ...patch }; writeJson(o.file, state); }

  // ---- the local record ----
  function noteEngaged() {
    const day = localDay(now());
    const days = st().days || [];
    const patch = {};
    if (!st().firstDay) patch.firstDay = day;
    if (days[days.length - 1] !== day) patch.days = days.concat(day).slice(-MAX_DAYS_KEPT);
    // Calling the Knot ends a quiet spell.
    if (st().quiet) { patch.quiet = false; patch.ignoredRun = 0; }
    if (Object.keys(patch).length) save(patch);
  }
  function noteWin(feature) {
    const wins = { ...(st().wins || {}) };
    wins[feature] = (wins[feature] || 0) + 1;
    const byDay = { ...(st().winsByDay || {}) };
    const day = localDay(now());
    byDay[day] = (byDay[day] || 0) + 1;
    const keys = Object.keys(byDay).sort();
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_DAYS_KEPT))) delete byDay[k];
    const byHour = { ...(st().winsByHour || {}) };
    const h = new Date(now()).getHours();
    byHour[h] = (byHour[h] || 0) + 1;
    save({ wins, winsByDay: byDay, winsByHour: byHour, winsTotal: (st().winsTotal || 0) + 1 });
    return st().winsTotal;
  }
  // A feed tab the focus guard closed.
  function noteBlocked() {
    const byDay = { ...(st().blockedByDay || {}) };
    const day = localDay(now());
    byDay[day] = (byDay[day] || 0) + 1;
    save({ blockedByDay: byDay, blockedTotal: (st().blockedTotal || 0) + 1 });
  }
  function record() {
    const s = st();
    return { days: (s.days || []).slice(), firstDay: s.firstDay || null, wins: { ...(s.wins || {}) }, winsByDay: { ...(s.winsByDay || {}) }, winsTotal: s.winsTotal || 0,
      blockedByDay: { ...(s.blockedByDay || {}) }, blockedTotal: s.blockedTotal || 0, winsByHour: { ...(s.winsByHour || {}) } };
  }

  // ---- start with Windows ----
  // After a win: offer unless it is on already, was answered yes or no, was
  // offered today, or has been offered twice.
  function autostartDue(enabledNow) {
    if (enabledNow) return false;
    const a = st().autostart || {};
    if (a.answer === 'yes' || a.answer === 'no') return false;
    if ((a.offers || 0) >= AUTOSTART_MAX_OFFERS) return false;
    if (a.lastDay === localDay(now())) return false;
    return true;
  }
  function autostartOffered() { const a = st().autostart || {}; save({ autostart: { ...a, offers: (a.offers || 0) + 1, lastDay: localDay(now()) } }); }
  function autostartAnswer(answer) {
    const a = st().autostart || {};
    save({ autostart: { ...a, answer: answer === 'yes' ? 'yes' : answer === 'no' ? 'no' : 'later' } });
  }

  // ---- the pop-up budget ----
  function recent(ms) { const t = now(); return (st().popups || []).filter(p => t - p.at < ms); }
  function canPop(hook) {
    if (EXEMPT.has(hook)) return true;
    if (group() === 'off') return false;
    if (st().quiet) return false;
    const today = localDay(now());
    if ((st().popups || []).filter(p => localDay(p.at) === today).length >= BUDGET.perDay) return false;
    if (recent(7 * DAY_MS).length >= BUDGET.perWeek) return false;
    return true;
  }
  function popped(hook) {
    if (EXEMPT.has(hook)) return;
    save({ popups: (st().popups || []).concat({ at: now(), hook }).filter(p => now() - p.at < 8 * DAY_MS) });
  }
  // How the person met a pop-up: used (took it), dismissed (said no: they saw
  // it, so it is not ignored), ignored (it timed out untouched). Returns
  // { quiet: true } the moment the third ignored in a row starts a quiet spell,
  // so the host says so once.
  function outcome(hook, how) {
    if (EXEMPT.has(hook)) return { quiet: false };
    if (how === 'ignored') {
      const run = (st().ignoredRun || 0) + 1;
      if (run >= BUDGET.quietAfterIgnored) { save({ ignoredRun: 0, quiet: true, quietSince: now() }); return { quiet: true }; }
      save({ ignoredRun: run });
      return { quiet: false };
    }
    save({ ignoredRun: 0 });
    return { quiet: false };
  }
  function quiet() { return !!st().quiet; }

  // ---- the morning line ----
  // reminders: [{ at, what, kind }]; projects: [{ name, lastAt }]. The first
  // that fits, or null. Once a day; the host checks the budget.
  function morningLine({ reminders = [], projects = [] } = {}) {
    const t = now(), today = localDay(t);
    if (st().morningDay === today) return null;
    const due = reminders.filter(r => r && r.kind !== 'timer' && r.at > t && localDay(r.at) === today).sort((a, b) => a.at - b.at)[0];
    if (due) return { hook: 'morning_line', kind: 'reminder', text: hello(t) + ' At ' + clockWords(due.at) + ' you have: ' + String(due.what || '').slice(0, 80) + '.', actions: [{ id: 'rt-ok', label: 'OK', primary: true }] };
    const p = projects.filter(x => x && x.name && t - (Number(x.lastAt) || 0) < 7 * DAY_MS).sort((a, b) => b.lastAt - a.lastAt)[0];
    if (p) return { hook: 'morning_line', kind: 'project', project: p.name, text: hello(t) + ' Pick up "' + String(p.name).slice(0, 60) + '" where you left off?', actions: [{ id: 'rt-continue', label: 'Continue', primary: true }, { id: 'rt-notnow', label: 'Not now' }] };
    return null;
  }
  function morningShown() { save({ morningDay: localDay(now()) }); }

  // ---- the check-in ----
  // The tour's "What would you like to get done this week?" answer, offered
  // back once: { text, goal, at } or null.
  function checkinOffer(answer) {
    if ((st().checkin || {}).offered) return null;
    const goal = goalText(answer);
    if (!goal) return null;
    const at = tomorrowAt(now());
    return { hook: 'checkin', goal, at, text: 'You said you want to get this done this week: ' + goal + '. Want me to check in tomorrow at ' + clockWords(at) + '?',
      actions: [{ id: 'rt-checkin-yes', label: 'Yes, check in', primary: true }, { id: 'rt-notnow', label: 'Not now' }] };
  }
  // ---- wave 2 ----
  // A milestone just reached by the win total, or null.
  function milestone(total) { return MILESTONES.includes(total) && !(st().milestones || []).includes(total) ? total : null; }
  function milestoneShown(n) { save({ milestones: (st().milestones || []).concat(n) }); }
  // The Monday report: on a Monday, once that week, about last week, and only
  // when last week had something in it.
  function knotReport() {
    const t = now();
    if (new Date(t).getDay() !== 1) return null;
    const week = localDay(t);
    if (st().reportWeek === week) return null;
    const from = localDay(addDays(dayStart(t), -7)), to = localDay(addDays(dayStart(t), -1));
    let done = 0, blocked = 0; const byDay = {};
    for (const [k, v] of Object.entries(st().winsByDay || {})) if (k >= from && k <= to) { done += v; byDay[k] = v; }
    for (const [k, v] of Object.entries(st().blockedByDay || {})) if (k >= from && k <= to) blocked += v;
    if (!done && !blocked) return null;
    const total = st().winsTotal || 0;
    let perWin = 0; for (const [f, n] of Object.entries(st().wins || {})) perWin += (MINUTES_BY_HAND[f] || 0) * n;
    const minutes = total ? Math.round(done * perWin / total) : 0;
    const best = Object.entries(byDay).sort((a, b) => b[1] - a[1])[0];
    const parts = [done + ' thing' + (done === 1 ? '' : 's') + ' done'];
    if (blocked) parts.push(blocked + ' feed' + (blocked === 1 ? '' : 's') + ' kept away');
    if (minutes >= 5) parts.push('about ' + minutes + ' minutes given back');
    const text = 'Last week: ' + parts.join(', ') + '.' + (best && done > 2 ? ' Best day: ' + WEEKDAY_NAMES[new Date(dayKeyTime(best[0])).getDay()] + '.' : '');
    return { hook: 'knot_report', week, text, actions: [{ id: 'rt-mynus', label: 'See My Nūs', primary: true }, { id: 'rt-ok', label: 'OK' }] };
  }
  function knotReportShown(week) { save({ reportWeek: week }); }
  // Win-back: the person is at the computer, Nus is running, but they have not
  // used it for 3, 7 or 30 days. Three lines in a lifetime, then silence.
  function winback({ projects = [] } = {}) {
    const days = st().days || [];
    if (!days.length) return null;
    const gap = Math.floor((dayStart(now()) - dayKeyTime(days[days.length - 1])) / DAY_MS);
    const sent = st().winback || {};
    if (sent.d30) return null;
    if (gap >= 30 && !sent.d30) return { hook: 'winback_d30', step: 'd30', text: 'I will stay out of your way from now on. Hold the talk key whenever you want me.', actions: [{ id: 'rt-ok', label: 'OK', primary: true }] };
    if (gap >= 7 && !sent.d7) {
      const p = projects.filter((x) => x && x.name).sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0))[0];
      if (p) return { hook: 'winback_d7', step: 'd7', project: p.name, projectId: p.id, text: 'Your "' + String(p.name).slice(0, 60) + '" is waiting where you left it. Pick it up?', actions: [{ id: 'rt-continue', label: 'Continue', primary: true }, { id: 'rt-notnow', label: 'Not now' }] };
      return { hook: 'winback_d7', step: 'd7', text: 'Still here. Hold the talk key whenever you need a hand with anything on your screen.', actions: [{ id: 'rt-ok', label: 'OK', primary: true }] };
    }
    if (gap >= 3 && !sent.d3 && !sent.d7) {
      const used = st().wins || {};
      const tip = TIPS.find(([f]) => !used[f]) || TIPS[0];
      return { hook: 'winback_d3', step: 'd3', text: 'Something you have not tried yet: ' + tip[1], actions: [{ id: 'rt-ok', label: 'Got it', primary: true }] };
    }
    return null;
  }
  function winbackShown(step) { save({ winback: { ...(st().winback || {}), [step]: now() } }); }
  // The Sean Ellis question, once, after the 10th thing that worked.
  function pmfDue() { return (st().winsTotal || 0) >= 10 && !st().pmfAsked; }
  function pmfAsked(answer) { save({ pmfAsked: now(), pmfAnswer: answer || null }); }

  function checkinOffered(answer) { save({ checkin: { offered: true, at: now(), answer: answer || null } }); }
  function checkinAnswered(answer) { save({ checkin: { ...(st().checkin || {}), answer } }); }

  // ---- dictation, told once to an install that took the update (0.1.38) ----
  // The tour's dictation card is only seen by new installs. Known already when
  // that card was shown or a dictation has landed; otherwise due once.
  function dictationNewsDue() { return !st().dictationNews; }
  function dictationNewsShown() { save({ dictationNews: 'shown' }); }
  function dictationKnown() { if (!st().dictationNews) save({ dictationNews: 'known' }); }

  return { dictationNewsDue, dictationNewsShown, dictationKnown, noteEngaged, noteWin, noteBlocked, record, autostartDue, autostartOffered, autostartAnswer, canPop, popped, outcome, quiet, morningLine, morningShown,
    checkinOffer, checkinOffered, checkinAnswered, milestone, milestoneShown, knotReport, knotReportShown, winback, winbackShown, pmfDue, pmfAsked,
    state: () => ({ ...st() }) };
}

module.exports = { createRetention, localDay, goalText, tomorrowAt, clockWords, hello, MILESTONES, TIPS, BUDGET, EXEMPT, AUTOSTART_MAX_OFFERS, DAY_MS };
