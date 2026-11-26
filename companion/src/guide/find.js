'use strict';
// Find on the screen: "where is the Mourinho video", "find me the late policy",
// "circle the total". Before any model, any web search or any command layer
// gets the words, they are looked for among the words Windows OCR reads off
// the screen. There: a ring goes round them at once, with no model call and
// nothing spent. Not there: the ask goes on exactly as it always did.
//
// Live 2026-11-23 (Pranav, YouTube's home page in front): "Where is the
// Mourinhos doing things differently, video?" was taken by the reflex layer,
// which opened a new tab and searched the web for those words while the video
// sat on the screen in front of him.
//
// Pure: findAsk(text) reads the ask, locate(ask, ocr) finds it.

const { norm } = require('./marks');

const LEAD = "^\\s*(?:(?:hey|hi|ok|okay|so|um+|uh+|please|nus|nūs|just|now|well|alright|yo|quick(?:ly)?|real quick|and|also|actually|can you|could you|would you|will you|i want you to|i need you to|go ahead and|try to|help me)[\\s,]+)*";
// Asking where a thing is, or to have it found or marked. Never "where do I",
// "how do I", "find out", "find a way": those are tasks and questions.
const VERB = new RegExp(LEAD + "(?:where(?:'s| is| are| was| were)|where can i (?:find|see)|find(?: me)?|show me(?: where)?|point (?:at|to|out)|circle|ring|highlight|underline|mark|locate|spot|look for|do you see|can you see)\\s+(?!out\\b|a way\\b|time\\b)(.+?)\\s*$", 'i');
const TAIL = /(?:[\s,]+(?:on (?:the|my|this) (?:screen|page|site|tab)|on here|in here|here|for me|please|right now|is|are|at|located|again))+[\s.?!]*$/i;
const HEAD = /^(?:(?:the|my|that|this|those|these|a|an|any|some|one of the)\s+)+/i;
// A pronoun alone names nothing to look for.
const NOTHING = /^(?:it|that|this|them|those|these|one|something|anything|everything|here|there|i|we|you|he|she|they|what|which|who)$/i;
// Words that say what kind of thing it is, not which one: dropped when other words remain.
const KIND = new Set(['video', 'videos', 'button', 'link', 'tab', 'icon', 'option', 'menu', 'thing', 'section', 'part', 'text', 'word', 'words', 'line', 'page', 'post', 'article', 'item', 'row', 'cell', 'field', 'box', 'setting', 'one', 'called', 'named', 'titled', 'that', 'says', 'saying', 'about', 'with',
  'card', 'product', 'picture', 'photo', 'image', 'thumbnail', 'movie', 'show', 'song', 'album', 'result', 'listing', 'tweet', 'clip', 'episode', 'game', 'reel', 'short', 'story', 'recipe', 'playlist', 'channel']);
// Kinds that are more than their words: a video is its picture and its title.
// Asked for by kind, the whole thing is ringed, not the words that were said
// (first seen ringing only the words of a video's title, 2026-11-23).
const ITEM = new Set(['video', 'videos', 'post', 'article', 'item', 'card', 'product', 'picture', 'photo', 'image', 'thumbnail', 'movie', 'show', 'song', 'album', 'result', 'listing', 'tweet', 'clip', 'episode', 'game', 'reel', 'short', 'story', 'recipe', 'playlist']);
const STOP = new Set(['the', 'a', 'an', 'of', 'for', 'to', 'in', 'on', 'at', 'and', 'or', 'is', 'are', 'was', 'be', 'it', 'its', 'my', 'me', 'i', 'by', 'from', 'as', 'this', 'that', 'where', 'which']);
// How far a pixel's three colours together must be from the page's to count
// as picture. A black thumbnail on YouTube's dark page is 37 away (2,2,4
// against 15,15,15, measured 2026-11-23); JPEG noise on a flat page is under 10.
const OFF_PAGE = 18;
const MAX_PHRASE_WORDS = 12;
const MAX_HITS = 3;

