'use strict';
// "What's my brief", "what's on my plate today": read out of the newest brief
// the vault's own morning script saved (scripts/morning_brief.py runs /brief
// and /today at login and writes logs/brief-YYYY-MM-DD.md). Read only: the
// Companion never runs claude -p for this, and no model is asked. A brief that
// is not today's says so.
const fs = require('fs');
const path = require('path');

const BRIEF_RE = /^brief-(\d{4}-\d{2}-\d{2})\.md$/;
const SECTIONS = ['In motion', 'Growth', 'Career', 'Worth a look', "Today's #1"];
const SECTION_WORDS = [
  [/\b(career|internships?|jobs?|applications?)\b/i, 'Career'],
  [/\b(growth|funnel|reels?|posts?|approvals?)\b/i, 'Growth'],
  [/\b(in motion|ventures?|projects?)\b/i, 'In motion'],
  [/\bworth a look\b/i, 'Worth a look'],
  [/(#\s?1|number one|one thing|most important|top thing)/i, "Today's #1"],
];

function localDay(ms) {
  const d = new Date(ms);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function spokenDate(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
}
// Markdown -> words that read aloud well. No em dashes in what Nūs says.
function plain(md) {
  return String(md || '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1')
    .replace(/\*\*/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^#+\s*/gm, '')
    .replace(/^\s*(?:[-*]|\d+[.)])\s+/gm, '')
    .replace(/\s*[\u2013\u2014]\s*/g, ', ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}
function firstSentences(text, n) {
  const parts = String(text).replace(/\s+/g, ' ').match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) || [];
  return parts.slice(0, n).join('').trim();
}

function parseBrief(md) {
  const text = String(md || '').replace(/\r\n/g, '\n');
  const cut = text.search(/^##\s+Today'?s Tasks\s*$/m);
  const briefPart = (cut >= 0 ? text.slice(0, cut) : text).replace(/^#\s+Morning Brief.*$/m, '').trim();
  const todayPart = cut >= 0 ? text.slice(cut).replace(/^##\s+Today'?s Tasks\s*$/m, '').trim() : '';
  const sections = {};
  const labelRe = /^\*\*(.+?)\*\*\s*$/gm;
  const marks = [];
  let m;
  while ((m = labelRe.exec(briefPart))) if (SECTIONS.includes(m[1].trim())) marks.push({ label: m[1].trim(), start: m.index, end: m.index + m[0].length });
  sections.opening = (marks.length ? briefPart.slice(0, marks[0].start) : briefPart).trim();
  marks.forEach((mk, i) => { sections[mk.label] = briefPart.slice(mk.end, i + 1 < marks.length ? marks[i + 1].start : briefPart.length).trim(); });
  const tasks = (todayPart.match(/^\s*\d+[.)]\s+.+$/gm) || []).map((l) => plain(l));
  const most = /\*\*Most important:?\*\*:?\s*(.+)$/im.exec(todayPart) || /Most important:?\s*(.+)$/im.exec(todayPart);
  return { sections, tasks, mostImportant: most ? plain(most[1]) : '', todayText: todayPart };
}

// The newest logs/brief-YYYY-MM-DD.md under the notes folder, or null.
function latestBrief(root, { now = Date.now() } = {}) {
  if (!root) return null;
  const dir = path.join(root, 'logs');
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => BRIEF_RE.test(n)).sort(); } catch (_) { return null; }
  for (let i = names.length - 1; i >= 0; i--) {
    const file = path.join(dir, names[i]);
    let md = '';
    try { md = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }
    if (md.trim().length < 120) continue;   // a failed run's stub
    const date = BRIEF_RE.exec(names[i])[1];
    return { file, date, isToday: date === localDay(now), ...parseBrief(md) };
  }
  return null;
}

function staleLine(b) { return b.isToday ? '' : 'Your newest brief is from ' + spokenDate(b.date) + ', so it may be out of date. '; }

// -> { say, show } for "what's my brief" (whole, or one section when asked).
function briefAnswer(b, ask = '') {
  if (!b) return { say: 'I could not find a brief. Your morning script saves one in the logs folder of your notes.', show: 'No brief found in logs/ of your notes folder. The morning script (scripts/morning_brief.py) writes logs/brief-YYYY-MM-DD.md.' };
  const wanted = (SECTION_WORDS.find(([re]) => re.test(ask)) || [])[1];
  if (wanted && b.sections[wanted]) {
    const body = plain(b.sections[wanted]);
    return { say: staleLine(b) + firstSentences(body, 3), show: wanted + ' (brief of ' + b.date + ')\n\n' + body.slice(0, 1400) };
  }
  // The brief opens with its own date ("Today is Wednesday, ..."); a stale one
  // would say the wrong day out loud, so that sentence goes and staleLine says it.
  const opening = plain(b.sections.opening).replace(/^Today is [^.]*\.\s*/, '');
  const one = plain(b.sections["Today's #1"] || '');
  const say = staleLine(b) + firstSentences(opening, 2) + (one ? ' Your number one today: ' + firstSentences(one, 1) : '');
  const show = ['Brief of ' + b.date, opening, ...SECTIONS.filter((s) => b.sections[s]).map((s) => s + ': ' + plain(b.sections[s]).replace(/\n+/g, ' ').slice(0, 320))].join('\n\n');
  return { say: say.trim(), show: show.slice(0, 1800) };
}

// -> { say, show } for "what's on my plate today".
function todayAnswer(b) {
  if (!b) return briefAnswer(null);
  if (!b.tasks.length) return { say: staleLine(b) + 'The brief has no task list today.', show: 'No task list in the brief of ' + b.date + '.' };
  const count = b.tasks.length === 1 ? 'One task' : b.tasks.length + ' tasks';
  const say = staleLine(b) + count + ' for today. ' + (b.mostImportant ? 'Most important: ' + firstSentences(b.mostImportant, 1) : 'First: ' + firstSentences(b.tasks[0], 1));
  const show = 'Today (brief of ' + b.date + ')\n\n' + b.tasks.map((t, i) => (i + 1) + '. ' + t).join('\n') + (b.mostImportant ? '\n\nMost important: ' + b.mostImportant : '');
  return { say: say.trim(), show: show.slice(0, 1800) };
}

module.exports = { latestBrief, parseBrief, briefAnswer, todayAnswer, plain, localDay };
