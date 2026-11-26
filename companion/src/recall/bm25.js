'use strict';
// A small keyword index with BM25 ranking, for the person's own notes and
// imported chats (vault.js, chats.js). No embeddings, no network: words in,
// ranked passages out. Documents can be added and removed one at a time, so a
// changed note is re-read without rebuilding everything.
//
// Pure Node, no dependencies.

const STOP = new Set(('a an and are as at be been but by can could did do does doing for from had has have how i if in into is it its '
  + 'just me my of on or our so than that the their them then there these they this to too us was we were what when where which who '
  + 'why will with would you your').split(/\s+/));
// The frame of an ask ("what did I ask Claude about ... last week"), dropped
// from questions only, so a note that is about Claude can still be found by it.
const ASK_STOP = new Set(('about across all any ask asked chat chats claude chatgpt gpt gemini conversation conversations tell told '
  + 'say said know show give find look week month year today yesterday last ago working work worked thing things stuff something '
  + 'vault note notes file files please nus nūs two both these those merge combine compare gap between talk talked talking '
  + 'remember recall search mention mentioned ever before').split(/\s+/));

// Words worth matching: lowercase, accents folded, short and common words gone,
// a plural "s" dropped so "chats" finds "chat".
function tokenize(text) {
  const out = [];
  const words = String(text || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().match(/[a-z0-9][a-z0-9'+#.-]*/g) || [];
  for (let w of words) {
    w = w.replace(/^[.'-]+|[.'-]+$/g, '').replace(/'s$/, '');
    if (w.length < 2 || w.length > 40 || STOP.has(w)) continue;
    // Hashes, ids and timestamps ("20261016t210747", "656e028") are nobody's
    // question and a third of a vault's distinct words.
    if (w.length > 12 && /\d/.test(w)) continue;
    if (/\d/.test(w) && /[a-z]/.test(w) && /^[0-9a-f]{7,}$/.test(w)) continue;
    if (w.length > 4 && w.endsWith('s') && !/(ss|us|is)$/.test(w)) w = w.slice(0, -1);   // chats -> chat, not radius -> radiu
    out.push(w);
  }
  return out;
}
// The words of a question that carry its topic: the same rules, the ask's own
// frame dropped, deduplicated.
function queryTerms(text) { return Array.from(new Set(tokenize(text).filter((t) => !ASK_STOP.has(t)))); }

// Memory matters more than speed here (a vault is thousands of notes and the
// app is always on): documents get small integer numbers, postings are flat
// arrays [doc, tf, doc, tf, ...], and a removed document is only marked dead
// until a third of the index is dead, then the postings are compacted.
function createIndex({ k1 = 1.2, b = 0.75 } = {}) {
  let lens = [], metas = [], alive = [];
  const keys = new Map();      // caller's id -> doc number
  const idOf = [];             // doc number -> caller's id
  let postings = new Map();    // term -> [doc, tf, ...]
  let totalLen = 0, live = 0, dead = 0;

  function remove(id) {
    const d = keys.get(id);
    if (d == null) return false;
    keys.delete(id);
    alive[d] = false; metas[d] = null; totalLen -= lens[d]; live--; dead++;
    if (dead > 1000 && dead > live / 2) compact();
    return true;
  }
  function compact() {
    const next = new Map();
    for (const [term, list] of postings) {
      const kept = [];
      for (let i = 0; i < list.length; i += 2) if (alive[list[i]]) kept.push(list[i], list[i + 1]);
      if (kept.length) next.set(term, kept.length > 32 ? Int32Array.from(kept) : kept);
    }
    postings = next; dead = 0;
  }
  function add(id, text, meta = {}) {
    remove(id);
    const tokens = tokenize(text);
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
    const d = lens.length;
    lens.push(tokens.length); metas.push(meta); alive.push(true); idOf.push(id);
    keys.set(id, d);
    for (const [term, n] of tf) {
      const list = postings.get(term);
      if (!list) postings.set(term, [d, n]);
      else if (Array.isArray(list)) list.push(d, n);
      else { const grown = Array.from(list); grown.push(d, n); postings.set(term, grown); }
    }
    totalLen += tokens.length; live++;
  }
  // -> [{ id, score, matched, meta }] best first. filter(meta, id) can drop docs.
  function search(query, { limit = 10, filter = null } = {}) {
    const terms = Array.isArray(query) ? query : queryTerms(query);
    if (!live || !terms.length) return [];
    const avg = totalLen / live || 1;
    const scores = new Map();
    const matched = new Map();
    for (const term of terms) {
      const list = postings.get(term);
      if (!list) continue;
      let df = 0;
      for (let i = 0; i < list.length; i += 2) if (alive[list[i]]) df++;
      if (!df) continue;
      const idf = Math.log(1 + (live - df + 0.5) / (df + 0.5));
      for (let i = 0; i < list.length; i += 2) {
        const d = list[i];
        if (!alive[d] || (filter && !filter(metas[d], idOf[d]))) continue;
        const tf = list[i + 1];
        scores.set(d, (scores.get(d) || 0) + idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * lens[d] / avg)));
        matched.set(d, (matched.get(d) || 0) + 1);
      }
    }
    return Array.from(scores, ([d, score]) => ({ id: idOf[d], score, matched: matched.get(d), meta: metas[d] }))
      .sort((x, y) => y.score - x.score || String(x.id).localeCompare(String(y.id)))
      .slice(0, limit);
  }
  // After a big batch of adds: long postings packed into typed arrays (a third of
  // the memory of growable ones; a short list stays a plain array, which is
  // smaller than a typed array's own overhead). A later add to a packed term
  // unpacks just that term.
  function seal() {
    for (const [term, list] of postings) if (Array.isArray(list) && list.length > 32) postings.set(term, Int32Array.from(list));
  }
  function clear() { lens = []; metas = []; alive = []; keys.clear(); idOf.length = 0; postings = new Map(); totalLen = 0; live = 0; dead = 0; }
  function ids() { return Array.from(keys.keys()); }
  function get(id) { const d = keys.get(id); return d == null ? null : metas[d]; }
  return { add, remove, search, seal, clear, ids, get, get size() { return live; }, get terms() { return postings.size; } };
}

// Long text -> passages of about `size` characters, cut at paragraph or
// sentence ends where it can, so a hit carries its own context.
function passages(text, size = 900) {
  const s = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!s) return [];
  if (s.length <= size * 1.3) return [s];
  const out = [];
  let buf = '';
  const flush = () => { if (buf.trim()) out.push(buf.trim()); buf = ''; };
  for (const para of s.split(/\n{2,}/)) {
    if (buf && buf.length + para.length > size) flush();
    if (para.length <= size * 1.3) { buf += (buf ? '\n\n' : '') + para; continue; }
    flush();
    const sentences = para.match(/[^.!?\n]+[.!?]*\s*|\n/g) || [para];
    for (const piece of sentences) {
      if (buf.length + piece.length > size) flush();
      if (piece.length <= size * 1.3) { buf += piece; continue; }
      for (let i = 0; i < piece.length; i += size) { buf = piece.slice(i, i + size); flush(); }
    }
    flush();
  }
  flush();
  return out;
}

module.exports = { createIndex, tokenize, queryTerms, passages, STOP, ASK_STOP };
