'use strict';
// The agent's streamed reply: spoken prose first, then tags.
//
//   [GOAL: find remote design jobs on indeed]   opens a task that runs until [DONE]
//   [DO:click {"id": 12}]                       an action; several may follow each other
//   [DONE]                                      the goal is met (checked before it is believed)
//
// Prose before the first tag streams to the voice as sentences; everything
// from the first tag on is parsed when the reply is complete. Malformed tags
// are dropped. Tool-call markup written as text mutes the rest.

const SENTENCE_END = /[.!?…]+["'”’)\]]*\s+/;
const TAG_START = /\[\s*(?:DO|DONE)\b/i;
const GOAL_OPEN = /\[\s*GOAL\b/i;
const GOAL_RE = /\[\s*GOAL\s*:\s*([^\]]{1,200})\]/i;
const DONE_RE = /\[\s*DONE\s*\]/i;
const DO_HEAD = /\[\s*DO\s*:\s*([a-z][a-z_]{1,40})\s*/gi;
const LEAK_RE = /<\s*(?:[\w-]+:)?(?:function_calls\s*>|invoke\s+name\s*=|parameter\s+name\s*=|tool_(?:use|call|code)\b)/i;
const MIN_CHUNK = 24;

function jsonEnd(raw, start) {
  let depth = 0, inString = false, escape = false;
  for (let i = start; i < raw.length; i++) {
    const c = raw[i];
    if (inString) { if (escape) escape = false; else if (c === '\\') escape = true; else if (c === '"') inString = false; continue; }
    if (c === '"') inString = true; else if (c === '{') depth++; else if (c === '}') { depth--; if (depth === 0) return i + 1; }
  }
  return -1;
}

// Every [DO:name {json}] in order, plus goal and done.
function parseTags(raw) {
  const s = String(raw || '');
  const out = { goal: null, done: false, actions: [], muted: false, emptyType: false };
  const leak = LEAK_RE.exec(s);
  const text = leak ? s.slice(0, leak.index) : s;
  if (leak) out.muted = true;
  const g = GOAL_RE.exec(text); if (g) out.goal = g[1].replace(/\s+/g, ' ').trim();
  out.done = DONE_RE.test(text);
  DO_HEAD.lastIndex = 0;
  let m;
  // A type with nothing to type is the model not knowing what the user wants
  // said (live 2026-10-11: [DO:type {"text": ""}]). It is dropped here and
  // flagged, so the agent tells the model to ask instead.
  const push = (name, args) => { if (name === 'type' && !String(args.text == null ? '' : args.text).trim()) { out.emptyType = true; return; } out.actions.push({ name, args }); };
  while ((m = DO_HEAD.exec(text))) {
    const name = m[1].toLowerCase();
    const i = m.index + m[0].length;
    if (text[i] === ']') { push(name, {}); continue; }
    if (text[i] !== '{') continue;
    const end = jsonEnd(text, i);
    if (end < 0) break;
    try { const args = JSON.parse(text.slice(i, end)); if (args && typeof args === 'object') push(name, args); } catch (_) { /* dropped */ }
    DO_HEAD.lastIndex = end;
  }
  return out;
}

// Streams the prose that comes before the first tag, sentence by sentence.
class AgentStream {
  constructor() { this.buf = ''; this.raw = ''; this.pending = ''; this.spoken = []; this.tagged = false; this.ended = false; }
  feed(piece) {
    if (this.ended || !piece) return [];
    this.raw += piece;
    if (this.tagged) return [];
    this.buf += piece;
    const out = [];
    // The goal tag is bookkeeping, not speech: once it is complete it is cut
    // out and the prose after it keeps streaming. A half-written one waits.
    const g = this.buf.search(GOAL_OPEN);
    if (g >= 0) {
      const close = this.buf.indexOf(']', g);
      if (close < 0) { const head = this.buf.slice(0, g); this.pending += head; this.buf = this.buf.slice(g); out.push(...this.release(false)); return out; }
      this.buf = this.buf.slice(0, g) + this.buf.slice(close + 1);
    }
    const at = this.buf.search(TAG_START);
    if (at >= 0) { this.pending += this.buf.slice(0, at); this.buf = ''; this.tagged = true; out.push(...this.release(true)); return out; }
    // A lone "[" at the tail may be a tag starting: hold it.
    const tail = this.buf.lastIndexOf('[');
    const safe = tail >= 0 && this.buf.length - tail < 8 ? tail : this.buf.length;
    this.pending += this.buf.slice(0, safe); this.buf = this.buf.slice(safe);
    out.push(...this.release(false));
    return out;
  }
  end() {
    if (this.ended) return [];
    this.ended = true;
    if (!this.tagged) { this.pending += this.buf; this.buf = ''; }
    return this.release(true);
  }
  release(final) {
    const out = [];
    let chunk = '';
    for (;;) {
      const m = SENTENCE_END.exec(this.pending);
      if (!m) break;
      chunk += this.pending.slice(0, m.index + m[0].length);
      this.pending = this.pending.slice(m.index + m[0].length);
      if (chunk.trim().length >= MIN_CHUNK) { out.push(...this.emit(chunk)); chunk = ''; }
    }
    if (chunk) this.pending = chunk + this.pending;
    if (final) { out.push(...this.emit(this.pending)); this.pending = ''; }
    return out;
  }
  emit(text) {
    const t = String(text).replace(/\s+/g, ' ').trim();
    if (!t || LEAK_RE.test(t)) return [];
    this.spoken.push(t);
    return [t];
  }
  tags() { return parseTags(this.raw); }
  prose() { return this.spoken.join(' ').trim(); }
}

module.exports = { AgentStream, parseTags, jsonEnd };
