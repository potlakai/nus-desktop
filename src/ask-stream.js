'use strict';
// One ask, one model call. The model answers the student in prose and, when
// the request is something to do (a task, an event, a date move, a reminder,
// an email draft), ends with one tag:
//
//   [DO:add_task {"title": "...", "due_date": "2026-10-12", ...}]
//
// The prose streams to the screen as it arrives; the tag is held back and
// parsed when it closes (its JSON may contain brackets). A malformed tag is
// dropped, never shown. The old two-call path (an intent parse, then an
// answer) is gone: it doubled the wait and charged two question tickets.
//
// Pure JS: feed(text) returns the prose the new text completed, end() the
// rest; command() the parsed tag or null.

const TAG_HEAD = /\[\s*DO\s*:\s*([a-z][a-z_]{1,40})\s*/i;
const MAX_TAG = 6000;

function clip(s, n) { s = String(s == null ? '' : s).trim(); return s.length > n ? s.slice(0, n) : s; }

// Index just past the brace that closes raw[start] ('{'), string-aware, or -1.
function jsonEnd(raw, start) {
  let depth = 0, inString = false, escape = false;
  for (let i = start; i < raw.length; i++) {
    const c = raw[i];
    if (inString) { if (escape) escape = false; else if (c === '\\') escape = true; else if (c === '"') inString = false; continue; }
    if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i + 1; }
  }
  return -1;
}

class AskStream {
  constructor() { this.buf = ''; this.text = ''; this.cmd = null; this.ended = false; this.held = false; }

  feed(piece) {
    if (this.ended || !piece) return '';
    this.buf += piece;
    return this.drain(false);
  }

  end() {
    if (this.ended) return '';
    const out = this.drain(true);
    this.ended = true;
    return out;
  }

  // Prose before a tag goes out; from "[DO:" on, nothing is shown until the
  // tag closes (or the reply ends).
  drain(final) {
    let out = '';
    for (;;) {
      if (this.cmd) { this.buf = ''; break; }                 // one tag per reply; anything after it is noise
      const at = this.buf.search(/\[\s*DO\s*:/i);
      if (at < 0) {
        // No tag yet. A lone "[" at the tail may be a tag starting: hold it.
        const tail = this.buf.lastIndexOf('[');
        const safe = tail >= 0 && this.buf.length - tail < 6 && !final ? tail : this.buf.length;
        out += this.buf.slice(0, safe); this.text += this.buf.slice(0, safe);
        this.buf = this.buf.slice(safe);
        break;
      }
      out += this.buf.slice(0, at); this.text += this.buf.slice(0, at);
      this.buf = this.buf.slice(at);
      this.held = true;
      const m = TAG_HEAD.exec(this.buf);
      if (!m) { if (final || this.buf.length > MAX_TAG) { this.buf = ''; } break; }
      const i = m[0].length;
      if (i >= this.buf.length) { if (final) this.buf = ''; break; }
      if (this.buf[i] === ']') { this.cmd = { intent: m[1].toLowerCase(), args: {} }; this.buf = this.buf.slice(i + 1); continue; }
      if (this.buf[i] !== '{') { const close = this.buf.indexOf(']'); if (close < 0) { if (final) this.buf = ''; break; } this.buf = this.buf.slice(close + 1); continue; }
      const endJson = jsonEnd(this.buf, i);
      if (endJson < 0) { if (final || this.buf.length > MAX_TAG) this.buf = ''; break; }
      const close = this.buf.indexOf(']', endJson);
      if (close < 0) { if (final) this.buf = ''; break; }
      let args = null;
      try { args = JSON.parse(this.buf.slice(i, endJson)); } catch (_) { args = null; }
      if (args && typeof args === 'object') this.cmd = { intent: m[1].toLowerCase(), args };
      this.buf = this.buf.slice(close + 1);
    }
    return out;
  }

  command() { return this.cmd; }
  prose() { return this.text.replace(/\s+$/, '').replace(/^\s+/, ''); }
}

// One-shot: a whole reply -> { text, command }.
function parseAsk(raw) {
  const s = new AskStream();
  s.feed(String(raw == null ? '' : raw));
  s.end();
  return { text: s.prose(), command: s.command() };
}

module.exports = { AskStream, parseAsk, jsonEnd, clip };
