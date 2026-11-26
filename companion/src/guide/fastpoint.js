// The quick pointer: Jev (System One) picks the next control from the list
// Windows gave us, in a couple of hundred ms, while the thinking model is still
// reading the screenshot. It never replaces the model: the model runs every
// time on the same inputs and its answer always wins. This only decides whether
// the thread may go out early.
//
// Jev cannot see the screen. Its two ways of being badly wrong are "the goal is
// already finished" and "this is not the app the goal needs", so both are asked
// in the same call and either one stops the quick point. Irreversible and
// sensitive controls are never quick-pointed: those wait for the model.
//
// Modes (NUS_GUIDE_FASTPOINT): '0' off, 'shadow' compute and log only, '1' live.
'use strict';

const jevDefault = require('../reflex/jev');

const MAX_OPTIONS = 200;                 // Jev takes 255; leave room
const NAME_CLIP = 40;
const DEADLINE_MS = 900;                 // systemOne retries once on a timeout; this is the hard cap
// Only control kinds whose names are UI labels. List items, tree items and
// links carry file names, mail subjects and page text: those stay on this machine.
const SENT_TYPES = new Set(['Button', 'TabItem', 'MenuItem', 'SplitButton', 'ComboBox', 'CheckBox', 'RadioButton', 'Edit']);
const IRREVERSIBLE = /\b(submit|pay|send|delete|purchase|buy|order|post|publish|confirm|remove|uninstall|erase|discard|sign|transfer|checkout|check out|reset|format|empty)\b/i;
const SENSITIVE = /pass(word|code|phrase)|\bpin\b|card ?(number|no)|\bcvv\b|\bcvc\b|\bssn\b|social security|security code|routing|account number/i;

// plannedConfidence: the bar when Jev's pick is the very control the model
// itself predicted for this step one reply ago (two sources agreeing).
const THRESHOLDS = { confidence: 0.85, margin: 0.35, finishedMax: 0.3, rightAppMin: 0.6, plannedConfidence: 0.6, plannedOverlap: 0.8 };

function tokens(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter((t) => t.length > 1); }
function overlap(a, b) {
  const ta = new Set(tokens(a)), tb = new Set(tokens(b));
  if (!ta.size || !tb.size) return 0;
  const [small, big] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  let hit = 0;
  for (const t of small) if (big.has(t)) hit++;
  return hit / small.size;
}

// The option the model's plan named, only when exactly one control matches it.
function plannedKey(planned, options, minOverlap) {
  const want = planned && planned.control;
  if (!want) return null;
  const hits = [];
  for (const [key, e] of options) if (overlap(e.name, want) >= minOverlap) hits.push(key);
  return hits.length === 1 ? hits[0] : null;
}

