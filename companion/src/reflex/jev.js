// Thin client for TypeSafe's System One endpoint (Jev). Text or JSON state in,
// typed decisions out: choice, score, noul. No SDK, no dependency: one fetch.
// The key comes from the environment or encrypted settings and is never logged.
const ENDPOINT = process.env.TYPESAFE_BASE_URL || 'https://api.typesafe.ai/v1/systemone';
const DEFAULT_MODEL = process.env.TYPESAFE_MODEL || 'jev-latest';

let configured = '';
function configure(o) { configured = String((o && o.apiKey) || '').trim(); }
function apiKey() { return String(process.env.TYPESAFE_API_KEY || '').trim() || configured; }
function keySource() { return String(process.env.TYPESAFE_API_KEY || '').trim() ? 'env' : configured ? 'settings' : 'none'; }
function ready() { return apiKey().length > 0; }

const choice = (instructions, criteria) => ({ type: 'choice', instructions, criteria });
const score = (instructions, criteria) => ({ type: 'score', instructions, criteria });
const noul = (instructions, criteria) => (criteria ? { type: 'noul', instructions, criteria } : { type: 'noul', instructions });

async function post(body, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey() },
      body: JSON.stringify(body),
      signal: ctl.signal
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { json = null; }
    if (!res.ok) {
      const msg = (json && (json.error && (json.error.message || json.error) || json.message)) || text.slice(0, 200);
      const err = new Error('jev ' + res.status + ': ' + String(msg).slice(0, 200));
      err.status = res.status;
      throw err;
    }
    return json || {};
  } finally {
    clearTimeout(timer);
  }
}

// One call, many questions. Returns { answers, ms, model }.
async function systemOne({ state, questions, model, timeoutMs, log, retries = 1 }) {
  if (!ready()) { const e = new Error('no TypeSafe key (env TYPESAFE_API_KEY or Settings)'); e.code = 'NO_KEY'; throw e; }
  const body = { model: model || DEFAULT_MODEL, state, questions };
  const budget = timeoutMs || 1500;
  const t0 = Date.now();
  let out;
  try {
    out = await post(body, budget);
  } catch (e) {
    // One retry for a dropped connection or a timeout; never for a 4xx.
    if (!retries || e && e.status && e.status < 500) throw e;
    const remaining = budget - (Date.now() - t0);
    if (remaining <= 0) throw e;
    out = await post(body, remaining);
  }
  const ms = Date.now() - t0;
  if (log) log('[jev] ' + ms + 'ms ' + Object.keys(questions).length + 'q');
  return { answers: out.answers || {}, ms, model: out.model || body.model, usage: out.usage || null };
}

module.exports = { configure, keySource, systemOne, choice, score, noul, ready, ENDPOINT, DEFAULT_MODEL };
