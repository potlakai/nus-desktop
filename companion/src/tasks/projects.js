'use strict';
// Projects: a task the person chose to keep, by name, so "continue" can pick
// it up another day. Kept in <dir>/projects.json on this machine.
//
// A project holds only what the task itself recorded while it ran: the sources
// (window titles, file paths, URLs the Hands loop acted in), the decisions and
// consent answers, the last completed step, the next step, and one
// human-readable summary line. Nothing is recorded outside a task the person
// started, and nothing is watched between tasks (rulings of 2026-10-17 and
// 2026-10-21). Words Hands typed and clipboard contents are never stored: the
// executor scrubs what it hands over, and this module scrubs again.
//
// One exception, ruled by Pranav on 2026-11-03 for this one case only: when the
// person says to keep something and no task record exists, a project is noted from
// their own last ask in the past half hour and the window in front at that moment,
// read once. It knowingly bends the two rulings above, which otherwise stand. A
// noted project is answered in words and Hands does not re-run it. An ask or window
// title memory would refuse (card numbers, passwords, ID numbers) is not stored.
//
// Pure Node: fs, path and crypto only. The clock is injectable for tests.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { remove: removeFile } = require('./journal');

const FILE = 'projects.json';
const MAX_SOURCES = 40;
const MAX_DECISIONS = 20;
const SOURCE_KINDS = ['window', 'file', 'url'];
const MIN_TYPED_WORDS = 3;

