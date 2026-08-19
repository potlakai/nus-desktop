// Vault upload: note shape and, most importantly, write containment.
// A session title is user/transcript-derived text, so it must never be able to
// steer the write outside notes/companion/.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Point the module at a throwaway vault before requiring it.
const VAULT = fs.mkdtempSync(path.join(os.tmpdir(), 'nus-vault-'));
fs.writeFileSync(path.join(VAULT, 'CLAUDE.md'), '# fake vault');
process.env.JARVIS_VAULT = VAULT;
const vaultNotes = require('./vault-notes');

const session = {
  id: 1,
  started_at: '2026-08-18T14:02:00.000Z',
  ended_at: '2026-08-18T14:44:00.000Z',
  pack: 'sample-briefing',
  title: 'Pricing objection walkthrough',
};
const messages = [
  { ts: '2026-08-18T14:02:10.000Z', channel: 'them', text: 'Seat pricing feels steep.' },
  { ts: '2026-08-18T14:02:40.000Z', channel: 'you', text: 'What is the counter?', mode: 'ask' },
  { ts: '2026-08-18T14:02:52.000Z', channel: 'nus', text: 'Anchor on outcome per member.', mode: 'ask' },
];

test('the note carries frontmatter, a resolvable wikilink, and every line', () => {
  const { fileName, content } = vaultNotes.buildNote(session, messages);
  assert.equal(fileName, '2026-08-18-pricing-objection-walkthrough.md');
  assert.match(content, /^---\n/);
  assert.match(content, /title: "Companion session: Pricing objection walkthrough"/);
  assert.match(content, /date: 2026-08-18/);
  assert.match(content, /tags: \[companion, transcript, meeting\]/);
  assert.match(content, /\[\[Jarvis\]\]/, 'links an entity page that exists in the vault');
  assert.match(content, /briefings\/sample-briefing\/pack\.md/);
  for (const m of messages) assert.ok(content.includes(m.text), `transcript keeps: ${m.text}`);
  assert.match(content, /\*\*Them\*\*/);
  assert.match(content, /\*\*Nūs\*\*/);
});

test('a quote in the title cannot break the frontmatter', () => {
  const { content } = vaultNotes.buildNote({ ...session, title: 'He said "no" loudly' }, messages);
  const frontmatter = content.split('---')[1];
  assert.ok(!/title: "[^"]*"[^\n]*"/.test(frontmatter), 'no stray closing quote');
  assert.match(content, /He said 'no' loudly/);
});

test('slugify strips separators that could climb directories', () => {
  assert.equal(vaultNotes.slugify('../../etc/passwd'), 'etc-passwd');
  assert.equal(vaultNotes.slugify('..\\..\\windows\\system32'), 'windows-system32');
  assert.equal(vaultNotes.slugify(''), 'session');
  assert.ok(!vaultNotes.slugify('a'.repeat(200)).includes('/'));
  assert.ok(vaultNotes.slugify('a'.repeat(200)).length <= 48);
});

test('writeNote lands inside notes/companion and never escapes it', () => {
  const res = vaultNotes.writeNote('2026-08-18-ok.md', 'body');
  assert.ok(res.ok, res.error);
  const dir = path.resolve(vaultNotes.notesDir());
  assert.ok(path.resolve(res.path).startsWith(dir + path.sep), 'written inside notes/companion');
  assert.equal(fs.readFileSync(res.path, 'utf8'), 'body');

  // A traversal attempt is reduced to its basename, not honored.
  const escape = vaultNotes.writeNote('../../../evil.md', 'nope');
  assert.ok(escape.ok, escape.error);
  assert.ok(path.resolve(escape.path).startsWith(dir + path.sep), 'traversal contained');
  assert.ok(!fs.existsSync(path.join(VAULT, 'evil.md')), 'nothing written above the folder');
  assert.ok(!fs.existsSync(path.join(VAULT, '..', 'evil.md')));
});

test('uploading twice never overwrites the first note', () => {
  const a = vaultNotes.writeNote('same-name.md', 'first');
  const b = vaultNotes.writeNote('same-name.md', 'second');
  assert.notEqual(a.path, b.path, 'second upload gets its own file');
  assert.equal(fs.readFileSync(a.path, 'utf8'), 'first', 'original untouched');
  assert.match(path.basename(b.path), /same-name-2\.md/);
});

test('a missing vault is reported, not created', () => {
  const missing = path.join(os.tmpdir(), 'nus-not-a-vault-' + Date.now());
  const saved = process.env.JARVIS_VAULT;
  try {
    delete require.cache[require.resolve('./vault-notes')];
    process.env.JARVIS_VAULT = missing;
    const fresh = require('./vault-notes');
    const res = fresh.writeNote('x.md', 'body');
    assert.ok(res.error, 'refuses to write into a folder that is not a vault');
    assert.ok(!fs.existsSync(missing), 'did not create the folder');
  } finally {
    process.env.JARVIS_VAULT = saved;
    delete require.cache[require.resolve('./vault-notes')];
  }
});
