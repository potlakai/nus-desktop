'use strict';
const jev = require('../reflex/jev');
function createWarm({ client = jev, now = Date.now } = {}) {
  let last = -Infinity, running = false;
  return function warm() {
    if (!client.ready() || running || now() - last < 3000) return;
    last = now(); running = true;
    Promise.resolve().then(() => client.systemOne({ state: { utterance: 'hello' }, questions: { warm: jev.noul('The utterance is a greeting.') }, timeoutMs: 1000, retries: 0 })).catch(() => {}).finally(() => { running = false; });
  };
}
function words(s) { return String(s || '').toLowerCase().match(/[a-z]+|\d+(?:\.\d+)?|[+\-*/^=<>]/g) || []; }
function criticalTokens(s) { return words(s).filter(t => /\d|[+\-*/^=<>]/.test(t)); }
function critical(s) { return criticalTokens(s).join('|'); }
// Numbers and operators on the first read that are gone from the second, counted
// with repeats (a WeBWorK sidebar lists every problem number, so a set would hide
// the old problem's numbers). Typing an answer only adds; a new problem removes.
function criticalRemoved(before, after) {
  const left = new Map();
  for (const t of criticalTokens(after)) left.set(t, (left.get(t) || 0) + 1);
  let removed = 0;
  for (const t of criticalTokens(before)) { const n = left.get(t) || 0; if (n) left.set(t, n - 1); else removed++; }
  return removed;
}
function cacheSimilarity(a, b) {
  if (!a || !b || critical(a) !== critical(b)) return 0;
  const aa = new Set(words(a)), bb = new Set(words(b));
  let intersection = 0; for (const t of aa) if (bb.has(t)) intersection++;
  return intersection / Math.max(aa.size, bb.size, 1);
}
// A page that looks like homework, from its words alone (no Jev). Both lists
// take plurals and verb forms: on 2026-10-12 "Which of the following integrals
// represents the length of the curve" plus "Submit Answers" matched neither
// "integral" nor "answer", so the Companion never asked the model (DHW 7, P1).
const HOMEWORK_NOUN = /\b(homework|assignments?|quiz|quizzes|exercises?|problems?|questions?|worksheet|webwork)\b/i;
const HOMEWORK_ASK = /\b(evaluate|calculate|compute|solve|find|determine|prove|show|integrals?|integrate|differentiate|derivatives?|select|choose|answers?|explain|express|enter|estimate|approximate|simplify|sketch|converges?|diverges?|series|sequence|limit|sum|which of the following|represents?|true|false)\b/i;
function homeworkText(text) {
  const t = String(text || '');
  return t.length >= 30 && HOMEWORK_NOUN.test(t) && HOMEWORK_ASK.test(t);
}
module.exports = { createWarm, cacheSimilarity, homeworkText, critical, criticalRemoved };
