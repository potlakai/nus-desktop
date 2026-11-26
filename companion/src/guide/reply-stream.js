'use strict';
// The guide's streamed reply: spoken sentences first, then tags.
//
// The model writes one or two short sentences for the person, followed by
// tags on their own line:
//   [POINT:12]                          a control id from the list
//   [POINT:0.12,0.05,0.08,0.03:Insert]  a box in screen fractions plus the text on it
//   [POINT:none]                        nothing on this screen should be clicked
//   [CONF:0.8]  [DONE]  [NOTE:one short sentence]  [NEXT:step | step]
// An answer about the screen may also carry mark tags (src/guide/marks.js),
// read only when the stream is made with { marks: true }:
//   [UNDERLINE:"words"]  [CIRCLE:12]  [BOX:x,y,w,h:label]  [ARROW:a -> b]
//   [WRONG:"149" = 184]  [RIGHT:"x = 4"]   the red pen, for a check of someone's work
// A mark belongs to the sentence it follows (or sits in): it comes out as its
// own event, after that sentence, carrying the sentence's number, and never
// splits the sentence it sits in.
//
// Sentences are released as soon as they are complete, so speech and the
// bubble can start while the model is still writing the tags. Tags never
// reach the voice. Anything that is not well formed is dropped, never spoken.
// A reply that is a JSON object (the older contract) is passed through as one.
//
// Pure JS: feed(text) returns the events the new text completed, end()
// returns the rest, reply() the normalized object the validator expects.

const { parseMarkTag } = require('./marks');

const SENTENCE_END = /[.!?…]+["'”’)\]]*\s+/;
const MIN_CHUNK = 24;                 // sentences shorter than this merge with the next
const MAX_TAG = 220;
const TAG_RE = /^\[\s*(POINT|CONF|DONE|NOTE|NEXT|ANSWER)\s*(?::([^\]]*))?\]/i;
const MARK_RE = /^\[\s*(UNDERLINE|CIRCLE|BOX|ARROW|WRONG|RIGHT)\s*:([^\]]*)\]/i;
const THINK_OPEN = /<\s*thinking\s*>/i, THINK_CLOSE = /<\s*\/\s*thinking\s*>/i;
// Tool-call markup written out as text: nothing after it is spoken.
const LEAK_RE = /<\s*(?:[\w-]+:)?(?:function_calls\s*>|invoke\s+name\s*=|parameter\s+name\s*=|tool_(?:use|call|code)\b)/i;

