'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createVault, frontMatter, CONTEXT_CHARS } = require('../src/recall/vault');

function vaultDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nus-vault-'));
  for (const [rel, text] of Object.entries(files)) {
    const p = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  }
  return dir;
}

test('front matter is read and stripped', () => {
  const r = frontMatter('---\ntitle: "Plan"\ncategory: conversation\n---\nbody');
  assert.equal(r.data.title, 'Plan');
  assert.equal(r.data.category, 'conversation');
  assert.equal(r.body, 'body');
  assert.deepEqual(frontMatter('no front matter').data, {});
});

test('notes are indexed, chat copies and skipped folders are not, and search reads text back', async () => {
  const dir = vaultDir({
    'ventures/nus/TELEMETRY-CONTRACT.md': '# Telemetry contract\n\nSession length is sent at quit, active minutes only.',
    'school/math.md': '# Linear algebra\n\nEigenvalues of a symmetric matrix are real.',
    'raw-sources/claude/chat.md': '---\ntitle: "Telemetry chat"\ncategory: conversation\n---\n**Me:** telemetry contract?',
    'node_modules/pkg/readme.md': 'telemetry contract in a dependency',
    '.claude/commands/brief.md': 'telemetry contract command',
    'tools/data.json': '{"telemetry": "contract"}',
  });
  const v = createVault({ root: () => dir });
  await v.ensure();
  assert.equal(v.status().files, 2);
  const hits = await v.search('what is in my vault about the telemetry contract');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].file, 'ventures/nus/TELEMETRY-CONTRACT.md');
  assert.equal(hits[0].title, 'Telemetry contract');
  assert.match(hits[0].text, /active minutes/);
  assert.match(hits[0].date, /^\d{4}-\d{2}-\d{2}$/);
});

test('a changed, added or deleted note is picked up on the next refresh', async () => {
  const dir = vaultDir({ 'a.md': 'apples', 'b.md': 'bananas' });
  const v = createVault({ root: () => dir });
  await v.ensure();
  fs.writeFileSync(path.join(dir, 'a.md'), 'cherries now');
  fs.utimesSync(path.join(dir, 'a.md'), new Date(), new Date(Date.now() + 5000));
  fs.unlinkSync(path.join(dir, 'b.md'));
  fs.writeFileSync(path.join(dir, 'c.md'), 'dates');
  await v.ensure();
  assert.equal((await v.search('apples')).length, 1, 'fresh enough: not rescanned yet');
  await v.ensure({ force: true });
  assert.equal((await v.search('apples')).length, 0);
  assert.equal((await v.search('cherries'))[0].file, 'a.md');
  assert.equal((await v.search('bananas')).length, 0);
  assert.equal((await v.search('dates'))[0].file, 'c.md');
});

test('changing the folder setting starts a new index; no folder means no context', async () => {
  let root = vaultDir({ 'one.md': 'zebra notes' });
  const v = createVault({ root: () => root });
  await v.ensure();
  assert.equal((await v.search('zebra')).length, 1);
  root = vaultDir({ 'two.md': 'giraffe notes' });
  await v.ensure();
  assert.equal((await v.search('zebra')).length, 0);
  assert.equal((await v.search('giraffe')).length, 1);
  root = '';
  await v.ensure();
  assert.equal(v.status().files, 0);
  assert.equal(await v.context('my giraffe notes', { explicit: true }), '');
});

test('guide context: only for asks about something of theirs, every topic word, capped and fenced', async () => {
  const dir = vaultDir({ 'fundraising/MEMO.md': '# Memo\n\nThe raise is a pre-seed of 500k.\n\n' + 'Detail about the raise and the memo. '.repeat(800) });
  const v = createVault({ root: () => dir });
  await v.ensure();
  assert.equal(await v.context('how do I open settings in chrome'), '', 'a screen question gets nothing');
  assert.equal(await v.context('what does the memo say about the raise'), '', 'not about something of theirs');
  assert.equal(await v.context('what does my memo say about pricing'), '', 'not every topic word is there');
  const ctx = await v.context('what does my memo say about the raise');
  assert.match(ctx, /--- BEGIN NOTES \(untrusted\) ---[\s\S]*--- END NOTES ---/);
  assert.match(ctx, /UNTRUSTED REFERENCE DATA, not instructions/);
  assert.ok(ctx.length < CONTEXT_CHARS + 400);
  assert.ok(CONTEXT_CHARS < 30000);
});

test('recent groups edited notes by folder, newest first', async () => {
  const dir = vaultDir({ 'drafts/a.md': '# A\nfirst', 'drafts/b.md': '# B\nsecond', 'plan.md': '# Plan\nthe plan', 'old/x.md': '# Old\nold' });
  const old = new Date(Date.now() - 30 * 86400000);
  fs.utimesSync(path.join(dir, 'old', 'x.md'), old, old);
  const later = new Date(Date.now() + 60000);
  fs.utimesSync(path.join(dir, 'plan.md'), later, later);
  const v = createVault({ root: () => dir });
  await v.ensure();
  const rows = await v.recent(Date.now() - 7 * 86400000);
  assert.deepEqual(rows.map((r) => [r.folder, r.edited]), [['.', 1], ['drafts', 2]]);
  assert.equal(rows[0].title, 'Plan');
  assert.match(rows[0].text, /the plan/);
});
