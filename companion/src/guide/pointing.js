// Pointing: the one model call per guide step, and the strict contract
// around it. The model names the next thing to do and picks ONE control,
// preferably by id from the probe's list so the rectangle comes from Windows
// and not from the model. Anything that fails validation becomes "I couldn't
// find it", never a thread: a wrong pointer is worse than none.
'use strict';

const MAX_ELEMENTS = 150;
// 2026-09-15: these were 0.5 / 0.6 / 0.75 and turned a real control from the
// Windows list into "I could not work out the next step" whenever the model
// hedged. A hedged pick is now pointed at and labelled a best guess (see
// LOW_CONF_GUESS in session.js); only a shrug is refused.
const MIN_CONF_ELEMENT = 0.3;
const MIN_CONF_BBOX = 0.4;
const MIN_CONF_BBOX_UNVERIFIED = 0.5;    // no probe to check against
const CONF_SURE = 0.6;                   // below this the bubble says "best guess"
const MAX_BBOX_AREA = 0.25;              // a "target" this big is the model pointing at the window
const BBOX_SLACK = 0.05;                 // trim, do not reject, a box this far past the screen edge
const MAX_INSTRUCTION = 140;

// The reply is spoken aloud as it streams, so it is prose first, tags last
// (src/guide/reply-stream.js). The JSON contract this replaced is still
// accepted by parsePointReply.
const SYSTEM = [
  'You are Nūs, a quiet on-screen guide. The user said what they need help with. You get one screenshot of their screen and, when available, a numbered list of the interactive controls in the front window with their positions.',
  'Your job: say the ONE next thing to do and point at exactly one control.',
  '',
  'Reply format. First one short imperative sentence for the user, at most 12 words, spoken aloud as it is written. It opens with the action itself, the verb and the control, in the first five words ("Click Insert, top left."), with no preamble ("Sure", "Okay", "To do that", "First you will want to"): Nūs has already said a short acknowledgement out loud. Then, on a new line, exactly one point tag:',
  '[POINT:<id>]  the control, by its id from the list',
  '[POINT:<x>,<y>,<w>,<h>:<label>]  a box as fractions of the screen (x,y top-left, w,h size) and the text you can read on the control, only when it is clearly visible but not in the list',
  '[POINT:none]  when nothing on this screen should be clicked for this goal',
  'Then, optionally: [CONF:<0..1>] how sure you are of the pick (always give it); [DONE] when the goal is reached; [NOTE:<one short sentence>] only when the point is none or the click is irreversible.',
  'No code fences, no JSON, nothing after the tags.',
  '',
  'First decide: is the goal something to click or do, or a question about the screen?',
  '- A question about the screen ("summarize this", "what does this say", "explain this error", "what do you see", "is this right") is not yours to point at. Reply with exactly [ANSWER] and nothing else. Another part of Nūs answers it.',
  '- Never tell the user to type their question or request into a text box, a chat, a search box or another assistant. If that is the only step you can think of, reply [ANSWER].',
  '',
  'Rules:',
  '- Prefer an id from the list. Use a box only when the control is clearly visible but not in the list. Use none when you are not sure which control it is.',
  '- Many apps (video editors, games, apps with custom toolbars) list few or no controls. Then use a bbox with the label you can read on the control. Never give up on the goal because the list is empty.',
  '- The user is being walked through the task one click at a time: after each click you get a fresh screenshot. Name the next concrete click while the goal needs more; point at none only when this screen truly has nothing to click for it.',
  '- Never point at a password, card number, or ID number field. Point at none and say why in the note.',
  '- If the click is irreversible (Submit, Pay, Send, Delete, Purchase, Post, Publish), say so in the sentence, for example "Click Submit. This sends it."',
  '- [DONE] when the goal is reached or nothing more needs clicking; then the sentence is a short closing line and the point is none.',
  '- If the front window is not the app the goal needs, the sentence says which app to open, point none.',
  '- Plain words. Never say "I can see" and never describe the screenshot. Never say ids, coordinates or tags out loud; they only go in the tags.',
].join('\n');

