'use strict';
// Drawing on the screen: the marks an answer makes while it is spoken.
//
// When Nūs answers a question about the screen, the reply may carry mark tags
// after the sentence that mentions a thing:
//   [UNDERLINE:"the exact words"]        a line under words on the screen
//   [CIRCLE:12]  [CIRCLE:"Save"]         a ring round a control, number or label
//   [BOX:0.1,0.2,0.4,0.3:the chart]      a frame round a whole area
//   [ARROW:"Total" -> 14]                an arrow from one thing to another
// A target is a control id from the list, words in quotes, or a box in screen
// fractions with what it is.
//
// The rule that makes a mark worth drawing: it lands on something Windows
// itself reports, not on where a model guessed. Words are found among the word
// boxes Windows OCR reads off the same screen; ids are rectangles from UI
// Automation; a box is moved onto the words or the control it names when one
// is there. A mark that cannot be placed is not drawn. An underline is never
// drawn on a guess: a line under the wrong sentence is worse than none.
//
// Pure: no Electron, no probe. The session supplies the control list, the
// word boxes and the capture's geometry.

const { iou, tokenOverlap } = require('./verify');
const { sensitiveTarget } = require('./sensitive');

const SHAPES = new Set(['underline', 'circle', 'box', 'arrow', 'wrong', 'right']);
// The red pen's two marks (a check of someone's work): never drawn on a guess.
const PEN = new Set(['wrong', 'right']);
const MAX_FIX = 28;                  // the fix written beside a mistake: a number or a few words
const MAX_MARKS = 6;                 // per answer; more than this is scribble
const MAX_WORDS_TEXT = 120;
const MAX_LINES = 3;                 // an underline runs over at most this many lines
const MAX_AREA = { underline: 0.2, circle: 0.3, box: 0.6, arrow: 0.3, wrong: 0.2, right: 0.2 };   // share of the screen
const MIN_SIDE_PX = 6;
const BOX_REACH_PX = 28;             // how far a frame round words may reach past them toward the box asked for

