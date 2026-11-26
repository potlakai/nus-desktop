// whisper's small model mishears app names: "notepad" came back as "NordPad"
// and "node path" (live 2026-09-21). Jev reads meaning, not sound, so it could
// not match those to Notepad. This is the sound half: when Jev is sure the
// person wants an app opened but cannot say which, compare what was heard with
// every app's spoken names by spelling distance and take a clear winner.
const VERB = /^(?:(?:can|could|would) you |please |and |then |now |lets |let's |just )*(?:open(?: up)?|launch|start|go to|switch to|bring up|pull up)\s+(?:the |my |a |an )?/i;
const TAIL = /\s+(?:app|application|program|window|for me|please|now|real quick)[\s.,!?]*$/i;

const squash = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function distance(a, b) {
  const m = a.length; const n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

function similarity(a, b) {
  const x = squash(a); const y = squash(b);
  if (!x || !y) return 0;
  return 1 - distance(x, y) / Math.max(x.length, y.length);
}

// "Notepad (notepad, note pad, notes)" -> ['notepad', 'note pad', 'notes']
function spokenNames(app) {
  const m = /^(.*?)\s*\((.*)\)\s*$/.exec(app.describe || '');
  const names = m ? [m[1]].concat(m[2].split(',')) : [app.name];
  return names.map((s) => s.trim()).filter((s) => squash(s).length >= 4);
}

// Returns { app, score, heard } or null. A winner must be close (>= MIN) and
// clearly ahead of every other app (>= MARGIN), or nothing is opened.
const MIN = 0.6;
const MARGIN = 0.1;
function soundsLike(clause, apps) {
  const m = VERB.exec(String(clause || '').trim());
  if (!m) return null;
  const heard = String(clause).trim().slice(m[0].length).replace(TAIL, '').replace(/[.,!?]+$/, '').trim();
  if (squash(heard).length < 4 || heard.split(/\s+/).length > 3) return null;
  // "open canvas" for "Canvas Student": the spoken word is the whole first
  // word of the name. That counts as a near-exact match; a word cut short
  // ("open chr" mid-sentence) does not.
  const firstWord = (name) => squash(String(name).split(/\s+/)[0] || '');
  const scored = apps.map((app) => {
    let top = 0;
    for (const name of spokenNames(app)) {
      top = Math.max(top, similarity(heard, name));
      if (squash(heard).length >= 4 && firstWord(name) === squash(heard) && squash(name) !== squash(heard)) top = Math.max(top, 0.92);
    }
    return { app, score: top, heard };
  }).sort((a, b) => b.score - a.score || a.app.name.length - b.app.name.length);
  const best = scored[0];
  if (!best || best.score < MIN) return null;
  // "Notepad" and "Notepad++" sound the same: one family, and the plain one
  // (shorter name, sorted first) is what people mean. The margin is measured
  // against the best app OUTSIDE the winner's family.
  const family = (a, b) => { const x = squash(a.app.name); const y = squash(b.app.name); return x.startsWith(y) || y.startsWith(x); };
  const rival = scored.find((s) => s !== best && !family(s, best));
  if (rival && best.score - rival.score < MARGIN) return null;
  return best;
}

module.exports = { soundsLike, similarity, spokenNames };