// NUS_GUIDE_PLAN=inline: the model also says what it expects the following
// clicks to be. That plan is only ever shown to the quick pointer (Jev) on the
// next step; it is never fed back into this prompt, and a reply without it, or
// with a broken one, is exactly as valid as before.
const PLAN_RULE = '- After the tags you may add [NEXT:<the step after this one> (<the text on that control>) | <the one after> (<control>)], up to 3 steps, for the clicks you expect to follow. Leave it out when you cannot tell.';
const MAX_PLAN = 3;

function clip(s, n) { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

function elementLines(elements) {
  return (elements || []).slice(0, MAX_ELEMENTS).map((e) => {
    const b = e.box || [0, 0, 0, 0];
    return `${e.id} | ${e.type || '?'} | ${JSON.stringify(clip(e.name, 60))} | ${b.map((v) => Number(v).toFixed(3)).join(',')}`;
  });
}

// { task, history:[{instruction}], window:{title,process}, elements:[{id,type,name,box}] }
function buildPointRequest(input) {
  const lines = elementLines(input.elements);
  const history = (input.history || []).map((h, i) => `${i + 1}. ${clip(h.instruction, 100)}${h.outcome ? ' (' + h.outcome + ')' : ''}`);
  const text = [
    'Goal: ' + clip(input.task, 300),
    'Front window: ' + clip(input.window && input.window.title, 120) + (input.window && input.window.process ? ' (' + input.window.process + ')' : ''),
    'Steps already done:',
    history.length ? history.join('\n') : '(none yet)',
    'Controls in the front window (id | type | name | box x,y,w,h as fractions of the screen):',
    lines.length ? lines.join('\n') : '(none available: use a bbox with a label, or null)',
    ...(input.hint && input.hint.instruction ? ['', 'Last time, at this point, the step was: ' + clip(input.hint.instruction, 100) + (input.hint.target && input.hint.target.name ? ' (control "' + clip(input.hint.target.name, 60) + '")' : '') + '. Use it if it still applies.'] : []),
    // A follow-up: what was just done, so "and how do I resize it" has an "it".
    ...(input.previous && input.previous.task ? ['', 'Just before this the user asked: ' + clip(input.previous.task, 200) + (input.previous.steps && input.previous.steps.length ? '. Steps they did: ' + input.previous.steps.map((st) => clip(st, 80)).join('; ') : '') + '. This ask probably continues from there.'] : []),
    '',
    'What is the one next step? One sentence, then the tags.',
  ].join('\n');
  return { system: input.plan ? SYSTEM + '\n' + PLAN_RULE : SYSTEM, text };
}

// Either contract: the spoken-sentence-plus-tags reply, or a JSON object
// (tolerant of fences and chatter around it).
function parsePointReply(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  const fenced = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const a = fenced.indexOf('{'), b = fenced.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try {
      const obj = JSON.parse(fenced.slice(a, b + 1));
      if (obj && typeof obj === 'object') return obj;
    } catch (_) { /* not JSON after all: read it as sentences and tags */ }
  }
  const { parseReply } = require('./reply-stream');
  const r = parseReply(s);
  if (!r.reply) return null;
  // Prose with no tag at all (an older model, or one that forgot) is not a
  // pointing reply unless it reads like one.
  if (!r.events.length && !/^[A-Z]/.test(r.reply.instruction)) return null;
  return r.reply;
}

// The optional plan. Anything odd about it is dropped, never an error.
function sanitizePlan(next) {
  if (!Array.isArray(next)) return [];
  const out = [];
  for (const n of next) {
    if (!n || typeof n !== 'object') continue;
    const instruction = clip(n.instruction, MAX_INSTRUCTION), control = clip(n.control, 80);
    if (!instruction && !control) continue;
    out.push({ instruction, control });
    if (out.length >= MAX_PLAN) break;
  }
  return out;
}

