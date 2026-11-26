'use strict';
// Scores the local ask routing on the test set (asks.json), no model calls.
//   node companion/test/ask-routing/score.js [--root <companion dir>] [--set asks.json|asks-heldout.json] [--label name] [--json out.json]
// Prints accuracy per wanted behaviour and every miss, Hands off and Hands on.
const path = require('path');
const fs = require('fs');
const { load, simulate, behaviourOf } = require('./simulate');

const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const root = path.resolve(arg('--root', path.join(__dirname, '..', '..')));
const label = arg('--label', path.basename(path.dirname(root)) || 'tree');
const out = arg('--json', '');

async function run() {
  const set = JSON.parse(fs.readFileSync(path.join(__dirname, arg('--set', 'asks.json')), 'utf8')).asks;
  const m = load(root);
  const runs = {};
  for (const hands of [false, true]) {
    const rows = [];
    for (const a of set) {
      if (a.needsHands && !hands) continue;
      const r = await simulate(m, a.text, { hands });
      const got = behaviourOf(r.route);
      rows.push({ text: a.text, want: a.want, got, route: r.route, why: r.why || '', ok: got === a.want, real: a.real || '' });
    }
    runs[hands ? 'handsOn' : 'handsOff'] = rows;
  }
  const report = { label, root, at: new Date().toISOString(), runs: {} };
  for (const [name, rows] of Object.entries(runs)) {
    const by = {};
    for (const r of rows) { by[r.want] = by[r.want] || { n: 0, ok: 0 }; by[r.want].n++; if (r.ok) by[r.want].ok++; }
    const ok = rows.filter((r) => r.ok).length;
    report.runs[name] = { total: rows.length, ok, by, misses: rows.filter((r) => !r.ok), rows };
    console.log('\n' + label + ', ' + name + ': ' + ok + '/' + rows.length + ' right (' + Math.round(100 * ok / rows.length) + '%)');
    for (const [want, c] of Object.entries(by)) console.log('  ' + want.padEnd(8) + ' ' + c.ok + '/' + c.n);
    for (const r of rows.filter((x) => !x.ok)) console.log('  MISS want ' + r.want.padEnd(7) + ' got ' + (r.got + ' (' + r.route + (r.why ? ': ' + r.why : '') + ')').padEnd(36) + ' "' + r.text + '"');
  }
  if (out) fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  return report;
}

if (require.main === module) run().catch((e) => { console.error(e); process.exit(1); });
module.exports = { run };
