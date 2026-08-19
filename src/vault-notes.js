// Turn a companion session into a markdown note in the Jarvis vault.
// Vault rules honored here: frontmatter (title/date/tags/category), wikilinks
// to pages that exist, create-only writes under notes/companion/, and a
// preview step before anything is written (the caller shows the preview).
const fs = require('fs');
const path = require('path');
const os = require('os');

const VAULT = process.env.JARVIS_VAULT ||
  path.join(os.homedir(), 'Downloads', 'jarvis-starter', 'jarvis');

function notesDir() {
  return path.join(VAULT, 'notes', 'companion');
}

function vaultAvailable() {
  return fs.existsSync(path.join(VAULT, 'CLAUDE.md'));
}

function slugify(text) {
  const slug = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'session';
}

function channelLabel(channel) {
  if (channel === 'you') return 'Me';
  if (channel === 'them') return 'Them';
  return 'Nūs';
}

function buildNote(session, messages) {
  const day = (session.started_at || new Date().toISOString()).slice(0, 10);
  const title = session.title || session.first_line || `Companion session ${day}`;
  const fileName = `${day}-${slugify(title)}.md`;

  const lines = [];
  lines.push('---');
  lines.push(`title: "Companion session: ${title.replace(/"/g, "'")}"`);
  lines.push(`date: ${day}`);
  lines.push('tags: [companion, transcript, meeting]');
  lines.push('category: note');
  lines.push('---');
  lines.push('');
  lines.push(`Captured by the Nūs Companion ([[Jarvis]] overlay). Session started ${session.started_at || 'unknown'}, ended ${session.ended_at || 'unknown'}.`);
  if (session.pack) lines.push(`Briefing pack in play: \`briefings/${session.pack}/pack.md\`.`);
  lines.push('');
  lines.push('## Transcript');
  lines.push('');
  for (const m of messages) {
    const time = (m.ts || '').slice(11, 16);
    lines.push(`- **${channelLabel(m.channel)}**${time ? ' (' + time + ')' : ''}${m.mode && m.channel === 'nus' ? ' [' + m.mode + ']' : ''}: ${m.text}`);
  }
  lines.push('');
  return { fileName, content: lines.join('\n') };
}

// Create-only write, contained to notes/companion/. A repeated upload gets a
// numbered suffix instead of overwriting; nothing in the vault is ever deleted.
function writeNote(fileName, content) {
  if (!vaultAvailable()) return { error: 'Vault not found at ' + VAULT + '. Set JARVIS_VAULT to point at it.' };
  const dir = notesDir();
  fs.mkdirSync(dir, { recursive: true });

  const safeName = path.basename(fileName); // strip any path components
  let target = path.resolve(dir, safeName);
  if (!target.startsWith(path.resolve(dir) + path.sep)) return { error: 'Refused: write would land outside notes/companion/.' };

  const ext = path.extname(safeName);
  const stem = safeName.slice(0, -ext.length || undefined);
  let attempt = 1;
  while (fs.existsSync(target)) {
    attempt += 1;
    target = path.resolve(dir, `${stem}-${attempt}${ext}`);
  }
  fs.writeFileSync(target, content, 'utf8');
  return { ok: true, path: target };
}

module.exports = { buildNote, writeNote, notesDir, vaultAvailable, slugify, VAULT };