// -> { ok, reason, reply } with reply normalized: instruction, target|null, confidence, done, note
function validatePoint(reply, elements, opts = {}) {
  const verified = opts.verified !== false; // a probe is there to check bboxes
  if (!reply || typeof reply !== 'object') return { ok: false, reason: 'no reply' };
  // [ANSWER]: the goal was a question, not a click. The session answers it.
  if (reply.answer === true) return { ok: true, reason: 'answer', reply: { instruction: clip(reply.instruction, MAX_INSTRUCTION), target: null, confidence: 0, done: false, note: '', next: [], answer: true } };
  const out = {
    instruction: clip(reply.instruction, MAX_INSTRUCTION),
    target: null,
    confidence: Math.max(0, Math.min(1, Number(reply.confidence) || 0)),
    done: reply.done === true,
    note: clip(reply.note, 200),
  };
  if (!out.instruction) return { ok: false, reason: 'no instruction' };
  out.next = sanitizePlan(reply.next);
  const t = reply.target;
  if (t == null) return { ok: true, reason: out.done ? 'done' : (out.note || 'no target'), reply: out };
  if (typeof t !== 'object') return { ok: false, reason: 'bad target', reply: out };
  if (t.kind === 'element') {
    const id = Number(t.id);
    const el = (elements || []).find((e) => Number(e.id) === id);
    if (!el) return { ok: false, reason: 'unknown element id ' + t.id, reply: out };
    if (out.confidence < MIN_CONF_ELEMENT) return { ok: false, reason: 'low confidence', reply: out };
    out.target = { kind: 'element', id, name: el.name || '', type: el.type || '' };
    return { ok: true, reason: 'element', reply: out };
  }
  if (t.kind === 'bbox') {
    let x = Number(t.x), y = Number(t.y), w = Number(t.w), h = Number(t.h);
    if (![x, y, w, h].every((v) => Number.isFinite(v))) return { ok: false, reason: 'bad bbox', reply: out };
    // The model sometimes answers in pixels of the image it saw ("x":113,"y":51
    // for Word's Insert tab, live 2026-10-22) instead of fractions. Every number
    // over 1.5 and the image size known: it is pixels, so convert, then check.
    let pixels = false;
    const img = opts.image;
    if (img && img.width > 0 && img.height > 0 && [x, y, w, h].every((v) => v >= 0) && [x, y, w, h].some((v) => v > 1.5) && w > 1.5 && h > 1.5) {
      x /= img.width; w /= img.width; y /= img.height; h /= img.height; pixels = true;
    } else if (img && img.width > 0 && img.height > 0 && [x, y, w, h].every((v) => v >= 0) && (x > 1.5 || y > 1.5) && x <= img.width && y <= img.height && w <= 1 && h <= 1) {
      // Half and half: the corner in pixels, the size already in fractions
      // ("[POINT:1117,148,0.06,0.025]" for MDN's Theme button, fast tier
      // 2026-11-15, 5 of 168 replies). Convert the corner only.
      x /= img.width; y /= img.height; pixels = true;
    }
    // A box that pokes a hair past the screen edge (a taskbar button, a menu
    // at the very top) is the model rounding, not a miss: trim it to the edge.
    if (x < 0 && x >= -BBOX_SLACK) { w += x; x = 0; }
    if (y < 0 && y >= -BBOX_SLACK) { h += y; y = 0; }
    if (x + w > 1 && x + w <= 1 + BBOX_SLACK) w = 1 - x;
    if (y + h > 1 && y + h <= 1 + BBOX_SLACK) h = 1 - y;
    if (x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > 1.0001 || y + h > 1.0001) return { ok: false, reason: 'bbox out of range', reply: out };
    if (w * h > MAX_BBOX_AREA) return { ok: false, reason: 'bbox too large', reply: out };
    if (out.confidence < (verified ? MIN_CONF_BBOX : MIN_CONF_BBOX_UNVERIFIED)) return { ok: false, reason: 'low confidence', reply: out };
    out.target = { kind: 'bbox', x, y, w, h, label: clip(t.label, 80) };
    return { ok: true, reason: pixels ? 'bbox (pixels converted)' : 'bbox', reply: out };
  }
  return { ok: false, reason: 'unknown target kind', reply: out };
}

module.exports = { SYSTEM, PLAN_RULE, sanitizePlan, buildPointRequest, parsePointReply, validatePoint, elementLines, MAX_ELEMENTS, CONF_SURE };