// -> { phrase, tokens } or null when the words are not a "find it" ask.
function findAsk(text) {
  const raw = String(text || '').replace(/[’‘]/g, "'").trim();
  if (!raw || raw.length > 160) return null;
  const m = VERB.exec(raw);
  if (!m) return null;
  let phrase = m[1].replace(/[?.!]+$/, '').replace(TAIL, '').replace(HEAD, '').replace(/^["“”']|["“”']$/g, '').trim();
  if (!phrase || NOTHING.test(phrase)) return null;
  // "Where's my mistake", "find the errors": a check of their work (the red pen), not words to look up.
  if (/^(?:mistakes?|errors?|typos?|bugs?|problems?|issues?|what(?:'s| is) wrong)$/i.test(phrase)) return null;
  const words = phrase.split(/[\s,;:]+/).filter(Boolean);
  if (words.length > MAX_PHRASE_WORDS) return null;
  let tokens = words.map(norm).filter((t) => t && !STOP.has(t));
  const named = tokens.filter((t) => !KIND.has(t));
  // Named by its kind as well as its words ("the Mourinho video"): the whole thing is wanted.
  const item = named.length > 0 && tokens.some((t) => ITEM.has(t));
  if (named.length) tokens = named;
  tokens = Array.from(new Set(tokens));
  // One short common word ("ok", "go") would be everywhere.
  if (!tokens.length || (tokens.length === 1 && tokens[0].length < 3)) return null;
  return item ? { phrase, tokens, item: true } : { phrase, tokens };
}

function editWithin(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length] <= max;
}
const stem = (s) => (s.length > 3 ? s.replace(/(?:es|s)$/, '') : s);
// The spoken word against the written one: the same, the same without a plural
// or possessive s ("Mourinhos" for "Mourinho's"), or a letter off in a long word.
function sameWord(said, seen) {
  if (said === seen) return true;
  if (stem(said) === stem(seen) && stem(said).length >= 3) return true;
  const n = Math.min(said.length, seen.length);
  return n >= 5 && editWithin(said, seen, n >= 9 ? 2 : 1);
}

const union = (rects) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rects) { x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h); }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
};

// How many of the ask's words must be there: all of one or two, most of more.
function needed(n) { return n <= 2 ? n : Math.max(2, Math.ceil(n * 0.6)); }

// -> up to MAX_HITS places, best first: [{ rect (the image's pixels), text, matched, of, score }]
// A title that wraps is one place: a line and the line under it are tried together.
function locate(ask, ocr) {
  // Each line's words that can be matched, and the line's whole box, signs and
  // bullets included: a line that opens with a play sign still starts there.
  const kept = ((ocr && ocr.lines) || []).map((l) => ({ entries: (l.words || []).map((w) => ({ w, s: norm(w.t) })).filter((e) => e.s), all: l.words || [] })).filter((l) => l.entries.length);
  const lines = kept.map((l) => l.entries);
  if (!ask || !ask.tokens || !ask.tokens.length || !lines.length) return [];
  const need = needed(ask.tokens.length);
  const boxes = kept.map((l) => union(l.all));
  // The line a line runs on to: the nearest one just under it that overlaps it
  // sideways. Looked for by place, not by order: on a page of cards the next
  // line OCR hands over is the card beside this one, not the line under it.
  const below = (i) => {
    const A = boxes[i];
    let best = -1;
    for (let j = 0; j < lines.length; j++) {
      if (j === i) continue;
      const B = boxes[j];
      const gap = B.y - (A.y + A.h);
      if (gap < -2 || gap > Math.max(A.h, B.h) * 1.2 || !(B.x < A.x + A.w && A.x < B.x + B.w)) continue;
      if (best < 0 || B.y < boxes[best].y) best = j;
    }
    return best;
  };
  // The block a place sits in: its own line or lines, and up to three lines
  // under them that start at the same left edge (a title, then who posted it,
  // then how many watched).
  const blockOf = (ids) => {
    const all = ids.slice();
    let last = ids[ids.length - 1];
    const left = Math.min(...ids.map((i) => boxes[i].x));
    for (let n = 0; n < 3; n++) {
      const j = below(last);
      // The same left edge, or a little in from it (a small picture or a sign in front of the words).
      const dx = j < 0 ? 0 : boxes[j].x - left;
      if (j < 0 || all.includes(j) || dx < -14 || dx > Math.max(14, boxes[last].h * 2.5)) break;
      all.push(j); last = j;
    }
    return union(all.map((i) => boxes[i]));
  };
  const cands = [];
  const tryWords = (entries, span, ids) => {
    const hit = [];
    const used = new Set();
    for (const t of ask.tokens) {
      const i = entries.findIndex((e, k) => !used.has(k) && sameWord(t, e.s));
      if (i >= 0) { used.add(i); hit.push(i); }
    }
    if (hit.length < need) return;
    // From the first matched word to the last, so the ring takes in the words between them.
    const lo = Math.min(...hit), hi = Math.max(...hit);
    const run = entries.slice(lo, hi + 1);
    cands.push({ rect: union(run.map((e) => e.w)), text: run.map((e) => e.w.t).join(' '), matched: hit.length, of: ask.tokens.length, extra: run.length - hit.length, span, ids });
  };
  lines.forEach((l, i) => {
    tryWords(l, 1, [i]);
    const j = below(i);
    if (j >= 0) tryWords(l.concat(lines[j]), 2, [i, j]);
  });
  if (!cands.length) return [];
  for (const c of cands) c.score = c.matched / c.of - c.extra * 0.01 - (c.span - 1) * 0.005;
  cands.sort((a, b) => b.score - a.score);
  // Only the places that match as well as the best one, and never the same place twice.
  const top = cands[0].matched;
  const out = [];
  for (const c of cands) {
    if (c.matched < top) continue;
    const overlaps = out.some((o) => c.rect.x < o.rect.x + o.rect.w && o.rect.x < c.rect.x + c.rect.w && c.rect.y < o.rect.y + o.rect.h && o.rect.y < c.rect.y + c.rect.h);
    if (overlaps) continue;
    // block: the lines it is part of (a whole title and what is written under
    // it), and the height of one of those lines, for finding its picture.
    out.push({ rect: c.rect, text: c.text, matched: c.matched, of: c.of, score: c.score, block: blockOf(c.ids), lineHeight: boxes[c.ids[0]].h });
    if (out.length >= MAX_HITS) break;
  }
  return out;
}

// ---- the whole item: the picture above its words ----------------------------
// A video, a product, a post on a page of cards is a picture with its words
// under it. From the words' block this looks straight up in the screenshot:
// past the thin strip of page between them, a band of rows that are mostly
// not the page's colour is the picture; it ends where the page's colour comes
// back, above it and to each side. -> the picture and the words as one rect,
// or null when there is no picture there (a paragraph, a list, a blank page).
// bgra: the screenshot's pixels (BGRA, 4 bytes each, as nativeImage.toBitmap
// gives them); block and the result are in that picture's pixels.
function growToItem(bgra, width, height, block, lineHeight) {
  if (!bgra || !(width > 0) || !(height > 0) || !block || bgra.length < width * height * 4) return null;
  const lh = Math.max(6, Math.round(lineHeight || block.h));
  const bx0 = Math.max(0, Math.round(block.x)), bx1 = Math.min(width - 1, Math.round(block.x + block.w)), by0 = Math.round(block.y);
  if (bx1 - bx0 < 8 || by0 < lh * 2) return null;
  const px = (x, y) => { const o = (y * width + x) * 4; return [bgra[o], bgra[o + 1], bgra[o + 2]]; };
  // The page's colour: the middle value of the strip just above the words.
  const sy = Math.max(0, by0 - Math.max(2, Math.round(lh * 0.3)));
  const ch = [[], [], []];
  for (let x = bx0; x <= bx1; x += 2) { const p = px(x, sy); ch[0].push(p[0]); ch[1].push(p[1]); ch[2].push(p[2]); }
  const mid = (a) => a.sort((m, n) => m - n)[a.length >> 1];
  const bg = [mid(ch[0]), mid(ch[1]), mid(ch[2])];
  const off = (x, y) => { const o = (y * width + x) * 4; return Math.abs(bgra[o] - bg[0]) + Math.abs(bgra[o + 1] - bg[1]) + Math.abs(bgra[o + 2] - bg[2]) > OFF_PAGE; };
  const rowShare = (y, x0, x1) => { let n = 0, t = 0; for (let x = x0; x <= x1; x += 2) { t++; if (off(x, y)) n++; } return t ? n / t : 0; };
  const colShare = (x, y0, y1) => { let n = 0, t = 0; for (let y = y0; y <= y1; y += 2) { t++; if (off(x, y)) n++; } return t ? n / t : 0; };
  // The words' box can start a row or two inside the letters (it did in the
  // app's own smaller picture, 2026-11-23): step up out of them first.
  let y = by0 - 1;
  const lettersEnd = Math.max(0, by0 - Math.ceil(lh * 0.6));
  while (y > lettersEnd && rowShare(y, bx0, bx1) >= 0.12) y--;
  // Up through the strip of page between the words and the picture.
  const gapEnd = Math.max(0, by0 - lh * 3);
  while (y > gapEnd && rowShare(y, bx0, bx1) < 0.12) y--;
  if (y <= gapEnd) return null;
  const bottom = y;
  // Up through the picture, until the page's colour holds for a few rows.
  const limit = Math.max(0, bottom - Math.round(height * 0.45));
  let top = bottom, quiet = 0;
  for (; y >= limit; y--) {
    if (rowShare(y, bx0, bx1) < 0.08) { quiet++; if (quiet >= 6) break; } else { quiet = 0; top = y; }
  }
  const bandRows = bottom - top + 1;
  // A picture is tall and mostly not the page; lines of text are short and mostly page.
  if (bandRows < lh * 2.5) return null;
  let cover = 0, counted = 0;
  for (let yy = top; yy <= bottom; yy += 2) { cover += rowShare(yy, bx0, bx1); counted++; }
  if (!counted || cover / counted < 0.45) return null;
  // Out to each side until the page's colour holds.
  const side = (from, step, stop) => {
    let edge = from, q = 0;
    for (let x = from; step > 0 ? x <= stop : x >= stop; x += step) {
      if (colShare(x, top, bottom) < 0.08) { q++; if (q >= 6) break; } else { q = 0; edge = x; }
    }
    return edge;
  };
  const maxW = Math.round(width * 0.6);
  const left = side(bx0, -1, Math.max(0, bx0 - maxW)), right = side(Math.min(bx1, bx0 + lh), 1, Math.min(width - 1, bx0 + maxW));
  const x0 = Math.min(left, bx0), x1 = Math.max(right, bx1), y1 = Math.round(block.y + block.h);
  const item = { x: x0, y: top, w: x1 - x0, h: y1 - top };
  // The whole window is not an item.
  if (item.w * item.h > width * height * 0.3 || item.w < lh * 3) return null;
  return item;
}

// What the Knot says when it has ringed it.
function foundLine(hits) {
  return hits.length === 1 ? 'Here it is.' : 'Here, in ' + hits.length + ' places.';
}

module.exports = { findAsk, locate, growToItem, foundLine, sameWord, needed, MAX_HITS };
