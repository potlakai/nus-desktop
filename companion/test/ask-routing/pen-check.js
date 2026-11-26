'use strict';
// PAID. Which publik tier should check someone's work? The red pen's prompt
// (src/guide/screen-answer.js mode 'check' with drawing on) on one homework page with five planted
// mistakes, asked of each tier with the reply streamed, so the wait to the first word is measured
// as the person hears it. Spends from the signed-in Publik balance: it refuses to run without both
// --yes and --cap-cents, and stops before the next call once the wallet shows the cap spent.
// The key is never printed.
//
//   node companion/test/ask-routing/pen-check.js --yes --cap-cents 4 --shot <homework.png> --out <file.json>
//
// --shot: a screenshot of ventures/nus/conditor/draw-0138/live/homework.html (the vault), any size.
// For each tier: ms to the first word, ms to the end, which of the five mistakes the words name,
// how many pen marks were written and how many land on the words Windows OCR reads off the shot.
// Windows only.
const fs = require('fs');
const path = require('path');
const { buildScreenAnswer } = require('../../src/guide/screen-answer');
const { parseReply } = require('../../src/guide/reply-stream');
const { resolveMark, parseOcrWords } = require('../../src/guide/marks');
const { ocrFile } = require('../../src/win/ocr');

const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
const CAP_CENTS = Number(arg('--cap-cents'));
const OUT = arg('--out');
const SHOT = arg('--shot');
if (!process.argv.includes('--yes') || !(CAP_CENTS > 0) || !OUT || !SHOT) {
  console.error('Paid check. Needs Pranav\'s typed yes: --yes --cap-cents N --shot homework.png --out file.json');
  process.exit(2);
}
const TIERS = (arg('--tiers') || 'publik-fast,publik-balanced,publik-smart').split(',');
// The five planted mistakes, and words that show an answer caught each one.
const PLANTED = {
  algebra: /\b(?:15|fifteen)\b|\bx (?:is|=|equals) (?:5|five)\b|subtract/i,
  total: /\b184\b|one hundred (?:and )?eighty[- ]four/i,
  their: /they(?:'|’)?re|they are/i,
  affect: /\beffect\b/i,
  code: /\bscores\b/i,
};

function pngSize(file) { const b = fs.readFileSync(file); return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }; }

async function main() {
  const publik = require('../../src/publik');
  const mod = publik.module;
  const p = publik.provider();
  if (!p) { console.error('No publik provider on this computer (not signed in, or own key chosen).'); process.exit(3); }
  const cred = mod.readCredential();
  const balance = async () => { const r = await mod.readWallet(cred.key); return r.wallet ? r.wallet.balance_micros : null; };
  const OpenAI = require('openai');
  const client = new OpenAI({ apiKey: p.apiKey, baseURL: p.baseURL });
  const start = await balance();
  if (start == null) { console.error('Could not read the wallet; not spending blind.'); process.exit(4); }
  const capMicros = CAP_CENTS * 10000;

  const size = pngSize(SHOT);
  const raw = await ocrFile(path.resolve(SHOT), true);
  const nl = raw.indexOf('\n');
  const ocr = Object.assign({ width: size.width, height: size.height }, parseOcrWords(nl < 0 ? '' : raw.slice(nl + 1)));
  const ctx = { elements: [], ocr, cap: { width: size.width, height: size.height, pxWidth: size.width, pxHeight: size.height }, originPhys: { x: 0, y: 0 }, ids: false };
  const dataUrl = 'data:image/png;base64,' + fs.readFileSync(SHOT).toString('base64');
  const q = buildScreenAnswer({ ask: 'check my work', mode: 'check', window: { title: 'Homework 4 - Algebra and writing', process: 'firefox' }, draw: true });
  console.log('shot ' + size.width + 'x' + size.height + ', ' + ocr.lines.reduce((n, l) => n + l.words.length, 0) + ' words read; pen prompt ' + q.system.length + ' chars');

  const rows = [];
  let before = start;
  for (const model of TIERS) {
    const now = await balance();
    const spent = now == null ? null : start - now;
    if (spent == null || spent >= capMicros) { rows.push({ model, skipped: 'cap reached or wallet unreadable' }); console.log(model + ': skipped, cap reached'); continue; }
    const t0 = Date.now();
    let first = null, text = '', error = null;
    try {
      const stream = await client.chat.completions.create({ model, max_tokens: q.maxTokens, stream: true, messages: [{ role: 'system', content: q.system }, { role: 'user', content: [{ type: 'text', text: q.text }, { type: 'image_url', image_url: { url: dataUrl } }] }] });
      for await (const chunk of stream) {
        const piece = chunk.choices && chunk.choices[0] && chunk.choices[0].delta && chunk.choices[0].delta.content;
        if (piece) { if (first == null) first = Date.now() - t0; text += piece; }
      }
    } catch (e) { error = String(e.status || '') + ' ' + String(e.message || e).slice(0, 200); }
    const done = Date.now() - t0;
    const after = await balance();
    const parsed = parseReply(text, { marks: true });
    const marks = parsed.events.filter((e) => e.type === 'mark');
    const placed = marks.map((m) => ({ m, at: resolveMark(m, ctx) }));
    const spoken = parsed.spoken.join(' ');
    const caught = Object.keys(PLANTED).filter((k) => PLANTED[k].test(spoken) || marks.some((m) => PLANTED[k].test(String(m.fix || ''))));
    const row = { model, firstMs: first, doneMs: done, error, costMicros: after == null || before == null ? null : before - after, caught, missed: Object.keys(PLANTED).filter((k) => !caught.includes(k)),
      opener: parsed.spoken[0] || '', marksWritten: marks.length, marksPlaced: placed.filter((x) => x.at).length,
      notPlaced: placed.filter((x) => !x.at).map((x) => x.m.shape + ' ' + JSON.stringify(x.m.target.text || x.m.target)), text };
    before = after;
    rows.push(row);
    console.log('\n' + model + ': first word ' + first + ' ms, done ' + done + ' ms, cost ' + (row.costMicros == null ? '?' : '$' + (row.costMicros / 1e6).toFixed(4)) + (error ? ', ERROR ' + error : ''));
    console.log('  caught ' + caught.length + ' of 5 (' + caught.join(', ') + ')' + (row.missed.length ? ', missed: ' + row.missed.join(', ') : '') + '; marks ' + row.marksPlaced + ' of ' + row.marksWritten + ' placed' + (row.notPlaced.length ? ', not placed: ' + row.notPlaced.join('; ') : ''));
    console.log('  ' + text.replace(/\s+/g, ' ').slice(0, 520));
  }
  const end = await balance();
  fs.writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), capCents: CAP_CENTS, spentMicros: end == null ? null : start - end, shot: path.basename(SHOT), rows }, null, 2) + '\n');
  console.log('\nspent ' + (end == null ? '?' : '$' + ((start - end) / 1e6).toFixed(4)) + ' of a $' + (CAP_CENTS / 100).toFixed(2) + ' cap');
}
main().catch((e) => { console.error(String(e.message || e)); process.exit(1); });
