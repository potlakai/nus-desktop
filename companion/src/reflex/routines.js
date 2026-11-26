// Saved routines: a run of reflex actions the person chose to keep, replayed
// later by voice ("run my routine"). Stored as plain JSON next to the other
// Companion settings. Only actions from the reflex registry can be in one, so
// a routine can never do anything a spoken command could not.
const fs = require('fs');

const REPLAYABLE = new Set(['open_app', 'open_site', 'web_search', 'type_text', 'new_item', 'new_tab', 'close_tab', 'next_tab', 'snap_left', 'snap_right', 'maximize', 'minimize']);
const MAX_ROUTINES = 20;
const MAX_STEPS = 8;

function toStep(d) {
  if (!d || !REPLAYABLE.has(d.intent)) return null;
  return { intent: d.intent, appKey: d.app ? d.app.key : null, appName: d.app ? d.app.name : null, url: d.url || null, text: d.text || null, label: d.label || d.intent };
}

function load(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(j.routines) ? j.routines : [];
  } catch (_) { return []; }
}

function save(file, steps, now) {
  const clean = (steps || []).filter(Boolean).slice(0, MAX_STEPS);
  if (!file || clean.length < 2) return null;
  const routines = load(file);
  const first = clean[0].appName || clean[0].label || 'routine';
  const routine = { name: first + ' routine', savedAt: new Date(now || Date.now()).toISOString(), steps: clean };
  routines.push(routine);
  fs.writeFileSync(file, JSON.stringify({ routines: routines.slice(-MAX_ROUTINES) }, null, 2), 'utf8');
  return routine;
}

function latest(file) {
  const all = load(file);
  return all.length ? all[all.length - 1] : null;
}

// A saved step back into a decision the executor understands. The app is
// looked up again in today's catalog: an uninstalled app is skipped, not guessed.
function toDecision(step, apps) {
  const d = { intent: step.intent, confidence: 1, ms: 0, final: true, label: step.label, url: step.url || undefined, text: step.text || undefined, replay: true };
  if (step.intent === 'open_app') {
    const app = (apps || []).find((a) => a.key === step.appKey) || (apps || []).find((a) => a.name === step.appName);
    if (!app) return null;
    d.app = app;
  }
  return d;
}

module.exports = { toStep, save, load, latest, toDecision, REPLAYABLE, MAX_STEPS };
