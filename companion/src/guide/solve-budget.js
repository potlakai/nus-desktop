'use strict';
// Assignment-mode spend guard for the person's OWN Anthropic key. Metered
// paths only: Claude Code (subscription) and Gemini (free tier) never reserve.
// The ledger is per day and resets at local midnight. The first shape was a
// lifetime cap that tripped for good after roughly 65 solves (2026-09-30).
const fs = require('fs');
const path = require('path');
const DAILY_ATTEMPTS = 60;
const DAILY_USD = 3;
function rates(model) { return /haiku/i.test(model) ? { input: 1, output: 5 } : { input: 2, output: 10 }; }
function cost(model, input, output) { const r = rates(model); return (input * r.input + output * r.output) / 1e6; }
function today(now = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return now.getFullYear() + '-' + p(now.getMonth() + 1) + '-' + p(now.getDate());
}
// A ledger from another day (or the old dayless shape) reads as empty.
function read(file, day = today()) {
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; data = null; }
  if (!data || data.day !== day || !Array.isArray(data.attempts)) return { day, attempts: [] };
  return data;
}
function write(file, data) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n'); }
function spentUsd(data) { return data.attempts.reduce((n, a) => n + (a.usd == null ? a.reservedUsd : a.usd), 0); }
function reserve(file, model, maxTokens, lane, opts = {}) {
  const day = opts.day || today();
  const data = read(file, day), reservedUsd = cost(model, 6000, maxTokens);
  if (data.attempts.length >= DAILY_ATTEMPTS || spentUsd(data) + reservedUsd > DAILY_USD) throw new Error('assignment spend limit reached for today');
  const id = data.attempts.length;
  data.attempts.push({ at: new Date().toISOString(), model, lane, reservedUsd, usd: null });
  write(file, data);
  return (usage) => {
    if (!usage || !Number.isFinite(usage.input_tokens) || !Number.isFinite(usage.output_tokens)) return;
    const current = read(file, day);
    if (!current.attempts[id]) return;
    current.attempts[id].usage = usage;
    current.attempts[id].usd = cost(model, usage.input_tokens, usage.output_tokens);
    write(file, current);
  };
}
// What Settings shows: today's count and dollars against the caps.
function summary(file, day = today()) {
  const data = read(file, day);
  return { day, attempts: data.attempts.length, usd: Math.round(spentUsd(data) * 100) / 100, capAttempts: DAILY_ATTEMPTS, capUsd: DAILY_USD };
}
module.exports = { reserve, read, cost, summary, today, DAILY_ATTEMPTS, DAILY_USD };
