'use strict';
// Word error rate, for the dictation transcript check (scripts/dictate-check.js).
// Words are compared lower case with punctuation dropped, so "Hello, there."
// against "hello there" is no error, and a hyphen is a space ("to-do" against
// "to do" is no error); an apostrophe inside a word stays part of it.
// WER = (substitutions + deletions + insertions) / reference words.

function words(text) {
  return String(text || '').toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^\p{L}\p{N}'\s]/gu, ' ')
    .replace(/(^|\s)'+|'+(?=\s|$)/g, ' ')
    .split(/\s+/).filter(Boolean);
}

// -> { ref, hyp, sub, del, ins, errors, wer }
function wer(reference, hypothesis) {
  const r = words(reference), h = words(hypothesis);
  const n = r.length, m = h.length;
  // d[i][j]: [cost, sub, del, ins] for r[0..i) against h[0..j)
  let prev = [];
  for (let j = 0; j <= m; j++) prev.push([j, 0, 0, j]);
  for (let i = 1; i <= n; i++) {
    const row = [[i, 0, i, 0]];
    for (let j = 1; j <= m; j++) {
      const same = r[i - 1] === h[j - 1];
      const diag = prev[j - 1], up = prev[j], left = row[j - 1];
      const cands = [
        [diag[0] + (same ? 0 : 1), diag[1] + (same ? 0 : 1), diag[2], diag[3]],
        [up[0] + 1, up[1], up[2] + 1, up[3]],
        [left[0] + 1, left[1], left[2], left[3] + 1],
      ];
      cands.sort((a, b) => a[0] - b[0]);
      row.push(cands[0]);
    }
    prev = row;
  }
  const [errors, sub, del, ins] = prev[m];
  return { ref: n, hyp: m, sub, del, ins, errors, wer: n ? errors / n : (m ? 1 : 0) };
}

// Many pairs at once: errors over all reference words (not the mean of rates).
function total(pairs) {
  let ref = 0, errors = 0, exact = 0;
  for (const p of pairs) { const w = wer(p.ref, p.hyp); ref += w.ref; errors += w.errors; if (w.errors === 0) exact++; }
  return { pairs: pairs.length, ref, errors, exact, wer: ref ? errors / ref : 0 };
}

module.exports = { words, wer, total };
