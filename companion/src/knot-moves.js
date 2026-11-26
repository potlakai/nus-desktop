// "Move to the top left." "Go back." "Make yourself smaller." Words that send
// the Knot itself somewhere or change its size.
//
// Read by code, not by a model: the phrases are few and exact, a wrong guess
// would move the mark for no reason, and the classifier already has a "move
// the window to the left" intent these must never be confused with. Anything
// that mentions a window, a tab or an app is left for the reflex layer.
'use strict';

const NOT_THE_KNOT = /\b(?:window|windows|tab|tabs|app|application|browser|page|file|cursor|mouse|this|that|it)\b/;
const VERB = /\b(?:move|go|scoot|hop|skate|slide|sit|stay|stand|head|shift|travel)\b/;
const SELF = /\b(?:knot|yourself|you|over|corner|side)\b/;
const CORNER = /\b(top|upper|bottom|lower)[\s-]*(left|right)\b/;
const BACK = /^(?:(?:ok(?:ay)?|please|now|knot)[,.!]?\s+)*(?:(?:go|come|move|get|head)\s+(?:back\s+)?home|(?:go|come|move|get|head)\s+back(?:\s+to\s+(?:your|the)\s+(?:spot|corner|place|home))?|back\s+to\s+(?:your|the)\s+(?:spot|corner|place))[.!?\s]*$/;

const BARE_MOVE = /^(?:(?:ok(?:ay)?|please|now|hey|so|and|then|can you|could you|would you|nus|n[uū]s)[,.!]?\s+)*(?:move|go|scoot|hop|skate|slide|head|shift)\s+(?:over\s+|up\s+|down\s+)?(?:to|into)\s+(?:the\s+)?(?:top|upper|bottom|lower)[\s-]*(?:left|right)(?:\s+(?:corner|side))?(?:\s+(?:please|now))?[.!?\s]*$/;

function clean(text) { return String(text || '').toLowerCase().replace(/[’']/g, '').trim(); }

// -> { corner: 'tl' | 'tr' | 'bl' | 'br' } | { home: true } | null
function knotMoveCommand(text) {
  const t = clean(text);
  if (!t || t.length > 80) return null;
  if (BACK.test(t)) return { home: true };
  if (NOT_THE_KNOT.test(t)) return null;
  const c = CORNER.exec(t);
  // "Move to the top right" said to the Knot, with nothing else named, means
  // the Knot (live 2026-10-13 it needed "yourself" or "corner" to count).
  if (c && VERB.test(t) && (SELF.test(t) || BARE_MOVE.test(t))) return { corner: (/top|upper/.test(c[1]) ? 't' : 'b') + (c[2] === 'left' ? 'l' : 'r') };
  return null;
}

// "Make yourself smaller", "get bigger", "shrink", "back to your normal size".
// Three sizes; smaller and bigger step one size, normal resets.
// -> { size: 'smaller' | 'bigger' | 'normal' } | null
const LEAD = '^(?:(?:ok(?:ay)?|please|now|hey|so|and|then|can you|could you|would you|knot|nus|n[uū]s)[,.!]?\\s+)*';
const SMALLER = '(?:smaller|tinier|small|little|shorter)';
const BIGGER = '(?:bigger|larger|big|large)';
const NORMAL = '(?:normal|regular|default|usual|original|standard)';
const AMOUNT = '(?:(?:a (?:bit|little|lot|tad)|way|much|slightly|even)\\s+)?';
const TAIL = '(?:\\s+(?:again|please|for me|now))*[.!?\\s]*$';
const SIZE_RULES = [
  [new RegExp(LEAD + '(?:make|get|go|be|turn)\\s+(?:yourself|you|the knot)\\s+' + AMOUNT + '(' + SMALLER + '|' + BIGGER + '|' + NORMAL + '(?:\\s+size)?)' + TAIL), 1],
  [new RegExp(LEAD + '(?:get|go|be)\\s+' + AMOUNT + '(' + SMALLER + '|' + BIGGER + ')' + TAIL), 1],
  [new RegExp(LEAD + '(shrink|grow)(?:\\s+(?:yourself|a (?:bit|little|lot)|down|up))*' + TAIL), 1],
  [new RegExp(LEAD + '(?:(?:go|get|come|change|make yourself|be)\\s+)?(?:back\\s+)?(?:to\\s+)?(?:your\\s+)?(' + NORMAL + ')\\s+size' + TAIL), 1],
];
function knotSizeCommand(text) {
  const t = clean(text).replace(/\bthe not\b/g, 'the knot');
  if (!t || t.length > 60) return null;
  if (/\b(?:window|windows|tab|tabs|app|browser|page|file|font|text|screen|picture|image|video|volume|it|this|that)\b/.test(t)) return null;
  for (const [re] of SIZE_RULES) {
    const m = re.exec(t);
    if (!m) continue;
    const w = m[1];
    if (/^(?:shrink)$/.test(w) || new RegExp('^' + SMALLER + '$').test(w)) return { size: 'smaller' };
    if (/^(?:grow)$/.test(w) || new RegExp('^' + BIGGER + '$').test(w)) return { size: 'bigger' };
    return { size: 'normal' };
  }
  return null;
}

const SIZES = ['small', 'normal', 'big'];
// The size after a command, from the current one.
function nextKnotSize(current, cmd) {
  const i = Math.max(0, SIZES.indexOf(SIZES.includes(current) ? current : 'normal'));
  if (!cmd || cmd.size === 'normal') return 'normal';
  if (cmd.size === 'smaller') return SIZES[Math.max(0, i - 1)];
  if (cmd.size === 'bigger') return SIZES[Math.min(SIZES.length - 1, i + 1)];
  return SIZES.includes(cmd.size) ? cmd.size : 'normal';
}
// The scale the renderer draws each size at.
const KNOT_SCALE = { small: 0.7, normal: 1, big: 1.35 };

// A sentence may move or resize the Knot in one clause and ask for something
// else in the next: "move to the top right and turn it down a bit". The
// Knot's own clauses are taken out here; the rest goes on to be routed.
// split: the reflex router's splitClauses. -> { cmds: [{ move } | { size }], rest } | null
function selfCommands(text, split) {
  const clauses = typeof split === 'function' ? split(text) : [String(text || '')];
  const cmds = [], rest = [];
  for (const c of clauses) {
    const mv = knotMoveCommand(c);
    // "Go back" only on its own: after "open Chrome and" it means the page.
    if (mv && !(mv.home && clauses.length > 1)) { cmds.push({ move: mv }); continue; }
    const sz = knotSizeCommand(c);
    if (sz) { cmds.push({ size: sz }); continue; }
    rest.push(c);
  }
  if (!cmds.length) return null;
  return { cmds, rest: rest.join(', ').trim() };
}

module.exports = { knotMoveCommand, knotSizeCommand, nextKnotSize, selfCommands, KNOT_SCALE, SIZES };
