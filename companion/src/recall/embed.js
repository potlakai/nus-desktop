'use strict';
// Local text embeddings for search by meaning, next to the keyword index.
//
// Model: sentence-transformers/all-MiniLM-L6-v2 (Apache-2.0), the ONNX export
// with int8 weights (Xenova/all-MiniLM-L6-v2, onnx/model_quantized.onnx, 23 MB),
// the same model Odysseus loads through fastembed. 384 numbers per passage,
// mean-pooled and unit length, so a dot product is the cosine similarity.
// Run with onnxruntime-node on this machine's CPU: no network, no cloud.
//
// The tokenizer is BERT's uncased WordPiece, written out here (vocab.txt from
// the same model) so no tokenizer package is needed.
//
// When the runtime or the model files are missing, available() is false and
// search falls back to keywords alone. Nothing breaks.
const fs = require('fs');
const path = require('path');

const DIM = 384;
const MAX_TOKENS = 256;   // the model's trained length; longer passages are cut

function isPunct(cp) {
  if ((cp >= 33 && cp <= 47) || (cp >= 58 && cp <= 64) || (cp >= 91 && cp <= 96) || (cp >= 123 && cp <= 126)) return true;
  return /\p{P}/u.test(String.fromCodePoint(cp));
}
function isCjk(cp) {
  return (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x20000 && cp <= 0x2a6df) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0x2f800 && cp <= 0x2fa1f);
}

// BERT basic tokenization (uncased): lowercase, accents off, punctuation and
// CJK characters as their own words.
function basicTokens(text) {
  const s = String(text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const out = [];
  let cur = '';
  const flush = () => { if (cur) { out.push(cur); cur = ''; } };
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp === 0 || cp === 0xfffd || (cp < 32 && !/\s/.test(ch))) continue;
    if (/\s/.test(ch)) { flush(); continue; }
    if (isPunct(cp) || isCjk(cp)) { flush(); out.push(ch); continue; }
    cur += ch;
  }
  flush();
  return out;
}

function createTokenizer(vocabText) {
  const vocab = new Map();
  String(vocabText).split(/\r?\n/).forEach((t, i) => { if (t) vocab.set(t, i); });
  const id = (t) => vocab.get(t);
  const UNK = id('[UNK]'), CLS = id('[CLS]'), SEP = id('[SEP]');
  function wordPiece(word) {
    if (word.length > 100) return [UNK];
    const ids = [];
    let start = 0;
    while (start < word.length) {
      let end = word.length, found = null;
      while (start < end) {
        const piece = (start > 0 ? '##' : '') + word.slice(start, end);
        if (vocab.has(piece)) { found = vocab.get(piece); break; }
        end--;
      }
      if (found == null) return [UNK];
      ids.push(found);
      start = end;
    }
    return ids;
  }
  // -> [CLS] ...wordpieces... [SEP], at most max ids.
  function encode(text, max = MAX_TOKENS) {
    const ids = [CLS];
    for (const w of basicTokens(text)) {
      for (const p of wordPiece(w)) { if (ids.length >= max - 1) break; ids.push(p); }
      if (ids.length >= max - 1) break;
    }
    ids.push(SEP);
    return ids;
  }
  return { encode, wordPiece, size: vocab.size };
}

function defaultModelDir() {
  const candidates = [];
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'embed-models', 'all-MiniLM-L6-v2'));
  candidates.push(path.join(__dirname, '..', '..', '..', 'vendor', 'embed-models', 'all-MiniLM-L6-v2'));
  return candidates.find((d) => fs.existsSync(path.join(d, 'model_quantized.onnx'))) || candidates[candidates.length - 1];
}

// -> { available(), embed(texts) -> Promise<Float32Array[]>, dim, reason }.
function createEmbedder({ modelDir = defaultModelDir(), log = () => {}, threads = 2 } = {}) {
  let session = null, tokenizer = null, loading = null, reason = '';
  let ort = null;
  try { ort = require('onnxruntime-node'); } catch (e) { reason = 'onnxruntime-node is not installed'; }
  const files = { model: path.join(modelDir, 'model_quantized.onnx'), vocab: path.join(modelDir, 'vocab.txt') };
  if (ort && !(fs.existsSync(files.model) && fs.existsSync(files.vocab))) reason = 'model files missing in ' + modelDir;

  function available() { return Boolean(ort) && !reason; }
  function load() {
    if (session) return Promise.resolve();
    if (!available()) return Promise.reject(new Error(reason));
    if (!loading) {
      loading = (async () => {
        tokenizer = createTokenizer(fs.readFileSync(files.vocab, 'utf8'));
        session = await ort.InferenceSession.create(files.model, { intraOpNumThreads: threads, interOpNumThreads: 1, graphOptimizationLevel: 'all' });
        log('embeddings ready (all-MiniLM-L6-v2, ' + tokenizer.size + ' word pieces)');
      })().catch((e) => { reason = 'could not load the model: ' + e.message; loading = null; throw e; });
    }
    return loading;
  }

  // Texts -> unit vectors, in batches padded to the longest text in the batch.
  async function embed(texts, { batch = 16 } = {}) {
    await load();
    const out = [];
    for (let b = 0; b < texts.length; b += batch) {
      const enc = texts.slice(b, b + batch).map((t) => tokenizer.encode(t));
      const len = Math.max(...enc.map((e) => e.length));
      const n = enc.length;
      const ids = new BigInt64Array(n * len), mask = new BigInt64Array(n * len), types = new BigInt64Array(n * len);
      enc.forEach((e, i) => e.forEach((v, j) => { ids[i * len + j] = BigInt(v); mask[i * len + j] = 1n; }));
      const feeds = { input_ids: new ort.Tensor('int64', ids, [n, len]), attention_mask: new ort.Tensor('int64', mask, [n, len]) };
      if (session.inputNames.includes('token_type_ids')) feeds.token_type_ids = new ort.Tensor('int64', types, [n, len]);
      const result = await session.run(feeds);
      const hidden = result.last_hidden_state || result[session.outputNames[0]];
      const h = hidden.data;
      for (let i = 0; i < n; i++) {
        const v = new Float32Array(DIM);
        const count = enc[i].length;
        for (let j = 0; j < count; j++) { const off = (i * len + j) * DIM; for (let k = 0; k < DIM; k++) v[k] += h[off + k]; }
        let norm = 0;
        for (let k = 0; k < DIM; k++) { v[k] /= count; norm += v[k] * v[k]; }
        norm = Math.sqrt(norm) || 1;
        for (let k = 0; k < DIM; k++) v[k] /= norm;
        out.push(v);
      }
    }
    return out;
  }

  return { available, load, embed, dim: DIM, get reason() { return reason; }, modelDir };
}

function dot(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }

module.exports = { createEmbedder, createTokenizer, basicTokens, dot, DIM, MAX_TOKENS, defaultModelDir };
