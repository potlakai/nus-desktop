'use strict';
// One line per model request, on this machine only: what feature asked,
// which brain and model answered, how it ended, how long each stage took,
// and what it would have cost at API prices. The Home window sums it up;
// the bench reads it back. Nothing here leaves the device.
//
// Timings are the stages a person feels: looked (screen read), first_token,
// first_speech, first_point, model_done, spoken. Any of them may be absent.
// ack: ms from the end of the person's words to the Knot's short
// acknowledgement ("On it.") going to its voice, when one was said.
// first_sound: ms from the talk key coming up to the neutral "Mm." going
// to its voice, when one was said (it comes before the ack).
//
// Rows with feature 'task' are not model requests: each is one run of a task
// (src/tasks/supervisor.js) with timings.first_progress, timings.cancel and
// timings.queued, for the bench. Home's counts and the Activity list skip them,
// because the requests that run made have their own rows.
const fs = require('fs');
const path = require('path');

// USD per million tokens (input, output). Used only when the brain reports
// token counts without a cost of its own.
const PRICES = {
  'claude-opus-5-5': [15, 75], 'claude-sonnet-5': [3, 15], 'claude-haiku-5-5': [1, 5],
  'claude-sonnet-4-5': [3, 15], 'claude-haiku-4-5': [1, 5],
  'gemini-3.6-flash': [0.3, 2.5], 'gemini-3.6-pro': [2, 12], 'gemini-flash-latest': [0.3, 2.5],
  'gpt-5': [1.25, 10], 'gpt-5-mini': [0.25, 2],
};
const MAX_LINES = 5000;
const TASK_FEATURE = 'task';

function textTokens(text) { return Math.ceil(String(text || '').length / 4); }
// Anthropic's image formula: width x height / 750, capped where the model resizes.
function imageTokens(width, height) { return Math.min(1600, Math.ceil((Number(width) || 0) * (Number(height) || 0) / 750)); }

function priceFor(model) {
  const key = Object.keys(PRICES).find((k) => String(model || '').toLowerCase().startsWith(k));
  return key ? PRICES[key] : null;
}

function estimateCost(model, usage) {
  const p = priceFor(model);
  if (!p || !usage) return null;
  const input = Number(usage.input_tokens || 0) + Number(usage.cache_read_input_tokens || 0) * 0.1 + Number(usage.cache_creation_input_tokens || 0) * 1.25;
  const output = Number(usage.output_tokens || 0);
  return Math.round((input * p[0] + output * p[1]) / 1e6 * 1e6) / 1e6;
}

function createLedger({ file, now = () => Date.now(), log = () => {} } = {}) {
  let lines = 0;

  // rec: { feature, provider, model, outcome, ms, timings:{}, usage:{}, costUsd, warm, note }
  function record(rec) {
    if (!file || !rec) return null;
    const row = {
      at: new Date(now()).toISOString(),
      feature: String(rec.feature || ''),
      provider: String(rec.provider || ''),
      model: String(rec.model || ''),
      outcome: String(rec.outcome || 'ok'),
      ms: Number(rec.ms) || 0,
      timings: rec.timings && typeof rec.timings === 'object' ? rec.timings : {},
      usage: rec.usage && typeof rec.usage === 'object' ? rec.usage : null,
      costUsd: rec.costUsd != null ? Number(rec.costUsd) : estimateCost(rec.model, rec.usage),
      warm: rec.warm === true,
      note: String(rec.note || '').slice(0, 200),
    };
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, JSON.stringify(row) + '\n');
      lines++;
      if (lines % 500 === 0) trim();
    } catch (e) { log('ledger write failed: ' + e.message); }
    return row;
  }

  function read() {
    try { return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean); }
    catch (_) { return []; }
  }

  function trim() {
    const rows = read();
    if (rows.length <= MAX_LINES) return;
    try { fs.writeFileSync(file, rows.slice(-MAX_LINES).map((r) => JSON.stringify(r)).join('\n') + '\n'); } catch (_) { /* best effort */ }
  }

  // Today's picture for the Home window: requests, failures, cost, median waits.
  function summary(days = 1) {
    const since = now() - days * 86400000;
    const rows = read().filter((r) => Date.parse(r.at) >= since && r.feature !== TASK_FEATURE);
    const byFeature = {};
    let cost = 0, failed = 0;
    const firstWords = [], totals = [];
    for (const r of rows) {
      byFeature[r.feature] = (byFeature[r.feature] || 0) + 1;
      if (r.outcome !== 'ok') failed++;
      if (typeof r.costUsd === 'number') cost += r.costUsd;
      if (r.timings && typeof r.timings.first_token === 'number') firstWords.push(r.timings.first_token);
      if (r.ms) totals.push(r.ms);
    }
    const median = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
    return { requests: rows.length, failed, costUsd: Math.round(cost * 1e4) / 1e4, byFeature, medianFirstTokenMs: median(firstWords), medianMs: median(totals) };
  }

  return { record, read, summary, file };
}

