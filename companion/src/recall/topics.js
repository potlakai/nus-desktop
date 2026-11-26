'use strict';
// Topics across the imported chats (Home's map, beta): conversations grouped
// by what they are about, each group named by its most telling words.
//
// Vectors: a conversation's meaning vector (chats.js conversationVector, the
// mean of what the person wrote in it) when every chat has one, else keyword
// weights (tf-idf over the title and the person's own messages).
// Grouping: average-linkage clustering, merging the two closest groups until
// the closest pair is no longer alike (or the target count is reached), so a
// strong topic forms its own group and stray one-off chats stay small. Above
// 600 chats, k-means with a fixed start instead (the pairwise table grows too
// big). Names: title words most frequent in a group relative to all chats.
// Deterministic: the same chats give the same map. A navigation aid, not an
// analysis.
const { tokenize } = require('./bm25');

const MAX_TEXT = 4000;
const PAIRWISE_LIMIT = 600;

function normalize(v) {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}
const dense = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

// Conversation text the topics are read from: its title and what the person wrote.
function convText(c) {
  return (c.title + '\n' + c.messages.filter((m) => m.role === 'user').map((m) => m.text).join('\n')).slice(0, MAX_TEXT);
}

// tf-idf vectors over one shared vocabulary (the 2,000 commonest useful words).
function keywordVectors(convs) {
  const docs = convs.map((c) => tokenize(convText(c)));
  const df = new Map();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) || 0) + 1);
  const vocab = Array.from(df).filter(([, n]) => n >= 2 && n <= Math.max(2, convs.length * 0.5)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 2000).map(([t]) => t);
  const at = new Map(vocab.map((t, i) => [t, i]));
  return docs.map((d) => {
    const v = new Float32Array(Math.max(1, vocab.length));
    for (const t of d) if (at.has(t)) v[at.get(t)] += 1;
    for (const [t, i] of at) if (v[i]) v[i] *= Math.log(convs.length / df.get(t));
    return normalize(v);
  });
}

// Average linkage on cosine similarity. -> group number per vector.
function agglomerate(vectors, { target, minSimilarity }) {
  const n = vectors.length;
  const sim = Array.from({ length: n }, (_, i) => Float32Array.from(vectors, (v, j) => (i === j ? -Infinity : dense(vectors[i], v))));
  const size = new Array(n).fill(1);
  const alive = new Array(n).fill(true);
  const members = Array.from({ length: n }, (_, i) => [i]);
  let groups = n;
  while (groups > target) {
    let bi = -1, bj = -1, best = -Infinity;
    for (let i = 0; i < n; i++) {
      if (!alive[i]) continue;
      const row = sim[i];
      for (let j = i + 1; j < n; j++) if (alive[j] && row[j] > best) { best = row[j]; bi = i; bj = j; }
    }
    if (bi < 0 || best < minSimilarity) break;
    // Merge bj into bi; the merged row is the size-weighted mean (average linkage).
    for (let k = 0; k < n; k++) {
      if (!alive[k] || k === bi || k === bj) continue;
      const s = (sim[bi][k] * size[bi] + sim[bj][k] * size[bj]) / (size[bi] + size[bj]);
      sim[bi][k] = s; sim[k][bi] = s;
    }
    size[bi] += size[bj];
    members[bi].push(...members[bj]);
    alive[bj] = false;
    groups--;
  }
  const assign = new Array(n).fill(0);
  let g = 0;
  for (let i = 0; i < n; i++) if (alive[i]) { for (const m of members[i]) assign[m] = g; g++; }
  return assign;
}