function clip(s, n) { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

function parseTag(kind, body) {
  const k = kind.toUpperCase();
  const b = (body || '').trim();
  if (k === 'DONE') return { type: 'done' };
  if (k === 'ANSWER') return { type: 'answer' };
  if (k === 'CONF') { const v = Number(b); return Number.isFinite(v) ? { type: 'conf', value: Math.max(0, Math.min(1, v)) } : null; }
  if (k === 'NOTE') return b ? { type: 'note', text: clip(b, 200) } : null;
  if (k === 'NEXT') {
    const steps = b.split('|').map((s) => s.trim()).filter(Boolean).slice(0, 3).map((s) => {
      const m = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(s);
      return m ? { instruction: clip(m[1], 140), control: clip(m[2], 80) } : { instruction: clip(s, 140), control: '' };
    });
    return steps.length ? { type: 'next', steps } : null;
  }
  if (k === 'POINT') {
    if (!b || /^none$/i.test(b)) return { type: 'point', target: null };
    if (/^\d+$/.test(b)) return { type: 'point', target: { kind: 'element', id: Number(b) } };
    const m = /^(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*(?::\s*(.*))?$/.exec(b);
    if (m) {
      const [x, y, w, h] = [m[1], m[2], m[3], m[4]].map(Number);
      if ([x, y, w, h].every(Number.isFinite)) return { type: 'point', target: { kind: 'bbox', x, y, w, h, label: clip(m[5] || '', 80) } };
    }
    return null;
  }
  return null;
}

class ReplyStream {
  constructor({ minChunk = MIN_CHUNK, marks = false } = {}) {
    this.minChunk = minChunk;
    this.marks = !!marks;     // read mark tags; without it they are ordinary bracketed text
    this.heldMarks = [];      // marks met inside a sentence that has not gone out yet
    this.buf = '';
    this.pending = '';        // a short sentence waiting for the next one
    this.events = [];
    this.raw = '';
    this.muted = false;
    this.thinking = false;
    this.spoken = [];
    this.ended = false;
  }

  feed(text) {
    if (this.ended || !text) return [];
    this.raw += text;
    this.buf += text;
    return this.drain(false);
  }

  end() {
    if (this.ended) return [];
    const out = this.drain(true);
    out.push(...this.flushPending());
    // Marks whose sentence never went out (muted, or nothing was said): they still count.
    out.push(...this.releaseMarks());
    this.ended = true;
    return out;
  }

  // Walk the buffer: text up to a tag or a sentence end becomes speech,
  // tags become events. partial text stays in the buffer until more arrives.
  drain(final) {
    const out = [];
    let guard = 0;
    while (this.buf.length && guard++ < 10000) {
      if (this.thinking) {
        const close = this.buf.match(THINK_CLOSE);
        if (!close) { if (final) this.buf = ''; break; }
        this.buf = this.buf.slice(close.index + close[0].length);
        this.thinking = false;
        continue;
      }
      const open = this.buf.match(THINK_OPEN);
      const bracket = this.buf.indexOf('[');
      const leak = this.buf.match(LEAK_RE);
      // The nearest special thing decides what the text before it is.
      const cut = Math.min(...[open && open.index, bracket >= 0 ? bracket : null, leak && leak.index].filter((v) => v != null && v >= 0), Infinity);
      if (cut === Infinity) {
        // Plain text only: release whole sentences, keep the tail.
        this.pending += this.buf; this.buf = '';
        out.push(...this.releaseSentences());
        if (final) out.push(...this.flushPending());
        break;
      }
      if (cut > 0) {
        // Text up to a bracket: whole sentences go out now; the fragment waits
        // to see whether the bracket is a tag (then it is flushed) or text.
        this.pending += this.buf.slice(0, cut);
        this.buf = this.buf.slice(cut);
        out.push(...this.releaseSentences());
        continue;
      }
      if (open && open.index === 0) { this.buf = this.buf.slice(open[0].length); this.thinking = true; continue; }
      if (leak && leak.index === 0) { out.push(...this.flushPending()); this.muted = true; this.buf = ''; out.push({ type: 'leak' }); break; }
      // A tag starts here.
      const close = this.buf.indexOf(']');
      if (close < 0) {
        if (final) { this.buf = ''; break; }                                          // a half tag at the end is never spoken
        if (this.buf.length > MAX_TAG) { this.buf = this.buf.slice(1); continue; }   // never a tag: the bracket is text
        break;                                                                        // wait for the rest
      }
      const m = TAG_RE.exec(this.buf);
      if (m) {
        this.buf = this.buf.slice(m[0].length);
        out.push(...this.flushPending());
        const ev = parseTag(m[1], m[2]);
        if (ev) { this.events.push(ev); out.push(ev); }
        continue;
      }
      const mk = this.marks ? MARK_RE.exec(this.buf) : null;
      if (mk) {
        this.buf = this.buf.slice(mk[0].length);
        const ev = parseMarkTag(mk[1], mk[2]);
        // A mark that cannot be read is dropped, never spoken.
        if (ev) {
          this.events.push(ev);
          // Whole sentences in front of it go out first; a fragment keeps the mark with it.
          out.push(...this.releaseSentences());
          if (this.pending.trim()) this.heldMarks.push(ev);
          else { ev.sentence = Math.max(0, this.spoken.length - 1); out.push(ev); }
        }
        continue;
      }
      // Something in brackets that is not one of ours ("[1]", "[Ctrl+S]"): it is text.
      this.pending += this.buf.slice(0, close + 1);
      this.buf = this.buf.slice(close + 1);
    }
    return out;
  }

  // Whole sentences in the pending text go out, merged until they are worth
  // saying; a trailing fragment waits for more.
  releaseSentences() {
    const out = [];
    let chunk = '';
    for (;;) {
      const m = SENTENCE_END.exec(this.pending);
      if (!m) break;
      chunk += this.pending.slice(0, m.index + m[0].length);
      this.pending = this.pending.slice(m.index + m[0].length);
      // The first sentence of a reply goes out the moment it is complete,
      // however short: the prompts ask for a five-word opener ("Paris.",
      // "Opening Gmail.", "Click Insert, top left.") precisely so the first
      // word is heard at once, and holding it for sentence two to finish was
      // costing the whole of sentence two's generation time (2026-10-30).
      // Later short sentences still merge with the next so the voice does
      // not chop ("Almost there." + "Now press Save.").
      const first = this.spoken.length === 0;
      if (chunk.trim().length >= this.minChunk || (first && chunk.trim().length >= 6)) { out.push(...this.emit(chunk)); chunk = ''; }
    }
    if (chunk) this.pending = chunk + this.pending;
    return out;
  }

  emit(text) {
    const t = String(text).replace(/\s+/g, ' ').trim();
    if (!t || this.muted) return [];
    this.spoken.push(t);
    // Without marks a speech event is exactly what it has always been.
    if (!this.marks) return [{ type: 'speech', text: t }];
    return [{ type: 'speech', text: t, sentence: this.spoken.length - 1 }, ...this.releaseMarks()];
  }

  // The marks that were waiting for their sentence, numbered with it.
  releaseMarks() {
    if (!this.heldMarks.length) return [];
    const out = this.heldMarks;
    this.heldMarks = [];
    const n = Math.max(0, this.spoken.length - 1);
    for (const ev of out) ev.sentence = n;
    return out;
  }

  flushPending() {
    const t = this.pending;
    this.pending = '';
    return this.emit(t);
  }

  // The normalized reply the validator expects: { instruction, target, confidence, done, note, next }.
  reply() {
    const instruction = this.spoken.join(' ').trim();
    const point = this.events.find((e) => e.type === 'point');
    const conf = this.events.find((e) => e.type === 'conf');
    const note = this.events.find((e) => e.type === 'note');
    const next = this.events.find((e) => e.type === 'next');
    const done = this.events.some((e) => e.type === 'done');
    const answer = this.events.some((e) => e.type === 'answer');
    if (!instruction && !point && !done && !answer) return null;
    const out = {
      instruction,
      target: point ? point.target : null,
      confidence: conf ? conf.value : (point && point.target ? 0.75 : 0),
      done,
      note: note ? note.text : '',
      next: next ? next.steps : [],
    };
    if (answer) out.answer = true;
    return out;
  }
}

// One-shot: a complete reply string -> events and the normalized object.
function parseReply(raw, opts) {
  const rs = new ReplyStream(opts);
  rs.feed(String(raw == null ? '' : raw));
  rs.end();
  return { events: rs.events.slice(), spoken: rs.spoken.slice(), reply: rs.reply(), muted: rs.muted };
}

module.exports = { ReplyStream, parseReply, parseTag, MIN_CHUNK, SENTENCE_END };