function clip(s, n) { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function norm(s) { return String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim(); }

// ---- typed words ----------------------------------------------------------
// Remove from text anything the person's task typed: the whole string, or any
// run of three or more of its words in order.
function scrubTyped(text, typed) {
  let out = String(text == null ? '' : text);
  for (const raw of Array.isArray(typed) ? typed : []) {
    const words = norm(raw).split(' ').filter(Boolean);
    if (!words.length) continue;
    if (words.length < MIN_TYPED_WORDS) {
      // A short entry is matched whole only: "hello" alone, not every "a".
      if (words.join('').length < 3) continue;
      out = out.replace(new RegExp('(^|[^\\p{L}\\p{N}])' + words.map(esc).join('[^\\p{L}\\p{N}]+') + '(?=$|[^\\p{L}\\p{N}])', 'giu'), '$1…');
      continue;
    }
    for (let n = words.length; n >= MIN_TYPED_WORDS; n--) {
      for (let i = 0; i + n <= words.length; i++) {
        out = out.replace(new RegExp(words.slice(i, i + n).map(esc).join('[^\\p{L}\\p{N}]+'), 'giu'), '…');
      }
    }
  }
  return out.replace(/(?:…\s*)+/g, '… ').replace(/\s+/g, ' ').trim();
}
function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function holdsTyped(text, typed) { return scrubTyped(text, typed) !== String(text == null ? '' : text).replace(/\s+/g, ' ').trim(); }

// A web address without its query or fragment: those carry search words and tokens.
function cleanUrl(u) {
  try { const x = new URL(String(u)); if (!/^https?:$/.test(x.protocol)) return ''; return x.origin + x.pathname; } catch (_) { return ''; }
}

// ---- the words the person says ---------------------------------------------
// Could these words after "save this project" be its name? Not a word about files
// or the state it should stay in, not the start of a longer sentence.
const NOT_A_NAME = /^(?:files?|folders?|settings|open|closed|running|going|alive|safe|in|on|at|to|into|onto|up|down|for|from|with|and|or|but|so|as|if|when|because|before|after|now|please|later)\b/i;
function plainProjectName(s) {
  const name = String(s || '').trim();
  return Boolean(name) && !NOT_A_NAME.test(name) && name.split(/\s+/).length <= 4;
}
// How a keep can open and what it can be about. Every rule using these still has to
// say "project".
const KEEP_LEAD = "(?:(?:can|could|would) you(?: please)? |let'?s |i(?: want| would like|'d like) to )?";
const KEEP_WHAT = '(?:keep|save|store|remember) (?:this|that|it|these|those|all of (?:this|that|it)|everything)(?: tasks?| (?:to[- ]do )?lists?)?';
// -> null, or { kind: 'keep', name } | { kind: 'name', name } | { kind: 'continue', name } | { kind: 'recall' }
function parseProjectAsk(text) {
  // "No, what were we working on?": a correction in front changes nothing (live
  // 2026-11-03: the "No," sent it to the notes search instead).
  const t = String(text || '').replace(/\s+/g, ' ').trim().replace(/[.!?]+$/, '').replace(/^(?:(?:ok(?:ay)?|hey|please|so|no|nope|wait|actually|sorry|hold on)[,.!?]*\s+)+/i, '').trim();
  if (!t) return null;
  // "Keep this as project groceries", "keep this as a project called groceries",
  // "save it as my project": the name follows "project" with or without
  // "called" (live 2026-11-03: without it, the words were typed into Notepad).
  // Spoken 2026-11-03: "save those as a project" and "can you save this to-do
  // list as a project" are keeps too. Require "as ... project": an ordinary
  // "save this as groceries" is still the front app's Save As command.
  let m = new RegExp('^' + KEEP_LEAD + KEEP_WHAT + ' as (?:a |my |the )?(?:new )?project(?: (?:called|named|for|:))?(?: (.+))?$', 'i').exec(t);
  if (m) return { kind: 'keep', name: m[1] ? clip(m[1].replace(/^["']|["']$/g, ''), 60) : '' };
  // "Save this to a project called groceries": with "to" or "in" it needs the name,
  // since "save this to the project" and "save it in my project" are about files.
  m = new RegExp('^' + KEEP_LEAD + KEEP_WHAT + ' (?:to|in) (?:a |my |the )?(?:new )?project (?:called|named) (.+)$', 'i').exec(t);
  if (m) return { kind: 'keep', name: clip(m[1].replace(/^["']|["']$/g, ''), 60) };
  // The same without the "as", or with it misheard or mistyped as "s" (live
  // 2026-11-03: "save this project groceries", "keep this s project groceries").
  // Without the "as" the words can mean the project in front: "save this project"
  // is Ctrl+S in an editor, "keep this project open" is not a name.
  m = /^(keep|save|store)(?: (this|that|it)(?: task)?)?(?: s| as)? (?:a |my |the )?project(?: (?:called|named|:))?(?: (.+))?$/i.exec(t);
  if (m && (m[3] ? plainProjectName(m[3]) : m[2] && /^keep$/i.test(m[1]))) return { kind: 'keep', name: m[3] ? clip(m[3].replace(/^["']|["']$/g, ''), 60) : '' };
  m = new RegExp('^' + KEEP_LEAD + '(?:make|turn) (?:this|that|it) (?:into )?(?:a )?(?:new )?project(?: (?:called|named|for|:))?(?: (.+))?$', 'i').exec(t);
  if (m) return { kind: 'keep', name: m[1] ? clip(m[1].replace(/^["']|["']$/g, ''), 60) : '' };
  m = /^(?:call|name) (?:this|that|it)(?: project)? (.+)$/i.exec(t);
  if (m) return { kind: 'name', name: clip(m[1].replace(/^["']|["']$/g, ''), 60) };
  if (/^(?:(?:what|which)(?: project)? (?:were|was) (?:we|i) (?:working on|doing)(?: yesterday| last time| before)?|where (?:were we|did we leave off|did we stop))$/i.test(t)) return { kind: 'recall' };
  if (/^(?:let'?s )?(?:continue|resume|pick (?:it|this) (?:back )?up)(?: where (?:we|i) left off)?$/i.test(t)) return { kind: 'continue', name: '' };
  m = /^(?:let'?s )?(?:continue|resume|pick up|get back to|go back to)(?: (?:on|with|working on))? (?:the |my )?(.+?)$/i.exec(t);
  if (m) {
    // "Continue project groceries", the way it was kept, says "project" as much as
    // "continue my groceries project" does.
    const lead = /^project(?: (?:called|named))? (.+)$/i.exec(m[1]);
    const said = Boolean(lead) || /\bproject$/i.test(m[1]);
    return { kind: 'continue', name: clip(lead ? lead[1] : m[1].replace(/\s*\bproject$/i, ''), 60), said };
  }
  return null;
}

// ---- the same words with the Task list off ---------------------------------
// The words above are read loosely, and tryProjectAsk filters them against the
// tasks and projects it finds. With the switch off there is no task to go by, so
// only what is plainly about a project is taken. "Continue" is the walkthrough's
// next step and Hands' keep going; "go back to Chrome" and "call this Alice" are
// someone's ordinary words, and they route on with the switch left alone.
const LIST_OFF_LINE = 'Task list is on now. The last Hands run was not recorded, so ask again, then keep it.';
function claimedWithListOff(ask, text, isSaved) {
  if (!ask) return false;
  if (ask.kind === 'keep' || ask.kind === 'recall') return true;
  if (ask.kind === 'name') return /\bproject\b/i.test(String(text || ''));
  if (ask.kind === 'continue') return Boolean(ask.said) || Boolean(ask.name && isSaved && isSaved(ask.name));
  return false;
}
// Every word said is in the name: what find goes by, an exact name included.
function nameFits(have, name) {
  const words = norm(name).split(' ').filter(Boolean);
  if (!words.length) return false;
  const set = new Set(norm(have).split(' '));
  return words.every((w) => set.has(w));
}
// Is there a project of this name, read with the task system not running: no
// store is made and no folder created. A torn or missing file holds none.
function hasSavedProject(dir, name) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8'));
    return Array.isArray(data && data.projects) && data.projects.some((p) => p && typeof p.id === 'string' && typeof p.name === 'string' && nameFits(p.name, name));
  } catch (_) { return false; }
}

// ---- a project with no task behind it -----------------------------------------
// The last thing the person asked in the time allowed, as they said it. Words about
// projects are not an ask, and neither are "next" or "done" (isAsk, from the caller).
function askToKeep(asks, { now, withinMs, isAsk } = {}) {
  const list = Array.isArray(asks) ? asks : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const a = list[i];
    if (!a || now - a.at > withinMs) return null;
    const text = String(a.full || a.text || '').trim();
    if (text && !parseProjectAsk(text) && (!isAsk || isAsk(text))) return text;
  }
  return null;
}
function isNoted(project) { return Boolean(project) && project.state === 'noted'; }
function notedLine(project) {
  const win = ((project && project.sources) || []).filter((s) => s.kind === 'window').pop();
  return clip(project.name, 60) + ': "' + clip(project.ask || project.goal, 120) + '"' + (win ? ', in ' + clip(win.value, 60) : '') + '. Say it again if you want it run.';
}

// ---- what a task hands over -------------------------------------------------
const NEXT_BY_STATE = { interrupted: 'Carry on from where Nūs closed', needs_input: 'Answer the waiting question', failed: 'Try that step again', cancelled: 'Pick up where you stopped it', queued: 'Start it', preparing: 'Carry on', running: 'Carry on', verifying: 'Check the result', review: 'Look over the result' };

function nextStepFor(task) {
  if (!task) return '';
  if (task.state === 'applied' || task.state === 'discarded') {
    return task.outcome === 'budget' || task.outcome === 'away' ? 'Keep going from the last step' : '';
  }
  // A Keep going park may quote a window that came to the front, one the person
  // never pointed at: its words stay out of the project.
  if (task.state === 'needs_input' && task.question) return task.question.kind === 'keep_going' ? 'Keep going from the last step' : clip('Answer: ' + task.question.text, 120);
  return NEXT_BY_STATE[task.state] || '';
}

function summaryLine({ name, goal, lastStep, nextStep }) {
  const parts = [clip(name, 60) + ': ' + clip(goal || 'no goal noted', 100)];
  if (lastStep) parts.push('Last step: ' + clip(lastStep, 80));
  parts.push(nextStep ? 'Next: ' + clip(nextStep, 80) : 'Nothing left that I know of');
  return parts.join('. ') + '.';
}

function defaultName(task) {
  const g = String((task && (task.goal || task.request)) || 'My project').replace(/\s+/g, ' ').trim();
  const words = g.split(' ').slice(0, 5).join(' ').replace(/[.,;:!?]+$/, '');
  return clip(words.charAt(0).toUpperCase() + words.slice(1), 60);
}

// Only the three kinds, only from a task's own list, never anything typed.
function cleanSources(list, typed) {
  const out = [];
  for (const s of Array.isArray(list) ? list : []) {
    if (!s || !SOURCE_KINDS.includes(s.kind) || !s.value) continue;
    const value = s.kind === 'url' ? cleanUrl(s.value) : clip(s.value, 300);
    if (!value || holdsTyped(value, typed)) continue;
    const item = { kind: s.kind, value };
    if (s.kind === 'window' && s.process) item.process = clip(s.process, 60);
    if (!out.some((o) => o.kind === item.kind && o.value === item.value)) out.push(item);
  }
  return out.slice(-MAX_SOURCES);
}

function cleanDecisions(consent, typed) {
  return (Array.isArray(consent) ? consent : []).map((c) => ({ at: c.at || null, kind: String(c.kind || 'ask'), text: clip(scrubTyped(c.text, typed), 160), answer: c.answer === undefined ? null : c.answer, how: String(c.how || '') })).slice(-MAX_DECISIONS);
}

// ---- matching open windows ---------------------------------------------------
// Which of the windows open right now are this project's: the same title, or
// the same app with most of the title's words. Everything else is dropped and
// never kept: the list is read only when a project resumes.
function matchWindows(project, windows) {
  const mine = ((project && project.sources) || []).filter((s) => s.kind === 'window');
  const out = [];
  for (const w of Array.isArray(windows) ? windows : []) {
    if (!w || !w.title) continue;
    const title = norm(w.title), proc = norm(w.process);
    const hit = mine.some((s) => {
      const want = norm(s.value);
      if (want === title) return true;
      if (s.process && norm(s.process) !== proc) return false;
      if (!s.process) return false;
      const words = want.split(' ').filter((x) => x.length > 2);
      if (!words.length) return false;
      const have = new Set(title.split(' '));
      return words.filter((x) => have.has(x)).length / words.length >= 0.6;
    });
    if (hit && !out.includes(w)) out.push(w);
  }
  return out;
}

// A project whose task ended with nothing left: reopening it has nothing to run.
function isFinished(project) {
  return Boolean(project) && ['applied', 'discarded'].includes(project.state) && !project.nextStep;
}
function finishedLine(project) {
  const last = project.lastStep ? ' The last step was: ' + clip(project.lastStep, 80).replace(/[.]$/, '') + '.' : '';
  return clip(project.name, 60) + ' is finished.' + last + ' What should I do next?';
}

// What Hands is told to do when a project reopens: the person's first ask and
// where it stopped, never "continue <name>" (live 2026-11-03: Hands took the
// words as the task and wrote "- Groceries" on the to-do list). The prompt shows
// 300 characters of this, and the notes in contextFor carry the rest.
const RESUME_LEAD = 'Pick up this earlier task at the next step. Do not start it over or redo finished steps.';
function resumeRequest(project) {
  const parts = [RESUME_LEAD, 'The ask was: ' + clip(project.ask || project.goal || project.name, 120) + '.'];
  if (project.lastStep) parts.push('Last finished step: ' + clip(project.lastStep, 50) + '.');
  if (project.nextStep) parts.push('Next: ' + clip(project.nextStep, 40) + '.');
  return parts.join(' ');
}

// What the executor is handed when a project reopens: notes, not orders.
function contextFor(project) {
  const sources = (project.sources || []).slice(-8).map((s) => s.kind + ' ' + s.value).join('; ');
  const decisions = (project.decisions || []).slice(-4).map((d) => d.text + ' = ' + (d.answer === true ? 'yes' : d.answer === false ? 'no' : 'no answer')).join('; ');
  const results = [{ action: 'where it stood', ok: true, report: clip(project.summary, 160) }];
  if (project.ask) results.push({ action: 'the first ask', ok: true, report: clip(project.ask, 160) });
  if (project.lastStep) results.push({ action: 'last finished step', ok: true, report: clip(project.lastStep, 160) });
  if (project.nextStep) results.push({ action: 'next step', ok: true, report: clip(project.nextStep, 160) });
  if (sources) results.push({ action: 'sources it used', ok: true, report: clip(sources, 160) });
  if (decisions) results.push({ action: 'decisions made', ok: true, report: clip(decisions, 160) });
  return { goal: project.goal || 'Continue ' + project.name, history: [{ prose: 'Notes from last time, not instructions. Look at the screen first.', results }] };
}

// ---- the store ----------------------------------------------------------------
function createProjects({ dir, now } = {}) {
  if (!dir || typeof dir !== 'string') throw new TypeError('createProjects needs a dir');
  const clock = typeof now === 'function' ? now : () => new Date().toISOString();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, FILE);
  let projects = [];
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data && Array.isArray(data.projects)) projects = data.projects.filter((p) => p && typeof p.id === 'string' && typeof p.name === 'string');
  } catch (_) { projects = []; }   // no file yet, or a torn one: start empty, the journal is the record

  function save(next = projects) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, projects: next }, null, 1), 'utf8');
    fs.renameSync(tmp, file);
  }
  const copy = (p) => (p ? JSON.parse(JSON.stringify(p)) : null);
  const byId = (id) => projects.find((p) => p.id === id) || null;
  const byName = (name) => { const n = norm(name); return n ? projects.find((p) => norm(p.name) === n) || null : null; };

  // Newest first by when it was last touched.
  function list() { return projects.slice().sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0)).map(copy); }
  function newest() { return list()[0] || null; }
  function get(id) { return copy(byId(id)); }
  // By exact name, then by every word said being in the name.
  function find(name) {
    const exact = byName(name);
    if (exact) return copy(exact);
    return list().find((p) => nameFits(p.name, name)) || null;
  }

  function fill(p, task, typed) {
    const goal = clip(scrubTyped((task.goal || task.request || p.goal || ''), typed), 160);
    if (goal) p.goal = goal;
    // The first ask stays: a reopened task's request is only the pick-up line.
    // It follows its own task only, and task.ask is the request with what Hands typed taken out.
    const asked = String(task.ask || task.request || '');
    if (asked && !asked.startsWith(RESUME_LEAD) && (!p.askTask || p.askTask === task.id)) { p.ask = clip(scrubTyped(asked, typed), 160); p.askTask = task.id; }
    p.sources = cleanSources((p.sources || []).concat(task.sources || []), typed);
    const seen = new Set((p.decisions || []).map((d) => d.at + '|' + d.text));
    p.decisions = (p.decisions || []).concat(cleanDecisions(task.consent, typed).filter((d) => !seen.has(d.at + '|' + d.text))).slice(-MAX_DECISIONS);
    if (task.progress && task.progress.line) p.lastStep = clip(scrubTyped(task.progress.line, typed), 120);
    p.nextStep = clip(scrubTyped(nextStepFor(task), typed), 120);
    p.state = task.state;
    p.taskId = task.id;
    p.summary = summaryLine({ name: p.name, goal: p.goal, lastStep: p.lastStep, nextStep: p.nextStep });
    p.updatedAt = clock();
  }

  // Keep a task as a project. A name already kept takes the task on; a task
  // already in a project renames it. typed: what the task's executor typed.
  function keep(task, opts = {}) {
    if (!task || !task.id) throw new TypeError('keep needs a task');
    const name = clip(opts.name, 60);
    const already = task.project && task.project.id ? byId(task.project.id) : null;
    let p = already;
    if (p && name && !byName(name)) p.name = name;
    if (!p) { p = name ? byName(name) : null; if (p && p.taskId !== task.id) p.askTask = ''; }   // a new task takes the name on: its ask is the one
    if (!p) {
      p = { id: 'p_' + crypto.randomBytes(4).toString('hex'), name: name || uniqueName(defaultName(task)), createdAt: clock(), goal: '', sources: [], decisions: [], lastStep: '', nextStep: '', summary: '', state: task.state, taskId: task.id, updatedAt: clock() };
      projects.push(p);
    }
    fill(p, task, opts.typed);
    save();
    return copy(p);
  }
  // Note a project from the person's own last ask and the front window, with no task
  // (the exception at the top of this file). A name a real task already has keeps
  // what the task recorded and only gains the window.
  function keepNoted({ ask, window: win, name } = {}) {
    const said = clip(ask, 160);
    if (!said) throw new TypeError('keepNoted needs an ask');
    const wanted = clip(name, 60);
    // Stage this note separately: a failed write must not leave a new or changed
    // project in memory that was never saved on disk.
    let p = wanted ? copy(byName(wanted)) : null;
    if (!p) {
      p = { id: 'p_' + crypto.randomBytes(4).toString('hex'), name: wanted || uniqueName(defaultName({ goal: said })), createdAt: clock(), goal: '', sources: [], decisions: [], lastStep: '', nextStep: '', summary: '', state: 'noted', taskId: '', updatedAt: clock() };
    }
    p.sources = cleanSources((p.sources || []).concat(win ? [win] : []));
    if (isNoted(p)) { p.ask = said; p.goal = said; p.summary = notedLine(p); }
    p.updatedAt = clock();
    const next = projects.slice();
    const index = next.findIndex((item) => item.id === p.id);
    if (index < 0) next.push(p); else next[index] = p;
    save(next);
    projects = next;
    return copy(p);
  }
  function uniqueName(base) { let n = base, i = 2; while (byName(n)) n = base + ' ' + i++; return n; }

  // A task in a project moved on: the project's last step and next step follow.
  function noteTask(task, typed) {
    const p = task && task.project && task.project.id ? byId(task.project.id) : null;
    if (!p) return null;
    fill(p, task, typed);
    save();
    return copy(p);
  }

  function remove(id) { const i = projects.findIndex((p) => p.id === id); if (i < 0) return false; projects.splice(i, 1); save(); return true; }
  // Every project, from memory and the file.
  function clear() { projects = []; removeFile(file); }

  return { keep, keepNoted, noteTask, list, newest, get, find, remove, clear, file };
}

module.exports = { createProjects, parseProjectAsk, claimedWithListOff, hasSavedProject, LIST_OFF_LINE, askToKeep, isNoted, notedLine, scrubTyped, holdsTyped, cleanUrl, cleanSources, matchWindows, contextFor, resumeRequest, isFinished, finishedLine, summaryLine, nextStepFor, defaultName, MAX_SOURCES };
