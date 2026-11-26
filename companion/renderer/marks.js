// Marks: what an answer draws on the screen while it is spoken (0.1.38).
//
// Main places each mark on something Windows reports (src/guide/marks.js) and
// sends its rectangle; this file only draws. A mark is the Knot's own thread
// laid on the page: the same ink outline and white core as the strand, so it
// reads on a white document and on a dark editor alike, drawn on by hand in
// the time it takes to say a few words.
//
//   underline  a line just under the words, one stroke per line of text
//   circle     a loose ring that runs a little past where it began
//   box        a rounded frame round an area
//   arrow      a bowed line from one thing to another, with a head
//   wrong      the red pen: a ring round a short mistake (a line under a long
//              one) and the fix written beside it
//   right      the red pen's tick, after the words
//
// A mark main could not confirm against Windows (a picture, a chart) is drawn
// wider and lighter: it says "about here", not "exactly this". On a bright
// page (main says so, from the picture it took) the thread turns over: ink
// inside, white round it, so a line on a white document is a dark line.
//
// Pure geometry first (shared with the tests through module.exports), then a
// small SVG layer. Nothing here takes the mouse.
(function (root) {
  'use strict';

  const LOOK = { ink: 'rgb(13,15,25)', white: '#fff', core: 3.2, outline: 1.5 };
  const DRAW_MS = { underline: 420, circle: 560, box: 640, arrow: 520, head: 160, tick: 300 };
  // The fix the pen writes: its size, and how wide a letter of it is counted, for placing it.
  const NOTE = { size: 19, letter: 0.56, gap: 12, minSize: 15 };
  // A mistake this many times wider than it is tall gets a line under it; shorter, a ring.
  const RING_UP_TO = 9;
  const STAGGER_MS = 170;         // between marks that arrive together
  const FADE_MS = 260;

  // A small seeded generator, so a mark wobbles the same way every frame and
  // differently from the mark beside it.
  function rng(seed) {
    let a = (seed >>> 0) || 1;
    return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  // A line just under the words: a touch wavy, rising a hair at the end, the way a hand does it.
  function underlinePoints(rect, seed) {
    const r = rng(seed), n = clamp(Math.round(rect.w / 14), 6, 40);
    // Clear of the letters' feet: the stroke is about 6 px wide with its outline.
    const y0 = rect.y + rect.h + clamp(rect.h * 0.22, 4, 7);
    const phase = r() * Math.PI * 2, amp = Math.min(1.4, rect.h * 0.06);
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const u = i / n;
      pts.push({ x: rect.x - 2 + (rect.w + 4) * u, y: y0 + amp * Math.sin(u * 5 + phase) + 0.5 * amp * Math.sin(u * 13 + phase * 1.7) - u * 1.1 });
    }
    return pts;
  }

  // A loose ring round the rect that runs a little past where it began.
  function ringPoints(rect, seed, loose) {
    const r = rng(seed), n = 64;
    const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
    // Close on the sides: a ring round two words in a sentence must not take in
    // the letters of the words beside them (seen on "21 percent", 2026-11-23).
    const pad = loose ? 14 : 6;
    const rx = Math.max(14, rect.w / 2 * 1.05 + pad), ry = Math.max(12, rect.h / 2 * 1.28 + pad + 2);
    const start = -Math.PI * 0.78 + (r() - 0.5) * 0.3, sweep = Math.PI * 2 * 1.07;
    const wob = r() * 6;
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const u = i / n, a = start + sweep * u;
      const drift = 1 + 0.05 * u + 0.022 * Math.sin(u * 9 + wob);
      pts.push({ x: cx + rx * drift * Math.cos(a), y: cy + ry * drift * Math.sin(a) });
    }
    return pts;
  }

  // A rounded frame, drawn in one go from the top left, closing just past the start.
  function framePoints(rect, seed, loose) {
    const r = rng(seed);
    const pad = loose ? 14 : 9;
    const x = rect.x - pad, y = rect.y - pad, w = rect.w + pad * 2, h = rect.h + pad * 2;
    const rad = Math.min(12, w / 4, h / 4), steps = 6;
    const j = () => (r() - 0.5) * 1.6;
    const pts = [];
    const line = (px, py) => pts.push({ x: px + j(), y: py + j() });
    const arc = (cx, cy, a, b) => { for (let i = 1; i <= steps; i++) { const t = a + (b - a) * i / steps; pts.push({ x: cx + rad * Math.cos(t), y: cy + rad * Math.sin(t) }); } };
    const side = (x0, y0, x1, y1) => { const n = clamp(Math.round(Math.hypot(x1 - x0, y1 - y0) / 60), 1, 12); for (let i = 1; i <= n; i++) line(x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n); };
    pts.push({ x: x + rad, y });
    side(x + rad, y, x + w - rad, y); arc(x + w - rad, y + rad, -Math.PI / 2, 0);
    side(x + w, y + rad, x + w, y + h - rad); arc(x + w - rad, y + h - rad, 0, Math.PI / 2);
    side(x + w - rad, y + h, x + rad, y + h); arc(x + rad, y + h - rad, Math.PI / 2, Math.PI);
    side(x, y + h - rad, x, y + rad); arc(x + rad, y + rad, Math.PI, Math.PI * 1.5);
    // The overshoot that makes it a hand's.
    pts.push({ x: x + rad + Math.min(18, w * 0.12), y: y + 1.5 });
    return pts;
  }

  // Where the line from a rect's middle toward a point leaves the rect, pushed out by gap.
  function edgeToward(rect, to, gap) {
    const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
    const dx = to.x - cx, dy = to.y - cy, len = Math.hypot(dx, dy) || 1;
    const hx = rect.w / 2 + gap, hy = rect.h / 2 + gap;
    const t = Math.min(dx ? hx / Math.abs(dx) : Infinity, dy ? hy / Math.abs(dy) : Infinity);
    const k = Number.isFinite(t) ? Math.min(t, 1) : 0;
    return { x: cx + dx * k, y: cy + dy * k, ux: dx / len, uy: dy / len };
  }

  // A bowed line from one rect to another and the two strokes of its head.
  // -> { shaft:[pts], head:[[pts],[pts]] } or null when they touch.
  // side: 1 or -1 picks which way it bows (main chooses the side with fewer
  // words under the line); without it the seed decides.
  function arrowPoints(from, to, seed, side) {
    const r = rng(seed);
    const c1 = { x: from.x + from.w / 2, y: from.y + from.h / 2 }, c2 = { x: to.x + to.w / 2, y: to.y + to.h / 2 };
    const a = edgeToward(from, c2, 6), b = edgeToward(to, c1, 9);
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
    // The two ends must leave room for a line between them, and still point the same way.
    if (len < 18 || dx * (c2.x - c1.x) + dy * (c2.y - c1.y) <= 0) return null;
    const nx = -dy / len, ny = dx / len;
    const coin = r() < 0.5 ? 1 : -1;
    const bow = clamp(len * 0.14, 6, 46) * (side === 1 || side === -1 ? side : coin);
    const mid = { x: (a.x + b.x) / 2 + nx * bow, y: (a.y + b.y) / 2 + ny * bow };
    const n = clamp(Math.round(len / 16), 8, 40);
    const shaft = [];
    for (let i = 0; i <= n; i++) {
      const u = i / n, v = 1 - u;
      shaft.push({ x: v * v * a.x + 2 * v * u * mid.x + u * u * b.x, y: v * v * a.y + 2 * v * u * mid.y + u * u * b.y });
    }
    // The head follows the line's last direction, not the straight one.
    const tx = b.x - mid.x, ty = b.y - mid.y, tl = Math.hypot(tx, ty) || 1;
    const ux = tx / tl, uy = ty / tl, size = clamp(len * 0.16, 9, 16), spread = 0.5;
    const wing = (s) => { const cs = Math.cos(s), sn = Math.sin(s); return { x: b.x - size * (ux * cs - uy * sn), y: b.y - size * (uy * cs + ux * sn) }; };
    return { shaft, head: [[wing(spread), { x: b.x, y: b.y }], [wing(-spread), { x: b.x, y: b.y }]] };
  }

  const f1 = (v) => (Math.round(v * 10) / 10).toString();
  function toPath(points) {
    if (!points || points.length < 2) return '';
    return 'M' + f1(points[0].x) + ' ' + f1(points[0].y) + points.slice(1).map((p) => 'L' + f1(p.x) + ' ' + f1(p.y)).join('');
  }

  const okRect = (r) => !!r && [r.x, r.y, r.w, r.h].every(Number.isFinite) && r.w > 0 && r.h > 0;

  // One mark -> the strokes to draw, in order: [{ d, ms, delay }]. Empty when it cannot be drawn.
  function strokesFor(mark, seed) {
    if (!mark) return [];
    const loose = mark.verified === false;
    if (mark.shape === 'arrow') {
      if (!okRect(mark.from) || !okRect(mark.to)) return [];
      const a = arrowPoints(mark.from, mark.to, seed, mark.bow);
      if (!a) return [];
      return [{ d: toPath(a.shaft), ms: DRAW_MS.arrow, delay: 0 }, { d: toPath(a.head[0]), ms: DRAW_MS.head, delay: DRAW_MS.arrow - 40 }, { d: toPath(a.head[1]), ms: DRAW_MS.head, delay: DRAW_MS.arrow + 30 }];
    }
    const rects = (mark.rects || []).filter(okRect);
    if (!rects.length) return [];
    if (mark.shape === 'underline') return rects.map((r, i) => ({ d: toPath(underlinePoints(r, seed + i * 7)), ms: DRAW_MS.underline, delay: i * (DRAW_MS.underline - 90) }));
    if (mark.shape === 'circle') return [{ d: toPath(ringPoints(rects[0], seed, loose)), ms: DRAW_MS.circle, delay: 0 }];
    if (mark.shape === 'box') return [{ d: toPath(framePoints(rects[0], seed, loose)), ms: DRAW_MS.box, delay: 0 }];
    if (mark.shape === 'wrong') {
      const short = rects.length === 1 && rects[0].w <= rects[0].h * RING_UP_TO;
      if (short) return [{ d: toPath(ringPoints(rects[0], seed, false)), ms: DRAW_MS.circle, delay: 0 }];
      return rects.map((r, i) => ({ d: toPath(underlinePoints(r, seed + i * 7)), ms: DRAW_MS.underline, delay: i * (DRAW_MS.underline - 90) }));
    }
    if (mark.shape === 'right') return [{ d: toPath(tickPoints(rects[rects.length - 1])), ms: DRAW_MS.tick, delay: 0 }];
    return [];
  }

  // A tick just after the words, as tall as they are.
  function tickPoints(rect) {
    const s = clamp(rect.h * 1.1, 12, 26), x = rect.x + rect.w + 8, y = rect.y + rect.h / 2;
    return [{ x, y: y + s * 0.05 }, { x: x + s * 0.32, y: y + s * 0.42 }, { x: x + s * 0.95, y: y - s * 0.55 }];
  }

  // Where the fix is written for a mistake: beside it on the right when there
  // is room on the screen, else under it. view: { w, h } of the overlay.
  // -> { x, y, size, text } with x,y the text's left end and its baseline.
  function notePlace(mark, view) {
    const text = String(mark && mark.fix ? mark.fix : '').trim();
    const rects = ((mark && mark.rects) || []).filter(okRect);
    if (!text || !rects.length) return null;
    const last = rects[rects.length - 1];
    const size = clamp(last.h * 1.15, NOTE.minSize, NOTE.size + 5);
    const width = text.length * size * NOTE.letter;
    const short = rects.length === 1 && last.w <= last.h * RING_UP_TO;
    // Clear of the ring, which stands a little out from the words.
    const reach = short ? 16 : 6;
    const W = (view && view.w) || Infinity, H = (view && view.h) || Infinity;
    // above: the line carries on to the right, so the fix goes over the mistake, a little smaller.
    if (mark.above) {
      const first = rects[0];
      const small = clamp(first.h * 0.95, NOTE.minSize - 1, NOTE.size);
      const w2 = text.length * small * NOTE.letter;
      const ya = first.y - (short ? 13 : 5);
      if (ya - small > 2) return { x: Math.max(8, Math.min(first.x, W - 8 - w2)), y: ya, size: small, text };
    }
    let x = last.x + last.w + reach + NOTE.gap, y = last.y + last.h / 2 + size * 0.34;
    if (mark.above || x + width > W - 8) { x = Math.max(8, Math.min(last.x, W - 8 - width)); y = last.y + last.h + (short ? 18 : 12) + size; }
    if (y > H - 6) y = Math.max(size + 4, last.y - (short ? 16 : 8));
    return { x, y, size, text };
  }

  // ---- the layer ---------------------------------------------------------------
  // doc: the overlay's document. opts.reduced(): true when motion is reduced.
  function createLayer(doc, opts) {
    const NS = 'http://www.w3.org/2000/svg';
    const reduced = (opts && opts.reduced) || (() => false);
    let svg = null, count = 0, queueUntil = 0;
    const timers = new Set();
    const later = (fn, ms) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); return t; };
    function ensure() {
      if (svg && svg.isConnected) return svg;
      svg = doc.createElementNS(NS, 'svg');
      svg.setAttribute('id', 'marks-layer');
      svg.setAttribute('aria-hidden', 'true');
      doc.body.appendChild(svg);
      return svg;
    }
    function put(mark) {
      const strokes = strokesFor(mark, 97 + count * 131);
      if (!strokes.length) return false;
      count += 1;
      const g = doc.createElementNS(NS, 'g');
      // light: the page under the mark is bright, so the thread turns over, ink inside and white round it.
      g.setAttribute('class', 'mark mark-' + mark.shape + (mark.verified === false ? ' mark-loose' : '') + (mark.light ? ' mark-on-light' : ''));
      let inkedFor = 0;
      const still = reduced();
      for (const s of strokes) {
        for (const layer of ['ink', 'core']) {
          const p = doc.createElementNS(NS, 'path');
          p.setAttribute('d', s.d);
          p.setAttribute('class', 'mark-' + layer);
          p.setAttribute('pathLength', '100');
          if (!still) { p.style.animationDuration = s.ms + 'ms'; p.style.animationDelay = s.delay + 'ms'; } else p.classList.add('mark-still');
          g.appendChild(p);
        }
        inkedFor = Math.max(inkedFor, s.delay + s.ms);
      }
      // The fix, written beside the mistake once the pen has gone round it.
      const note = mark.shape === 'wrong' ? notePlace(mark, { w: (doc.documentElement && doc.documentElement.clientWidth) || 0, h: (doc.documentElement && doc.documentElement.clientHeight) || 0 }) : null;
      if (note) {
        const t = doc.createElementNS(NS, 'text');
        t.setAttribute('class', 'mark-note' + (still ? ' mark-still' : ''));
        t.setAttribute('x', f1(note.x)); t.setAttribute('y', f1(note.y));
        t.setAttribute('font-size', f1(note.size));
        t.setAttribute('transform', 'rotate(-2.5 ' + f1(note.x) + ' ' + f1(note.y) + ')');
        if (!still) t.style.animationDelay = Math.max(0, inkedFor - 120) + 'ms';
        t.textContent = note.text;
        g.appendChild(t);
      }
      ensure().appendChild(g);
      return true;
    }
    return {
      // Marks that arrive together are drawn one after another, not all at once.
      draw(mark) {
        const now = Date.now();
        const wait = Math.max(0, queueUntil - now);
        queueUntil = Math.max(now, queueUntil) + STAGGER_MS;
        if (wait <= 0) return put(mark);
        later(() => put(mark), wait);
        return true;
      },
      clear(fast) {
        for (const t of timers) clearTimeout(t);
        timers.clear();
        queueUntil = 0; count = 0;
        const old = svg;
        svg = null;
        if (!old) return;
        if (fast || reduced()) { old.remove(); return; }
        old.classList.add('leaving');
        setTimeout(() => old.remove(), FADE_MS);
      },
      count() { return count; },
    };
  }

  const api = { LOOK, DRAW_MS, STAGGER_MS, FADE_MS, NOTE, underlinePoints, ringPoints, framePoints, arrowPoints, tickPoints, notePlace, edgeToward, toPath, strokesFor, createLayer };
  root.NusMarks = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
