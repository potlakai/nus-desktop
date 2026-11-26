'use strict';
// PAID. publik-fast against publik-smart on screen questions, once they are routed right.
// Spends from the signed-in Publik balance on this computer, so it refuses to run without
// both --yes and --cap-cents, and stops before the next call once the wallet shows the cap
// spent (the balance is read before every call). The key is never printed.
//
//   node companion/test/ask-routing/brain-check.js --yes --cap-cents 25 --out <file.json>
//
// 12 answer asks on four neutral pages (shots/*.png: an article, an error dialog, a settings
// page, a spreadsheet with a planted wrong total), each on both tiers, with the answer prompt
// the Companion now uses (src/guide/screen-answer.js). Then 2 asks through the pointing
// prompt on both tiers, to see whether each tier says [ANSWER] for a question.
const fs = require('fs');
const path = require('path');
const { buildScreenAnswer } = require('../../src/guide/screen-answer');
const { buildPointRequest } = require('../../src/guide/pointing');

const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
const CAP_CENTS = Number(arg('--cap-cents'));
const OUT = arg('--out');
if (!process.argv.includes('--yes') || !(CAP_CENTS > 0) || !OUT) {
  console.error('Paid check. Needs Pranav\'s typed yes: --yes --cap-cents N --out file.json');
  process.exit(2);
}

const SHOTS = path.join(__dirname, 'shots');
const WIN = { article: { title: 'Why sleep helps you remember - Study Notes Weekly', process: 'chrome' }, dialog: { title: 'Lab3 report.docx - Editor', process: 'editor' }, settings: { title: 'Settings', process: 'systemsettings' }, sheet: { title: 'Club budget.xlsx - Sheets', process: 'sheets' } };
const ASKS = [
  ['article', 'summarize', 'summarize what is going on here', 'sleep after study helps memory; 7+ hours, 21 percent more recall; replay in deep sleep; study hard things in the evening, no all-nighters'],
  ['article', 'summarize', 'what is this article saying', 'same as above'],
  ['article', 'read', 'read this to me', 'reads the article body, skips nav and sidebar'],
  ['dialog', 'explain', 'explain this error', 'file not saved: disk C full (0.2 GB free); free space or Save As elsewhere'],
  ['dialog', 'ask', 'what does this mean', 'same as above'],
  ['dialog', 'ask', 'what should I do here', 'free up space on C, or Save As to another drive'],
  ['settings', 'ask', 'what am I looking at', 'Windows-style Settings, Personalization > Colors; mode Light, transparency off'],
  ['settings', 'ask', 'is dark mode on', 'no: mode is Light'],
  ['settings', 'ask', 'what is this page for', 'choosing colors: light or dark mode, accent color, transparency'],
  ['sheet', 'check', 'is this total right', 'no: SUM(B2:B5) leaves out row 6 (35); total should be 184'],
  ['sheet', 'ask', "what's this table showing", 'club budget, five items, who paid, total 149 (wrong)'],
  ['sheet', 'summarize', 'summarize this', 'club budget items and payers; the total misses the speaker gift'],
];
const POINT_ASKS = [['article', 'summarize what is going on here'], ['dialog', 'what do you see here']];
const TIERS = ['publik-fast', 'publik-smart'];

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
  const rows = [];
  const image = (shot) => 'data:image/png;base64,' + fs.readFileSync(path.join(SHOTS, shot + '.png')).toString('base64');
  async function call(model, system, text, shot, maxTokens) {
    const now = await balance();
    const spent = now == null ? null : start - now;
    if (spent == null || spent >= capMicros) return { skipped: 'cap reached or wallet unreadable', spentMicros: spent };
    const t0 = Date.now();
    try {
      const r = await client.chat.completions.create({ model, max_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: [{ type: 'text', text }, { type: 'image_url', image_url: { url: image(shot) } }] }] });
      return { ms: Date.now() - t0, text: (r.choices[0] && r.choices[0].message && r.choices[0].message.content) || '', usage: r.usage || null, spentBeforeMicros: spent };
    } catch (e) { return { ms: Date.now() - t0, error: String(e.status || '') + ' ' + String(e.message || e).slice(0, 200), spentBeforeMicros: spent }; }
  }
  for (const [shot, mode, ask, expect] of ASKS) {
    const q = buildScreenAnswer({ ask, mode, window: WIN[shot] });
    for (const model of TIERS) {
      const r = await call(model, q.system, q.text, shot, q.maxTokens);
      rows.push({ kind: 'answer', shot, mode, ask, expect, model, ...r });
      console.log(model.padEnd(13) + (r.ms || '-') + ' ms  ' + ask + '\n    ' + String(r.text || r.error || r.skipped).replace(/\s+/g, ' ').slice(0, 300));
    }
  }
  for (const [shot, ask] of POINT_ASKS) {
    const req = buildPointRequest({ task: ask, history: [], window: WIN[shot], elements: [], plan: true });
    for (const model of TIERS) {
      const r = await call(model, req.system, req.text, shot, 200);
      rows.push({ kind: 'pointing', shot, ask, model, ...r, saidAnswer: /\[ANSWER\]/i.test(r.text || '') });
      console.log(model.padEnd(13) + 'pointing  ' + ask + ' -> ' + String(r.text || r.error || r.skipped).replace(/\s+/g, ' ').slice(0, 160));
    }
  }
  const end = await balance();
  const report = { at: new Date().toISOString(), capCents: CAP_CENTS, spentMicros: end == null ? null : start - end, rows };
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n');
  console.log('\nspent ' + (report.spentMicros == null ? '?' : '$' + (report.spentMicros / 1e6).toFixed(4)) + ' of a $' + (CAP_CENTS / 100).toFixed(2) + ' cap; ' + rows.filter((r) => r.text != null).length + ' calls answered');
}
main().catch((e) => { console.error(String(e.message || e)); process.exit(1); });