function clip(s, n) { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

// What a check of someone's work is told instead ("is this right", "check my
// work"): the red pen. The mistake is ringed where it is and the fix is
// written beside it; the sentence says the fix too, because a mark that cannot
// be placed is not drawn.
const PEN_RULES = [
  'You are checking their work the way a good teacher does, with a red pen on their own screen.',
  'After the sentence that names a mistake, mark it: [WRONG:"27" = 15]. In the quotes goes the smallest wrong piece exactly as written on the screen: the wrong number or the wrong word or two, not the whole line. After the equals sign goes what it should be: one number or at most four words. The pen rings the mistake and writes the fix beside it. With no short fix, leave that part out: [WRONG:"their going"]',
  'After a sentence that says a part is right, you may tick it: [RIGHT:"x = 4"]',
  'A tag goes after its sentence, never inside it, and never all together at the end. Mark every real mistake, up to five, and at most one tick. If nothing is wrong, say so plainly and mark nothing as wrong.',
  'Say the fix in the sentence as well. Only mark what is really on this screen. Never say a tag out loud.',
];

// What the answering model is told. Short and flat: the default brain is small.
// Every tag is shown as a real example, never as a pattern: publik-fast copied
// "[BOX:<target>]" out letter for letter (draw-check 2026-11-23, 2 of 16 marks).
// A box is left, top, right, bottom because that is how models write boxes when
// left to themselves (the same run: "403,169,863,407", "(340, 110, 1230, 380)").
const DRAW_RULES = [
  'You can draw on their screen while you talk. Right after a sentence that mentions something visible, add one mark tag for it. A tag goes after the sentence, never inside it, and never all together at the end. The tags, each shown as an example:',
  '[UNDERLINE:"Total due"]  a line under words on the screen. Copy the words exactly as they are written there, two to eight of them, in quotes.',
  '[CIRCLE:"Save As"]  a ring round one button, icon, number or short label, named by the words on it, in quotes. When a control list is given and the thing is in it, its id works too: [CIRCLE:12]',
  '[BOX:"Choose your mode"]  a frame round a whole area, named by its heading or its first words, in quotes.',
  '[ARROW:"Speaker gift" -> "149"]  an arrow from one thing to another, when one causes or explains the other.',
  'Only for a picture, a chart or a thing with no words on it, give its place instead, as left, top, right, bottom in fractions of the screen and then what it is: [CIRCLE:0.10,0.20,0.40,0.45:the bar chart]',
  'Always name something that is really on this screen. Mark only what you are talking about: one to four marks in an answer, and none when the answer is not about a particular place on the screen. Never say a tag, an id or a number from a tag out loud.',
];

// "12" | "words" | x,y,w,h:label -> { kind, ... } or null
const QUOTED = /^["“”'‘’`](.+?)["“”'‘’`]$/;
const BBOX = /^(-?\d*\.?\d+)\s*,\s*(-?\d*\.?\d+)\s*,\s*(-?\d*\.?\d+)\s*,\s*(-?\d*\.?\d+)\s*(?::\s*(.*))?$/;
function parseTarget(body) {
  let b = String(body || '').trim();
  if (!b) return null;
  // A pattern copied out of the rules ("<target>") names nothing.
  if (/^<[^<>]*>$/.test(b)) return null;
  if (/^\d+$/.test(b)) return { kind: 'element', id: Number(b) };
  const q = QUOTED.exec(b);
  if (q) { const text = clip(q[1], MAX_WORDS_TEXT); return text ? { kind: 'words', text } : null; }
  // Numbers in brackets of their own are still a box: "(340, 110, 1230, 380)".
  const inner = /^[([{]\s*(.*?)\s*[)\]}]$/.exec(b);
  if (inner && BBOX.test(inner[1])) b = inner[1];
  const m = BBOX.exec(b);
  if (m) {
    const [a, c, e, g] = [m[1], m[2], m[3], m[4]].map(Number);
    if (![a, c, e, g].every(Number.isFinite)) return null;
    // left, top, right, bottom when the last two lie past the first two; a box
    // written as left, top, width, height (the pointer's form) is read as that.
    const corners = e > a && g > c;
    return { kind: 'bbox', x: a, y: c, w: corners ? e - a : e, h: corners ? g - c : g, label: clip((m[5] || '').replace(/^["“”'‘’`]|["“”'‘’`]$/g, ''), 80) };
  }
  // Words with the quotes forgotten.
  if (/[\p{L}\p{N}]/u.test(b)) return { kind: 'words', text: clip(b, MAX_WORDS_TEXT) };
  return null;
}

// (UNDERLINE|CIRCLE|BOX|ARROW, body) -> { type:'mark', shape, target, to? } or null
function parseMarkTag(kind, body) {
  const shape = String(kind || '').toLowerCase();
  if (!SHAPES.has(shape)) return null;
  const b = String(body || '').trim();
  if (shape === 'arrow') {
    // The arrow sign outside quotes: "a -> b" on the screen is still words.
    const parts = splitArrow(b);
    if (!parts) return null;
    const from = parseTarget(parts[0]), to = parseTarget(parts[1]);
    return from && to ? { type: 'mark', shape, target: from, to } : null;
  }
  if (shape === 'wrong') {
    // "149" = 184: the wrong thing, and what it should be. The equals sign outside quotes divides them.
    const cut = splitFix(b);
    const target = parseTarget(cut ? cut[0] : b);
    if (!target) return null;
    const fix = cut ? clip(cut[1].trim().replace(/^["“”'‘’`]|["“”'‘’`]$/g, ''), MAX_FIX) : '';
    return fix ? { type: 'mark', shape, target, fix } : { type: 'mark', shape, target };
  }
  const target = parseTarget(b);
  return target ? { type: 'mark', shape, target } : null;
}
// The first " = " (or " -> ") that is outside quotes.
function splitFix(b) {
  let quote = null;
  for (let i = 0; i < b.length; i++) {
    const c = b[i];
    if (quote) { if (c === quote || (quote === '“' && c === '”')) quote = null; continue; }
    if (c === '"' || c === '“') { quote = c; continue; }
    if (c === '=' && b[i + 1] !== '=') return [b.slice(0, i), b.slice(i + 1)];
    if (b.slice(i, i + 2) === '->') return [b.slice(0, i), b.slice(i + 2)];
    if (c === '→') return [b.slice(0, i), b.slice(i + 1)];
  }
  return null;
}
function splitArrow(b) {
  let quote = null;
  for (let i = 0; i < b.length; i++) {
    const c = b[i];
    if (quote) { if (c === quote || (quote === '“' && c === '”')) quote = null; continue; }
    if (c === '"' || c === '“') { quote = c; continue; }
    const two = b.slice(i, i + 2);
    if (two === '->' || two === '=>') return [b.slice(0, i), b.slice(i + 2)];
    if (c === '→' || c === '⟶') return [b.slice(0, i), b.slice(i + 1)];
  }
  return null;
}

// ---- the words Windows read off the screen ---------------------------------
// The probe's compact form: one word per row "x y w h text", a blank row
// between lines. -> { lines: [{ words: [{ t, x, y, w, h }] }] }
function parseOcrWords(raw) {
  const lines = [];
  let cur = null;
  for (const row of String(raw || '').split(/\r?\n/)) {
    if (!row.trim()) { cur = null; continue; }
    const m = /^(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (.+)$/.exec(row);
    if (!m) continue;
    const word = { t: m[5], x: Number(m[1]), y: Number(m[2]), w: Number(m[3]), h: Number(m[4]) };
    if (![word.x, word.y, word.w, word.h].every(Number.isFinite) || word.w <= 0 || word.h <= 0) continue;
    if (!cur) { cur = { words: [] }; lines.push(cur); }
    cur.words.push(word);
  }
  return { lines };
}

const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '');

function editWithin(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return false;
    prev = cur;
  }
  return prev[b.length] <= max;
}
// OCR reads "l" for "I" and drops a letter now and then: longer words may differ a little.
function fuzzyEq(a, b) {
  if (a === b) return true;
  const n = Math.min(a.length, b.length);
  if (n < 5) return false;
  return editWithin(a, b, n >= 9 ? 2 : 1);
}

function unionRect(words) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const w of words) { x0 = Math.min(x0, w.x); y0 = Math.min(y0, w.y); x1 = Math.max(x1, w.x + w.w); y1 = Math.max(y1, w.y + w.h); }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
const centre = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

// The words of `query` on the screen. -> { rects (one per line, image px),
// score, count } or null. opts.near: a point (image px) that breaks a tie
// between several places the same words appear; opts.within: a rect the words
// must sit in.
function findWords(query, ocr, opts = {}) {
  const lines = (ocr && ocr.lines) || [];
  const flat = [];
  lines.forEach((line, li) => (line.words || []).forEach((w) => { const s = norm(w.t); if (s) flat.push({ s, li, w }); }));
  const qTokens = String(query || '').split(/\s+/).map(norm).filter(Boolean);
  const Q = qTokens.join('');
  if (!flat.length || Q.length < 2) return null;
  const inside = (ws) => !opts.within || ws.every((e) => { const c = centre(e.w); return c.x >= opts.within.x && c.x <= opts.within.x + opts.within.w && c.y >= opts.within.y && c.y <= opts.within.y + opts.within.h; });

  const hits = [];
  // 1. The same letters in a row, whatever OCR did with the spaces.
  let S = '';
  const owner = [];
  flat.forEach((e, i) => { for (let k = 0; k < e.s.length; k++) owner.push(i); S += e.s; });
  for (let at = S.indexOf(Q); at >= 0; at = S.indexOf(Q, at + 1)) {
    const a = owner[at], b = owner[at + Q.length - 1];
    const startsWord = at === 0 || owner[at - 1] !== a;
    const endsWord = at + Q.length === S.length || owner[at + Q.length] !== b;
    // A short ask must be whole words: "in" is not the middle of "window".
    if (!(startsWord && endsWord) && (Q.length < 5 || (!startsWord && !endsWord))) continue;
    const ws = flat.slice(a, b + 1);
    // Written exactly as asked, capitals and all, beats the same letters elsewhere ("Total" over 'total').
    const asWritten = ws.map((e) => e.w.t).join(' ').includes(String(query).trim());
    if (inside(ws)) hits.push({ ws, score: (startsWord && endsWord ? 1 : 0.9) + (asWritten ? 0.05 : 0) });
  }
  // 2. Word by word, forgiving a misread letter.
  if (!hits.length && qTokens.length) {
    const n = qTokens.length;
    const need = n >= 4 ? Math.ceil(n * 0.8) : n;
    for (let i = 0; i + n <= flat.length; i++) {
      let ok = 0;
      for (let k = 0; k < n; k++) if (fuzzyEq(qTokens[k], flat[i + k].s)) ok++;
      if (ok >= need && fuzzyEq(qTokens[0], flat[i].s)) {
        const ws = flat.slice(i, i + n);
        if (inside(ws)) hits.push({ ws, score: 0.85 * ok / n });
      }
    }
  }
  // 3. For the red pen only (opts.partial): the one line that holds most of the
  // words, when OCR dropped a sign or a letter of the rest ("3x = 27" read as
  // "3x 27", or only "27"). It must hold at least half of them, one of two or
  // more characters, and no other line may hold as many.
  if (!hits.length && opts.partial && qTokens.length) {
    const want = Array.from(new Set(qTokens));
    let best = null, tie = false;
    lines.forEach((line, li) => {
      const ws = flat.filter((e) => e.li === li);
      const got = ws.filter((e) => want.includes(e.s));
      const kinds = new Set(got.map((e) => e.s));
      if (kinds.size * 2 < want.length || !got.some((e) => e.s.length >= 2) || !inside(got)) return;
      if (!best || kinds.size > best.n) { best = { n: kinds.size, ws: got }; tie = false; } else if (kinds.size === best.n) tie = true;
    });
    if (best && !tie) hits.push({ ws: best.ws, score: 0.6 * best.n / want.length });
  }
  if (!hits.length) return null;
  let best = hits[0];
  if (hits.length > 1) {
    const top = Math.max(...hits.map((h) => h.score));
    const cands = hits.filter((h) => h.score >= top - 1e-9);
    best = cands[0];
    if (opts.near && cands.length > 1) {
      const d = (h) => { const c = centre(unionRect(h.ws.map((e) => e.w))); return Math.hypot(c.x - opts.near.x, c.y - opts.near.y); };
      best = cands.reduce((a, b) => (d(b) < d(a) ? b : a));
    }
  }
  const byLine = new Map();
  for (const e of best.ws) { if (!byLine.has(e.li)) byLine.set(e.li, []); byLine.get(e.li).push(e.w); }
  const rects = Array.from(byLine.values()).slice(0, MAX_LINES).map(unionRect);
  return { rects, score: best.score, count: hits.length };
}

// ---- placing a mark ----------------------------------------------------------
// ctx: { elements:[{id,name,type,rect(phys),isPassword}], ocr:{width,height,lines}|null,
//        cap:{width,height,pxWidth,pxHeight}, originPhys:{x,y} }
function imageToPhys(r, ocr, ctx) {
  const fx = ctx.cap.pxWidth / ocr.width, fy = ctx.cap.pxHeight / ocr.height;
  return { x: Math.round(ctx.originPhys.x + r.x * fx), y: Math.round(ctx.originPhys.y + r.y * fy), w: Math.max(1, Math.round(r.w * fx)), h: Math.max(1, Math.round(r.h * fy)) };
}
function physToImage(r, ocr, ctx) {
  const fx = ocr.width / ctx.cap.pxWidth, fy = ocr.height / ctx.cap.pxHeight;
  return { x: (r.x - ctx.originPhys.x) * fx, y: (r.y - ctx.originPhys.y) * fy, w: r.w * fx, h: r.h * fy };
}
const hasOcr = (ctx) => !!(ctx.ocr && ctx.ocr.width > 0 && ctx.ocr.height > 0 && ctx.ocr.lines && ctx.ocr.lines.length);
// Never a password, card or identity field (src/guide/sensitive.js), the same as the pointer.
const private_ = (el) => sensitiveTarget(el);

function elementByName(text, elements, near) {
  let best = null;
  for (const e of elements || []) {
    if (!e || !e.rect || !e.name || private_(e)) continue;
    const exact = norm(e.name) === norm(text);
    const score = exact ? 1 : tokenOverlap(e.name, text);
    if (score < 0.6) continue;
    // The shorter of two names that both hold the words is the closer match ("Save" over "Save As").
    const rank = score - Math.abs(norm(e.name).length - norm(text).length) / 200;
    const d = near ? Math.hypot(e.rect.x + e.rect.w / 2 - near.x, e.rect.y + e.rect.h / 2 - near.y) : 0;
    if (!best || rank > best.rank + 1e-9 || (Math.abs(rank - best.rank) < 1e-9 && d < best.d)) best = { e, rank, d };
  }
  return best ? best.e : null;
}

// A model box as fractions of the screen (or, as models sometimes write, pixels
// of the image they saw) -> physical rect, or null when it is not on the screen.
function bboxPhys(t, ctx) {
  let { x, y, w, h } = t;
  const img = ctx.cap;
  if ([x, y, w, h].every((v) => v >= 0) && w > 1.5 && h > 1.5 && img.width > 0) { x /= img.width; w /= img.width; y /= img.height; h /= img.height; }
  else if ([x, y, w, h].every((v) => v >= 0) && (x > 1.5 || y > 1.5) && w <= 1 && h <= 1 && img.width > 0) { x /= img.width; y /= img.height; }
  if (x < 0) { w += x; x = 0; }
  if (y < 0) { h += y; y = 0; }
  if (x + w > 1) w = 1 - x;
  if (y + h > 1) h = 1 - y;
  if (!(w > 0) || !(h > 0) || x >= 1 || y >= 1) return null;
  return { x: Math.round(ctx.originPhys.x + x * img.pxWidth), y: Math.round(ctx.originPhys.y + y * img.pxHeight), w: Math.round(w * img.pxWidth), h: Math.round(h * img.pxHeight) };
}

// One target -> { rects:[phys], verified, source, label } or null.
function placeTarget(target, shape, ctx) {
  if (!target) return null;
  if (target.kind === 'element') {
    // An id means something only when the model was shown the list it comes
    // from. A bare number that is no id is a number on the screen with its
    // quotes forgotten ("[CIRCLE:149]" for a total, publik-fast 2026-11-23).
    const el = ctx.ids === false ? null : (ctx.elements || []).find((e) => Number(e.id) === Number(target.id));
    if (!el) return placeTarget({ kind: 'words', text: String(target.id) }, shape, Object.assign({}, ctx, { elements: [] }));
    if (!el.rect || private_(el)) return null;
    // An underline goes under the control's own words when OCR sees them inside it.
    if (shape === 'underline' && el.name && hasOcr(ctx)) {
      const hit = findWords(el.name, ctx.ocr, { within: grow(physToImage(el.rect, ctx.ocr, ctx), 4) });
      if (hit) return { rects: hit.rects.map((r) => imageToPhys(r, ctx.ocr, ctx)), verified: true, source: 'element-words', label: el.name };
    }
    return { rects: [el.rect], verified: true, source: 'element', label: el.name || '' };
  }
  if (target.kind === 'words') {
    if (hasOcr(ctx)) {
      const hit = findWords(target.text, ctx.ocr, ctx.partial ? { partial: true } : {});
      if (hit) return { rects: hit.rects.map((r) => imageToPhys(r, ctx.ocr, ctx)), verified: true, source: 'words', label: target.text };
    }
    const el = elementByName(target.text, ctx.elements);
    return el ? { rects: [el.rect], verified: true, source: 'name', label: el.name } : null;
  }
  if (target.kind === 'bbox') {
    const box = bboxPhys(target, ctx);
    if (!box) return null;
    const c = centre(box);
    const reach = Math.max(140, Math.hypot(box.w, box.h));
    if (target.label && hasOcr(ctx)) {
      const hit = findWords(target.label, ctx.ocr, { near: centre(physToImage(box, ctx.ocr, ctx)) });
      if (hit) {
        const rects = hit.rects.map((r) => imageToPhys(r, ctx.ocr, ctx));
        const hc = centre(rects[0]);
        if (Math.hypot(hc.x - c.x, hc.y - c.y) <= reach) return { rects, verified: true, source: 'box-words', label: target.label };
      }
    }
    let over = null;
    for (const e of ctx.elements || []) {
      if (!e || !e.rect || private_(e)) continue;
      const v = iou(e.rect, box);
      if (v >= 0.3 && (!over || v > over.v)) over = { e, v };
    }
    if (over) return { rects: [over.e.rect], verified: true, source: 'box-element', label: over.e.name || target.label };
    if (target.label) {
      const el = elementByName(target.label, ctx.elements, c);
      if (el && Math.hypot(el.rect.x + el.rect.w / 2 - c.x, el.rect.y + el.rect.h / 2 - c.y) <= reach) return { rects: [el.rect], verified: true, source: 'box-name', label: el.name };
    }
    // A box round words with no label: the words whose middles are in it.
    if (hasOcr(ctx)) {
      const bi = physToImage(box, ctx.ocr, ctx);
      const lines = [];
      for (const line of ctx.ocr.lines) {
        const ws = (line.words || []).filter((w) => { const m = centre(w); return m.x >= bi.x && m.x <= bi.x + bi.w && m.y >= bi.y && m.y <= bi.y + bi.h; });
        if (ws.length) lines.push(unionRect(ws));
      }
      if (lines.length) {
        if (shape === 'underline') return { rects: lines.slice(0, MAX_LINES).map((r) => imageToPhys(r, ctx.ocr, ctx)), verified: true, source: 'box-text', label: target.label };
        // A ring or frame hugs the words, and may reach a little past them toward
        // the box that was asked for: the icons and bullets beside text are not words.
        return { rects: [reachToward(imageToPhys(unionRect(lines), ctx.ocr, ctx), box, BOX_REACH_PX)], verified: true, source: 'box-text', label: target.label };
      }
    }
    // Nothing Windows knows is there: a picture, a chart, a game. The model's
    // own box, marked as a guess. Never for an underline.
    if (shape === 'underline') return null;
    return { rects: [box], verified: false, source: 'model', label: target.label };
  }
  return null;
}
function grow(r, by) { return { x: r.x - by, y: r.y - by, w: r.w + by * 2, h: r.h + by * 2 }; }
// `inner` stretched toward `outer` on each side, by at most `max`; never shrunk.
function reachToward(inner, outer, max) {
  const x0 = Math.min(inner.x, Math.max(outer.x, inner.x - max)), y0 = Math.min(inner.y, Math.max(outer.y, inner.y - max));
  const x1 = Math.max(inner.x + inner.w, Math.min(outer.x + outer.w, inner.x + inner.w + max)), y1 = Math.max(inner.y + inner.h, Math.min(outer.y + outer.h, inner.y + inner.h + max));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function sane(rect, shape, ctx) {
  if (!rect || ![rect.x, rect.y, rect.w, rect.h].every(Number.isFinite)) return false;
  if (rect.w < MIN_SIDE_PX || rect.h < MIN_SIDE_PX) return false;
  const screenArea = ctx.cap.pxWidth * ctx.cap.pxHeight;
  return !(screenArea > 0 && (rect.w * rect.h) / screenArea > (MAX_AREA[shape] || 0.3));
}

// A parsed mark -> what the overlay draws, in physical pixels, or null:
//   { shape, rects:[{x,y,w,h}], verified, source, label }            underline, circle, box
//   { shape:'arrow', from:{x,y,w,h}, to:{x,y,w,h}, verified, source } arrow
function resolveMark(mark, ctx) {
  if (!mark || !SHAPES.has(mark.shape) || !ctx || !ctx.cap || !ctx.originPhys) return null;
  // The red pen places like an underline: on words or a control Windows reports, or not at all.
  const a = placeTarget(mark.target, mark.shape === 'arrow' ? 'circle' : PEN.has(mark.shape) ? 'underline' : mark.shape, PEN.has(mark.shape) ? Object.assign({}, ctx, { partial: true }) : ctx);
  if (!a) return null;
  if (PEN.has(mark.shape)) {
    if (!a.verified) return null;
    const lines = a.rects.filter((r) => sane(r, mark.shape, ctx));
    if (!lines.length) return null;
    const out = Object.assign({ shape: mark.shape, rects: lines, verified: true, source: a.source, label: clip(a.label || '', 80) }, mark.fix ? { fix: mark.fix } : {});
    // Words carry on to the right of the mistake (a sentence, a table row): the
    // fix is written above it, as a proofreader does, not over what comes next.
    if (mark.fix && wordsToTheRight(lines[lines.length - 1], mark.fix, ctx)) out.above = true;
    return out;
  }
  if (mark.shape === 'arrow') {
    const b = placeTarget(mark.to, 'circle', ctx);
    if (!b) return null;
    const from = a.rects[0], to = b.rects[0];
    if (!sane(from, 'arrow', ctx) || !sane(to, 'arrow', ctx)) return null;
    // An arrow from a thing to itself says nothing.
    if (iou(from, to) > 0.5) return null;
    const bow = arrowBow(from, to, ctx);
    return Object.assign({ shape: 'arrow', from, to, verified: a.verified && b.verified, source: a.source + '>' + b.source, label: clip((a.label || '') + ' → ' + (b.label || ''), 80) }, bow ? { bow } : {});
  }
  // A ring or a frame is one shape, however many lines the words run over.
  let rects = mark.shape === 'underline' ? a.rects : [a.rects.length > 1 ? unionRect(a.rects) : a.rects[0]];
  rects = rects.filter((r) => sane(r, mark.shape, ctx));
  if (!rects.length) return null;
  return { shape: mark.shape, rects, verified: a.verified, source: a.source, label: clip(a.label || '', 80) };
}

// Which way an arrow should bow so its line crosses the fewest words: 1, -1,
// or 0 when it makes no difference. The line is the overlay's own
// (renderer/marks.js arrowPoints), tried both ways over the word boxes.
function arrowBow(from, to, ctx) {
  if (!hasOcr(ctx)) return 0;
  let arrowPoints = null;
  try { ({ arrowPoints } = require('../../renderer/marks')); } catch (_) { return 0; }
  const words = [];
  for (const line of ctx.ocr.lines) for (const w of line.words || []) {
    const r = imageToPhys(w, ctx.ocr, ctx);
    // The two ends' own words are where it starts and stops, not in its way.
    if (iou(r, from) > 0 || iou(r, to) > 0) continue;
    words.push(r);
  }
  const crossed = (side) => {
    const a = arrowPoints(from, to, 1, side);
    if (!a) return 0;
    const hit = new Set();
    for (const p of a.shaft) words.forEach((r, i) => { if (p.x >= r.x - 2 && p.x <= r.x + r.w + 2 && p.y >= r.y - 2 && p.y <= r.y + r.h + 2) hit.add(i); });
    return hit.size;
  };
  const up = crossed(1), down = crossed(-1);
  return up === down ? 0 : (up < down ? 1 : -1);
}

// Is there writing where a fix of this length would go, just right of the rect?
function wordsToTheRight(rect, fix, ctx) {
  if (!hasOcr(ctx)) return false;
  const reach = String(fix).length * rect.h * 0.8 + 40;
  const x0 = rect.x + rect.w + 2, x1 = x0 + reach, mid = rect.y + rect.h / 2;
  for (const line of ctx.ocr.lines) for (const w of line.words || []) {
    const r = imageToPhys(w, ctx.ocr, ctx);
    if (r.x >= x0 && r.x <= x1 && r.y <= mid && r.y + r.h >= mid) return true;
  }
  return false;
}

// The same place marked twice is drawn once.
function sameMark(a, b) {
  if (!a || !b || a.shape !== b.shape) return false;
  if (a.shape === 'arrow') return iou(a.from, b.from) > 0.8 && iou(a.to, b.to) > 0.8;
  return iou(a.rects[0], b.rects[0]) > 0.8;
}

module.exports = { DRAW_RULES, PEN_RULES, SHAPES, MAX_MARKS, MAX_LINES, parseTarget, parseMarkTag, parseOcrWords, findWords, resolveMark, sameMark, bboxPhys, elementByName, norm };
