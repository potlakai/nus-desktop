'use strict';
// PAID. Does the brain write marks that can be placed? The answer prompt with drawing on
// (src/guide/screen-answer.js + src/guide/marks.js DRAW_RULES), on the four neutral pages in
// shots/, on publik-fast and publik-smart. Spends from the signed-in Publik balance on this
// computer, so it refuses to run without both --yes and --cap-cents, and stops before the next
// call once the wallet shows the cap spent (the balance is read before every call). The key is
// never printed.
//
//   node companion/test/ask-routing/draw-check.js --yes --cap-cents 15 --out <dir>
//
// For each ask and tier: the reply, how many marks it asked for, how many were readable tags,
// how many could be placed on the words Windows OCR reads off the same picture (no control list:
// the pages are pictures here, so ids are never offered), and the tokens it cost next to the
// same ask with drawing off. Writes <dir>/draw-check.json and <dir>/draw-check.html, a sheet with
// every answer's marks drawn on its page by the overlay's own strokes, to be looked at.
// Windows only (the word read is Windows OCR).
//
// FREE: --rescore <draw-check.json> --out <dir> places the replies saved by an earlier run again
// (after a change to the tag reading or the placing) and rewrites the sheet. No model, no balance.
const fs = require('fs');
const path = require('path');
const { buildScreenAnswer } = require('../../src/guide/screen-answer');
const { parseReply } = require('../../src/guide/reply-stream');
const { resolveMark, parseOcrWords } = require('../../src/guide/marks');
const { ocrFile } = require('../../src/win/ocr');

const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
const CAP_CENTS = Number(arg('--cap-cents'));
const OUT = arg('--out');
const RESCORE = arg('--rescore');
if (RESCORE ? !OUT : (!process.argv.includes('--yes') || !(CAP_CENTS > 0) || !OUT)) {
  console.error('Paid check. Needs Pranav\'s typed yes: --yes --cap-cents N --out dir');
  process.exit(2);
}

const SHOTS = path.join(__dirname, 'shots');
const WIN = { article: { title: 'Why sleep helps you remember - Study Notes Weekly', process: 'chrome' }, dialog: { title: 'Lab3 report.docx - Editor', process: 'editor' }, settings: { title: 'Settings', process: 'systemsettings' }, sheet: { title: 'Club budget.xlsx - Sheets', process: 'sheets' } };
const ASKS = [
  ['article', 'summarize', 'summarize what is going on here'],
  ['article', 'ask', 'what is the main number in this article'],
  ['dialog', 'explain', 'explain this error'],
  ['dialog', 'ask', 'what should I do here'],
  ['settings', 'ask', 'is dark mode on'],
  ['settings', 'ask', 'what is this page for'],
  ['sheet', 'check', 'is this total right'],
  ['sheet', 'ask', "what's this table showing"],
];
const TIERS = (arg('--tiers') || 'publik-fast,publik-smart').split(',');
const PLAIN_FOR = new Set(['explain this error', 'is this total right']);   // the same ask with drawing off, for the cost

function pngSize(file) { const b = fs.readFileSync(file); return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }; }