function kmeans(vectors, k, iterations = 25) {
  const n = vectors.length;
  // Start: every (n/k)th vector in order, so the same input gives the same map.
  const centers = Array.from({ length: k }, (_, j) => Float32Array.from(vectors[Math.floor(j * n / k)]));
  let assign = new Array(n).fill(-1);
  for (let it = 0; it < iterations; it++) {
    const next = vectors.map((v) => { let bi = 0, bs = -Infinity; centers.forEach((c, j) => { const s = dense(v, c); if (s > bs) { bs = s; bi = j; } }); return bi; });
    const moved = next.some((a, i) => a !== assign[i]);
    assign = next;
    if (!moved) break;
    for (let j = 0; j < k; j++) {
      const c = new Float32Array(vectors[0].length);
      let any = false;
      vectors.forEach((v, i) => { if (assign[i] === j) { any = true; for (let d = 0; d < v.length; d++) c[d] += v[d]; } });
      if (any) centers[j] = normalize(c);
    }
  }
  return assign;
}

// The words that name a group: frequent in its titles (and, less, its text),
// rare elsewhere.
function labelFor(idx, titles, docs, dfTitle, dfText, total) {
  const score = new Map();
  const bump = (t, w) => score.set(t, (score.get(t) || 0) + w);
  for (const i of idx) {
    for (const t of new Set(titles[i])) bump(t, 2 * Math.log(1 + total / dfTitle.get(t)));
    for (const t of new Set(docs[i])) bump(t, 0.5 * Math.log(1 + total / dfText.get(t)));
  }
  return Array.from(score).filter(([t]) => t.length > 2 && !/^\d+$/.test(t))
    .map(([t, s]) => [t, s / idx.length])
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3).map(([t]) => t);
}

// convs: [{ id, title, created, updated, messages }]; vectorOf(c) -> Float32Array or null.
// -> { method, topics: [{ label, words, count, from, to, conversations: [{ id, title, date, source }] }] }, biggest first.
function topicMap(convs, { vectorOf = () => null, target = null, minSimilarity = null } = {}) {
  if (!convs.length) return { method: 'none', topics: [] };
  const given = convs.map(vectorOf);
  const meaning = given.every(Boolean);
  const vectors = meaning ? given.map((v) => normalize(Float32Array.from(v))) : keywordVectors(convs);
  const want = Math.max(1, Math.min(target || Math.round(Math.sqrt(convs.length)) + 2, 16, convs.length));
  const assign = want === 1 ? convs.map(() => 0)
    : convs.length <= PAIRWISE_LIMIT ? agglomerate(vectors, { target: want, minSimilarity: minSimilarity != null ? minSimilarity : (meaning ? 0.3 : 0.05) })
      : kmeans(vectors, want);
  const titles = convs.map((c) => tokenize(c.title));
  const docs = convs.map((c) => tokenize(convText(c)));
  const dfOf = (lists) => { const df = new Map(); for (const d of lists) for (const t of new Set(d)) df.set(t, (df.get(t) || 0) + 1); return df; };
  const dfTitle = dfOf(titles), dfText = dfOf(docs);
  for (const [t, n] of dfText) if (!dfTitle.has(t)) dfTitle.set(t, n);
  const byGroup = new Map();
  assign.forEach((g, i) => { if (!byGroup.has(g)) byGroup.set(g, []); byGroup.get(g).push(i); });
  const topics = Array.from(byGroup.values()).map((idx) => {
    const words = labelFor(idx, titles, docs, dfTitle, dfText, convs.length);
    const dates = idx.map((i) => String(convs[i].updated || convs[i].created || '').slice(0, 10)).filter(Boolean).sort();
    return {
      label: idx.length === 1 ? convs[idx[0]].title : (words.length ? words.join(', ') : convs[idx[0]].title),
      words,
      count: idx.length,
      from: dates[0] || null,
      to: dates[dates.length - 1] || null,
      conversations: idx.map((i) => ({ id: convs[i].id, title: convs[i].title, date: String(convs[i].updated || convs[i].created || '').slice(0, 10), source: convs[i].source }))
        .sort((a, b) => b.date.localeCompare(a.date)),
    };
  });
  topics.sort((a, b) => b.count - a.count || String(b.to).localeCompare(String(a.to)));
  return { method: meaning ? 'meaning' : 'keywords', topics };
}

module.exports = { topicMap, keywordVectors, kmeans, agglomerate };