// The Activity view on the Home window: the last requests in plain words,
// newest first, and one line for today. rows are ledger rows (read()).
const FEATURE_LABELS = { reflex: 'Quick action', guide: 'Walkthrough', hands: 'Hands', answer: 'Answer', ask: 'Answer', solve: 'Homework help', rewrite: 'Rewrite', page: 'Read the page', file: 'File question' };
const OUTCOME_LABELS = { ok: 'Done', explain: 'Answered in words', 'step-failed': 'A step did not work', error: 'Failed', busy: 'Busy', stopped: 'Stopped' };
function providerLabel(provider) {
  const p = String(provider || '').toLowerCase();
  if (!p) return '';
  if (/claude \(desktop\)|claude code|cli/.test(p)) return 'Claude Code';
  if (/anthropic|claude/.test(p)) return 'Claude';
  if (/gemini|google/.test(p)) return 'Gemini';
  if (/openai|gpt/.test(p)) return 'OpenAI';
  return String(provider);
}
function clockLabel(d) { let h = d.getHours(); const m = d.getMinutes(); const pm = h >= 12; h = h % 12 || 12; return h + ':' + String(m).padStart(2, '0') + ' ' + (pm ? 'PM' : 'AM'); }
function dayStart(t) { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }
function waitLabel(ms) {
  const s = Math.round((Number(ms) || 0) / 1000);
  if (s < 60) return s + ' s';
  const m = Math.floor(s / 60), r = s % 60;
  return m + ' min' + (r ? ' ' + r + ' s' : '');
}
const okOutcome = (o) => o === 'ok' || o === 'explain';
function activityView(rows, { now = Date.now(), limit = 50 } = {}) {
  const list = (rows || []).filter((r) => r && r.at && r.feature !== TASK_FEATURE && Number.isFinite(Date.parse(r.at)));
  const today0 = dayStart(now), yesterday0 = dayStart(today0 - 1);
  const todays = list.filter((r) => Date.parse(r.at) >= today0);
  let failed = 0, ms = 0, cost = 0;
  for (const r of todays) { if (!okOutcome(r.outcome)) failed++; ms += Number(r.ms) || 0; if (typeof r.costUsd === 'number') cost += r.costUsd; }
  cost = Math.round(cost * 1e4) / 1e4;
  const line = todays.length
    ? 'Today: ' + todays.length + ' request' + (todays.length === 1 ? '' : 's') + (failed ? ', ' + failed + ' did not work' : '') + ', ' + waitLabel(ms) + ' of waiting in all' + (cost ? ', about $' + cost.toFixed(2) + ' at API prices' : '') + '.'
    : 'Nothing yet today.';
  const recent = list.slice(-limit).reverse().map((r) => {
    const t = Date.parse(r.at), d = new Date(t);
    const day = t >= today0 ? 'Today' : t >= yesterday0 ? 'Yesterday' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return {
      at: r.at,
      when: day + ', ' + clockLabel(d),
      feature: FEATURE_LABELS[r.feature] || (r.feature ? r.feature.charAt(0).toUpperCase() + r.feature.slice(1) : 'Request'),
      outcome: OUTCOME_LABELS[r.outcome] || (r.outcome ? String(r.outcome).replace(/-/g, ' ') : 'Done'),
      ok: okOutcome(r.outcome),
      seconds: r.ms ? ((Number(r.ms) || 0) / 1000).toFixed(1) + ' s' : '',
      model: r.model || providerLabel(r.provider),
      cost: typeof r.costUsd === 'number' && r.costUsd > 0 ? '$' + (r.costUsd < 0.01 ? r.costUsd.toFixed(4) : r.costUsd.toFixed(2)) : '',
      note: String(r.note || ''),
    };
  });
  return { today: { requests: todays.length, failed, ms, costUsd: cost, line }, rows: recent };
}

// What the bench reads back from task rows: the median and count of each timing.
function taskTimings(rows) {
  const task = (rows || []).filter((r) => r && r.feature === TASK_FEATURE);
  const stat = (key) => {
    const vals = task.map((r) => r.timings && r.timings[key]).filter((v) => typeof v === 'number').sort((a, b) => a - b);
    return { n: vals.length, medianMs: vals.length ? vals[Math.floor(vals.length / 2)] : null, maxMs: vals.length ? vals[vals.length - 1] : null };
  };
  return { runs: task.length, firstProgress: stat('first_progress'), cancel: stat('cancel'), queued: stat('queued') };
}

module.exports = { createLedger, estimateCost, textTokens, imageTokens, activityView, taskTimings, PRICES };