function clip(s, n) { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

// 'top left', 'middle', 'bottom right' from a normalized [x,y,w,h] box.
function where(box) {
  if (!Array.isArray(box) || box.length < 4) return '';
  const cx = box[0] + box[2] / 2, cy = box[1] + box[3] / 2;
  const v = cy < 0.34 ? 'top' : cy > 0.66 ? 'bottom' : 'middle';
  const h = cx < 0.34 ? 'left' : cx > 0.66 ? 'right' : 'centre';
  return v === 'middle' && h === 'centre' ? 'middle' : v + ' ' + h;
}

function candidates(elements) {
  return (elements || []).filter((e) => e && e.rect && SENT_TYPES.has(e.type) && String(e.name || '').trim().length > 0).slice(0, MAX_OPTIONS);
}

// -> { state, questions, options } ; options maps 'e<id>' back to the element.
function buildControlQuestions({ task, window, steps, planned, elements }) {
  const options = new Map();
  const criteria = { none: 'No listed control is clearly the next click' };
  for (const e of candidates(elements)) {
    const key = 'e' + e.id;
    options.set(key, e);
    const pos = where(e.box);
    criteria[key] = e.type + ' ' + JSON.stringify(clip(e.name, NAME_CLIP)) + (pos ? ', ' + pos : '');
  }
  const state = {
    goal: clip(task, 300),
    app: { window: clip(window && window.title, 80), process: clip(window && window.process, 40) },
    steps_done: (steps || []).map((s) => clip(s.instruction || s.name, 80)),
    planned_next: clip(planned ? [planned.instruction, planned.control].filter(Boolean).join(' / ') : '', 120),
  };
  const questions = {
    control: jevDefault.choice(
      'A person wants to do `goal` in the application in `app`. `steps_done` lists what they already clicked, in order. `planned_next`, when not empty, is what was expected next. Each option is one control visible in the window right now: its type, its name, and where it sits. Which ONE control should they click next to make progress on `goal`? Choose `none` if no listed control is clearly the next click, if the goal is already finished, if the right control is probably not in this list, or if `app` is not the application the goal needs.',
      criteria),
    finished: jevDefault.noul('Given `steps_done`, `goal` has already been fully achieved and nothing more needs clicking.'),
    right_app: jevDefault.noul('`app` is the application in which `goal` is carried out.'),
  };
  return { state, questions, options };
}

// The second-best option's weight, when Jev returns the distribution.
function marginOf(answer) {
  const probs = answer && answer.probabilities;
  if (!probs || typeof probs !== 'object') return null;
  const top = Number(probs[answer.choice]);
  let second = 0;
  for (const k of Object.keys(probs)) if (k !== answer.choice && Number(probs[k]) > second) second = Number(probs[k]);
  return Number.isFinite(top) ? top - second : null;
}

// Pure: Jev's answers + the list -> { accept, reason, element, confidence, margin, finished, rightApp }.
function gate(answers, options, elements, thresholds, planned) {
  const th = Object.assign({}, THRESHOLDS, thresholds || {});
  const a = (answers && answers.control) || {};
  const out = { accept: false, reason: '', element: null, key: a.choice || 'none', confidence: Number(a.confidence || 0), margin: marginOf(a), finished: null, rightApp: null };
  if (answers && answers.finished && typeof answers.finished.noul === 'number') out.finished = answers.finished.noul;
  if (answers && answers.right_app && typeof answers.right_app.noul === 'number') out.rightApp = answers.right_app.noul;
  if (!a.choice || a.choice === 'none') { out.reason = 'none'; return out; }
  const el = options.get(a.choice);
  if (!el) { out.reason = 'unknown option'; return out; }
  out.element = el;
  out.planned = plannedKey(planned, options, th.plannedOverlap) === a.choice;
  if (out.confidence < (out.planned ? th.plannedConfidence : th.confidence)) { out.reason = 'confidence'; return out; }
  if (!out.planned && out.margin != null && out.margin < th.margin) { out.reason = 'margin'; return out; }
  if (out.finished != null && out.finished > th.finishedMax) { out.reason = 'maybe finished'; return out; }
  if (out.rightApp != null && out.rightApp < th.rightAppMin) { out.reason = 'maybe wrong app'; return out; }
  const twins = (elements || []).filter((e) => e.type === el.type && String(e.name || '').trim().toLowerCase() === String(el.name || '').trim().toLowerCase());
  if (twins.length > 1) { out.reason = 'duplicate name'; return out; }
  if (IRREVERSIBLE.test(el.name || '')) { out.reason = 'irreversible'; return out; }
  if (SENSITIVE.test((el.name || '') + ' ' + (el.automationId || ''))) { out.reason = 'sensitive'; return out; }
  out.accept = true;
  out.reason = 'ok';
  return out;
}

// Jev writes nothing, so the quick bubble's words are a template. The model's
// own sentence replaces it the moment it confirms.
function templateInstruction(el) {
  const name = clip(el && el.name, 48);
  if (!name) return 'Click here.';
  if (el.type === 'Edit') return 'Click the "' + name + '" box.';
  if (el.type === 'TabItem') return 'Open the "' + name + '" tab.';
  if (el.type === 'MenuItem') return 'Open "' + name + '".';
  if (el.type === 'CheckBox') return 'Tick "' + name + '".';
  if (el.type === 'RadioButton') return 'Choose "' + name + '".';
  if (el.type === 'ComboBox') return 'Open the "' + name + '" list.';
  return 'Click "' + name + '".';
}

function modeFromEnv(v) {
  const m = String(v == null ? '' : v).trim().toLowerCase();
  return m === '1' || m === 'on' || m === 'live' ? '1' : m === 'shadow' ? 'shadow' : '0';
}

// heuristic: with no classifier service, a task that names a control by its
// words ("click the Insert tab") can still pick it (src/guide/chooser.js). The
// same gate applies, so only a clear, unambiguous name match goes out early.
function createFastPointer({ jev, mode, log, thresholds, deadlineMs, heuristic = true } = {}) {
  const client = jev || jevDefault;
  const say = log || (() => {});
  const budget = deadlineMs || DEADLINE_MS;

  function currentMode() { return client.ready() || heuristic ? modeFromEnv(typeof mode === 'function' ? mode() : mode) : '0'; }

  // Never throws. -> gate() result plus { ms, options } ; accept:false on any failure.
  async function pick(input) {
    const t0 = Date.now();
    const { state, questions, options } = buildControlQuestions(input);
    const base = { accept: false, element: null, key: 'none', confidence: 0, margin: null, finished: null, rightApp: null, options: options.size };
    if (!options.size) return Object.assign(base, { reason: 'no named controls', ms: 0 });
    if (!client.ready()) {
      if (!heuristic) return Object.assign(base, { reason: 'jev unavailable', ms: 0 });
      const { heuristicAnswers } = require('./chooser');
      const answers = heuristicAnswers({ task: input.task, planned: input.planned, options });
      return Object.assign(gate(answers, options, input.elements, thresholds, input.planned), { ms: Date.now() - t0, options: options.size, provider: 'words' });
    }
    let timer;
    const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve(null), budget); if (timer.unref) timer.unref(); });
    let res = null;
    try {
      res = await Promise.race([client.systemOne({ state, questions, timeoutMs: budget }).catch((e) => { say('fast: jev failed: ' + e.message); return null; }), deadline]);
    } finally { clearTimeout(timer); }
    const ms = Date.now() - t0;
    if (!res) return Object.assign(base, { reason: 'jev unavailable', ms });
    return Object.assign(gate(res.answers, options, input.elements, thresholds, input.planned), { ms: res.ms || ms, options: options.size });
  }

  return { mode: currentMode, pick };
}

module.exports = { createFastPointer, buildControlQuestions, gate, plannedKey, templateInstruction, marginOf, modeFromEnv, candidates, THRESHOLDS, SENT_TYPES, IRREVERSIBLE, SENSITIVE, MAX_OPTIONS, DEADLINE_MS };
