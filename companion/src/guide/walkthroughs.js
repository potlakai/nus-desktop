// Learn once, replay: a guide session the user chose to keep is saved as a
// walkthrough keyed by app and task. Next time the same ask arrives in the
// same app, the steps are resolved by control name through UI Automation,
// with no screenshot and no model call. A miss drops that step to the live
// loop (with the saved step as a hint); two misses across runs mark the
// walkthrough stale so it stops being offered.
//
// Local JSON only (<userData>/companion-walkthroughs.json), bounded, never
// sent anywhere. Saving happens on Keep, not on completion: Skip forgets.
'use strict';

const fs = require('fs');
const path = require('path');
const { tokenOverlap } = require('./verify');

const MAX_ENTRIES = 80;
// A near match replays with no model call, so it has to be near: the words
// that carry the task (after "how do i", "the", "my"...) must agree three
// quarters. "insert a table" and "insert a chart" used to match at 0.75 with
// the filler counted; now they share one word in two and do not.
const MATCH_MIN = 0.75;
const BROWSERS = new Set(['chrome', 'msedge', 'firefox', 'brave', 'opera', 'arc', 'vivaldi']);
const FILLER = new Set(['how', 'do', 'does', 'can', 'could', 'would', 'should', 'i', 'you', 'we', 'me', 'my', 'the', 'a', 'an', 'to', 'in', 'on', 'at', 'of', 'for', 'with', 'this', 'that', 'it', 'please', 'help', 'show', 'where', 'is', 'are', 'want', 'need', 'like', 'and', 'then', 'into', 'from', 'up', 'now']);

function taskTerms(s) {
  return new Set(String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter((t) => t.length > 1 && !FILLER.has(t)));
}

// Fraction of the asked task's meaningful words found in the saved one.
function taskOverlap(saved, asked) {
  const a = taskTerms(asked), b = taskTerms(saved);
  if (!a.size || !b.size) return 0;
  let hit = 0;
  for (const t of a) if (b.has(t)) hit++;
  return hit / Math.max(a.size, b.size);
}

function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

function keyFor(process, task) {
  return String(process || '').toLowerCase() + '::' + slug(task);
}

function createWalkthroughs(opts = {}) {
  const file = opts.file || null;
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  let data = load();

  function load() {
    if (!file) return { schema_version: 1, walkthroughs: [] };
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && parsed.schema_version === 1 && Array.isArray(parsed.walkthroughs)) return parsed;
    } catch (_) { /* first run, or unreadable: start clean */ }
    return { schema_version: 1, walkthroughs: [] };
  }

  function save() {
    if (!file) return;
    if (data.walkthroughs.length > MAX_ENTRIES) {
      data.walkthroughs.sort((a, b) => (b.lastOk || 0) - (a.lastOk || 0));
      data.walkthroughs.length = MAX_ENTRIES;
    }
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      fs.renameSync(tmp, file);
    } catch (e) { log('save failed: ' + e.message); }
  }

  function get(key) { return data.walkthroughs.find((w) => w.key === key) || null; }

  // rec: { task, app:{process,title}, steps:[{instruction,name,type,automationId,boxNorm}] }
  function record(rec) {
    if (!rec || !rec.app || !rec.app.process || !rec.task) return null;
    const steps = (rec.steps || []).filter((st) => st && st.name).map((st) => ({
      instruction: String(st.instruction || ''),
      target: { name: String(st.name), type: String(st.type || ''), automationId: String(st.automationId || ''), boxNorm: st.boxNorm || null },
    }));
    if (!steps.length) return null;
    const key = keyFor(rec.app.process, rec.task);
    let entry = get(key);
    if (entry) {
      entry.steps = steps;
      entry.runs = (entry.runs || 0) + 1;
      entry.lastOk = now();
      entry.stale = false;
      entry.misses = 0;
      entry.app.title = rec.app.title || entry.app.title || '';
    } else {
      entry = { key, task: String(rec.task), app: { process: String(rec.app.process).toLowerCase(), title: rec.app.title || '' }, steps, runs: 1, misses: 0, stale: false, createdAt: now(), lastOk: now() };
      data.walkthroughs.push(entry);
    }
    save();
    return entry;
  }

  // The best non-stale walkthrough for this app and ask, or null.
  function find({ process, title, task }) {
    const proc = String(process || '').toLowerCase();
    if (!proc || !task) return null;
    const exact = get(keyFor(proc, task));
    if (exact && !exact.stale) return exact;
    let best = null, bestScore = 0;
    for (const w of data.walkthroughs) {
      if (w.stale || w.app.process !== proc) continue;
      let score = taskOverlap(w.task, task);
      // In a browser the process says nothing about the site: the tab title has to agree too.
      if (BROWSERS.has(proc) && title && w.app.title && tokenOverlap(w.app.title, title) < 0.5) score *= 0.5;
      if (score > bestScore) { best = w; bestScore = score; }
    }
    return bestScore >= MATCH_MIN ? best : null;
  }

  // A step could not be resolved by name. Two such misses retire the entry.
  function miss(key) {
    const entry = get(key);
    if (!entry) return false;
    entry.misses = (entry.misses || 0) + 1;
    if (entry.misses >= 2) entry.stale = true;
    save();
    return entry.stale;
  }

  function markStale(key) { const e = get(key); if (e) { e.stale = true; save(); } }
  function forget(key) { const n = data.walkthroughs.length; data.walkthroughs = data.walkthroughs.filter((w) => w.key !== key); if (data.walkthroughs.length !== n) save(); }
  function list() { return data.walkthroughs.map((w) => ({ key: w.key, task: w.task, app: w.app, steps: w.steps.length, runs: w.runs, stale: !!w.stale, lastOk: w.lastOk })); }
  function forApp(process) { const proc = String(process || '').toLowerCase(); return data.walkthroughs.filter((w) => !w.stale && w.app.process === proc); }

  return { record, find, miss, markStale, forget, list, forApp, get, keyFor, file };
}

module.exports = { createWalkthroughs, keyFor, slug, taskOverlap, MATCH_MIN };
