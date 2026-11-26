'use strict';
// Picking a control by words and distance, with no model and no service.
//
// Two places use it. The quick pointer: when the classifier service is not
// configured, a task that names a control ("click the Insert tab") can still
// send the thread out early. Reconcile: when the model gives a box with a
// label, the controls Windows reports around that box are scored and the
// clear winner's rectangle is used instead of the model's estimate.
//
// Score = 0.6 x word overlap + 0.25 x nearness + 0.15 x "the point is inside".
// Generic words (button, icon, menu...) do not count. A top score under the
// threshold, or two candidates within 0.05 of each other, means no pick: the
// caller keeps what it had. Pure functions.

const GENERIC = new Set(['the', 'a', 'an', 'button', 'icon', 'menu', 'item', 'field', 'link', 'tab', 'option', 'box', 'click', 'press', 'open', 'on', 'in', 'to', 'at']);
const RADIUS = 90;          // px around the model's point that counts as "near"
const THRESHOLD = 0.55;
const AMBIGUOUS = 0.05;
const MAX_AREA = 400 * 200; // bigger than this is a panel, not a control

function terms(text) {
  const out = new Set();
  for (const w of String(text || '').toLowerCase().match(/[a-z0-9]+/g) || []) {
    const t = w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w;
    if (!GENERIC.has(t) && t.length > 1) out.add(t);
  }
  return out;
}

function overlap(a, b) {
  const wanted = terms(a), have = terms(b);
  if (!wanted.size) return 0;
  let hit = 0;
  for (const t of wanted) if (have.has(t)) hit++;
  return hit / wanted.size;
}

function centre(rect) { return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }; }
function contains(rect, p) { return p.x >= rect.x && p.x <= rect.x + rect.w && p.y >= rect.y && p.y <= rect.y + rect.h; }

// 0..1: how likely `element` is what `label` means, given the model's point.
function score(label, point, element, radius = RADIUS) {
  const c = centre(element.rect);
  const distance = point ? Math.hypot(c.x - point.x, c.y - point.y) : radius;
  const nearness = Math.max(0, 1 - distance / radius);
  const inside = point && contains(element.rect, point) ? 1 : 0;
  return 0.6 * overlap(label, element.name) + 0.25 * nearness + 0.15 * inside;
}

// elements: [{ id?, name, type, rect:{x,y,w,h} }], point: { x, y } in the same
// pixels (or null when only the words matter).
// -> { element, score, margin } or null.
function chooseElement(label, point, elements, opts = {}) {
  const radius = opts.radius || RADIUS;
  const threshold = opts.threshold != null ? opts.threshold : THRESHOLD;
  const maxArea = opts.maxArea || MAX_AREA;
  const pool = (elements || []).filter((e) => e && e.rect && e.rect.w > 0 && e.rect.h > 0 && e.rect.w * e.rect.h <= maxArea);
  if (!pool.length || !String(label || '').trim()) return null;
  const scored = pool.map((e) => ({ element: e, score: score(label, point, e, radius) })).sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (best.score < threshold) return null;
  const margin = scored.length > 1 ? best.score - scored[1].score : best.score;
  if (scored.length > 1 && margin < AMBIGUOUS) return null;
  return { element: best.element, score: best.score, margin };
}

// The quick pointer's answers, in the shape the gate reads, worked out from
// the words of the task (and the planned control, when there is one).
function heuristicAnswers({ task, planned, options }) {
  const wanted = [planned && planned.control, task].filter(Boolean).join(' ');
  const probabilities = {};
  let total = 0;
  for (const [key, e] of options) {
    const s = overlap(wanted, e.name);
    const v = s >= 0.5 ? s : 0;          // half the words or nothing
    probabilities[key] = v; total += v;
  }
  if (!total) return { control: { choice: 'none', confidence: 1, probabilities: { none: 1 } }, finished: { noul: 0 }, right_app: { noul: 1 } };
  let best = null;
  for (const k of Object.keys(probabilities)) { probabilities[k] = probabilities[k] / total; if (!best || probabilities[k] > probabilities[best]) best = k; }
  return { control: { choice: best, confidence: probabilities[best], probabilities }, finished: { noul: 0 }, right_app: { noul: 1 } };
}

module.exports = { chooseElement, heuristicAnswers, score, overlap, terms, RADIUS, THRESHOLD, AMBIGUOUS, MAX_AREA };