async function main() {
  const saved = RESCORE ? JSON.parse(fs.readFileSync(RESCORE, 'utf8')) : null;
  let balance = async () => 0, client = null, start = 0;
  if (!saved) {
    const publik = require('../../src/publik');
    const mod = publik.module;
    const p = publik.provider();
    if (!p) { console.error('No publik provider on this computer (not signed in, or own key chosen).'); process.exit(3); }
    const cred = mod.readCredential();
    balance = async () => { const r = await mod.readWallet(cred.key); return r.wallet ? r.wallet.balance_micros : null; };
    const OpenAI = require('openai');
    client = new OpenAI({ apiKey: p.apiKey, baseURL: p.baseURL });
    start = await balance();
    if (start == null) { console.error('Could not read the wallet; not spending blind.'); process.exit(4); }
  }
  const capMicros = CAP_CENTS * 10000;
  fs.mkdirSync(OUT, { recursive: true });

  // The words on each page, read once, free and local.
  const pages = {};
  for (const shot of Object.keys(WIN)) {
    const file = path.join(SHOTS, shot + '.png');
    const size = pngSize(file);
    const raw = await ocrFile(file, true);
    const nl = raw.indexOf('\n');
    const ocr = Object.assign({ width: size.width, height: size.height }, parseOcrWords(nl < 0 ? '' : raw.slice(nl + 1)));
    pages[shot] = { file, size, ocr, dataUrl: 'data:image/png;base64,' + fs.readFileSync(file).toString('base64') };
    console.log(shot + ': ' + size.width + 'x' + size.height + ', ' + ocr.lines.reduce((n, l) => n + l.words.length, 0) + ' words read');
  }

  async function call(model, q, shot, ask) {
    if (saved) { const old = saved.rows.find((r) => r.model === model && r.shot === shot && r.ask === ask && r.draw === q.draw); return old ? { ms: old.ms, text: old.text, usage: old.usage, error: old.error } : { skipped: 'not in the saved run' }; }
    const now = await balance();
    const spent = now == null ? null : start - now;
    if (spent == null || spent >= capMicros) return { skipped: 'cap reached or wallet unreadable', spentMicros: spent };
    const t0 = Date.now();
    try {
      const r = await client.chat.completions.create({ model, max_tokens: q.maxTokens, messages: [{ role: 'system', content: q.system }, { role: 'user', content: [{ type: 'text', text: q.text }, { type: 'image_url', image_url: { url: pages[shot].dataUrl } }] }] });
      return { ms: Date.now() - t0, text: (r.choices[0] && r.choices[0].message && r.choices[0].message.content) || '', usage: r.usage || null };
    } catch (e) { return { ms: Date.now() - t0, error: String(e.status || '') + ' ' + String(e.message || e).slice(0, 200) }; }
  }

  const rows = [];
  for (const [shot, mode, ask] of ASKS) {
    const pg = pages[shot];
    const ctx = { elements: [], ocr: pg.ocr, cap: { width: pg.size.width, height: pg.size.height, pxWidth: pg.size.width, pxHeight: pg.size.height }, originPhys: { x: 0, y: 0 }, ids: false };
    for (const model of TIERS) {
      const q = buildScreenAnswer({ ask, mode, window: WIN[shot], draw: true, elements: null });
      const r = await call(model, q, shot, ask);
      const row = { shot, mode, ask, model, draw: true, ...r };
      if (r.text != null) {
        const tagsWritten = (r.text.match(/\[(?:UNDERLINE|CIRCLE|BOX|ARROW)\b/gi) || []).length;
        const parsed = parseReply(r.text, { marks: true });
        const marks = parsed.events.filter((e) => e.type === 'mark');
        const placed = marks.map((m) => ({ mark: m, at: resolveMark(m, ctx) }));
        Object.assign(row, { spoken: parsed.spoken.join(' '), tagsWritten, readable: marks.length, placed: placed.filter((x) => x.at).length, verified: placed.filter((x) => x.at && x.at.verified).length,
          tagLeak: /\[|\]/.test(parsed.spoken.join(' ')), marks: placed.map((x) => ({ shape: x.mark.shape, target: x.mark.target, to: x.mark.to, sentence: x.mark.sentence, at: x.at })) });
      }
      rows.push(row);
      console.log(model.padEnd(13) + (r.ms || '-') + ' ms  ' + ask + '  marks ' + (row.readable == null ? '-' : row.placed + '/' + row.readable + ' placed of ' + row.tagsWritten + ' written') + '\n    ' + String(r.text || r.error || r.skipped).replace(/\s+/g, ' ').slice(0, 320));
      if (PLAIN_FOR.has(ask)) {
        const plain = await call(model, buildScreenAnswer({ ask, mode, window: WIN[shot] }), shot, ask);
        rows.push({ shot, mode, ask, model, draw: false, ...plain });
      }
    }
  }
  const end = await balance();
  const report = saved
    ? { at: saved.at, rescoredAt: new Date().toISOString(), capCents: saved.capCents, spentMicros: saved.spentMicros, rows }
    : { at: new Date().toISOString(), capCents: CAP_CENTS, spentMicros: end == null ? null : start - end, rows };
  fs.writeFileSync(path.join(OUT, saved ? 'draw-check-rescored.json' : 'draw-check.json'), JSON.stringify(report, null, 2) + '\n');

  // The sheet: each answer over its page, drawn by the overlay's own code.
  const marksJs = fs.readFileSync(path.join(__dirname, '..', '..', 'renderer', 'marks.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', '..', 'renderer', 'styles.css'), 'utf8');
  const marksCss = css.slice(css.indexOf('/* Marks: what an answer draws'), css.indexOf('/* ============================== The tour')).replace(/#marks-layer/g, '.marks-layer');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const cards = rows.filter((r) => r.draw && r.text != null).map((r, i) => {
    const pg = pages[r.shot];
    return `<section><h3>${esc(r.model)} · ${esc(r.ask)} · ${r.placed}/${r.readable} placed (${r.tagsWritten} written) · ${r.ms} ms</h3><p>${esc(r.text)}</p>
<div class="page" style="width:${pg.size.width}px;height:${pg.size.height}px"><img src="${path.basename(pg.file)}" width="${pg.size.width}" height="${pg.size.height}"><div class="host" data-i="${i}"></div></div></section>`;
  }).join('\n');
  const data = rows.filter((r) => r.draw && r.text != null).map((r) => (r.marks || []).filter((m) => m.at).map((m) => Object.assign({ light: true }, m.at)));
  for (const shot of Object.keys(pages)) fs.copyFileSync(pages[shot].file, path.join(OUT, shot + '.png'));
  fs.writeFileSync(path.join(OUT, 'draw-check.html'), `<!doctype html><meta charset="utf-8"><title>Draw check</title>
<style>body{font:14px Segoe UI,Arial,sans-serif;background:#f3f4f6;margin:24px}section{margin:0 0 40px}h3{margin:0 0 6px}p{max-width:1100px;margin:0 0 10px;color:#333}
.page{position:relative;border:1px solid #ccc;background:#fff}.page img{position:absolute;left:0;top:0}.host{position:absolute;inset:0}
${marksCss}
.marks-layer{position:absolute;width:100%;height:100%}</style>
${cards}
<script>${marksJs}</script>
<script>
const DATA = ${JSON.stringify(data)};
document.querySelectorAll('.host').forEach((host) => {
  // The layer appends to body; here each page gets its own, so a tiny document stand-in is passed.
  const doc = { createElementNS: (ns, n) => document.createElementNS(ns, n), body: { appendChild: (el) => { el.removeAttribute('id'); el.setAttribute('class', 'marks-layer'); host.appendChild(el); } } };
  const layer = NusMarks.createLayer(doc, { reduced: () => true });
  for (const m of DATA[Number(host.dataset.i)] || []) layer.draw(m);
});
</script>`);
  const drawn = rows.filter((r) => r.draw && r.readable != null);
  const sum = (k) => drawn.reduce((n, r) => n + (r[k] || 0), 0);
  for (const model of TIERS) {
    const d = drawn.filter((r) => r.model === model);
    const s = (k) => d.reduce((n, r) => n + (r[k] || 0), 0);
    console.log('\n' + model + ': ' + d.length + ' answers, ' + d.filter((r) => r.readable > 0).length + ' drew something, marks written ' + s('tagsWritten') + ', readable ' + s('readable') + ', placed ' + s('placed') + ', tags heard in speech ' + d.filter((r) => r.tagLeak).length);
  }
  console.log('\nall: written ' + sum('tagsWritten') + ', readable ' + sum('readable') + ', placed ' + sum('placed'));
  if (saved) { console.log('rescored the run of ' + saved.at + ': nothing spent; sheet: ' + path.join(OUT, 'draw-check.html')); return; }
  console.log('spent ' + (report.spentMicros == null ? '?' : '$' + (report.spentMicros / 1e6).toFixed(4)) + ' of a $' + (CAP_CENTS / 100).toFixed(2) + ' cap; sheet: ' + path.join(OUT, 'draw-check.html'));
}
main().catch((e) => { console.error(String(e.message || e)); process.exit(1); });
