'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const JSZip = require('jszip');
const { openZip } = require('../src/recall/zip');
const I = require('../src/recall/ingest');
const { createImportWatcher } = require('../src/recall/watcher');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nus-ingest-'));
async function zipOf(files, compression = 'DEFLATE') {
  const z = new JSZip();
  for (const [name, data] of Object.entries(files)) z.file(name, data);
  return z.generateAsync({ type: 'nodebuffer', compression });
}

// One stored entry with ZIP64 sizes, offsets and end records, built by hand.
function zip64Of(name, data) {
  const n = Buffer.from(name), d = Buffer.from(data);
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(45, 4); local.writeUInt32LE(d.length, 18); local.writeUInt32LE(d.length, 22); local.writeUInt16LE(n.length, 26);
  const extra = Buffer.alloc(28); extra.writeUInt16LE(1, 0); extra.writeUInt16LE(24, 2); extra.writeBigUInt64LE(BigInt(d.length), 4); extra.writeBigUInt64LE(BigInt(d.length), 12); extra.writeBigUInt64LE(0n, 20);
  const cen = Buffer.alloc(46); cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(45, 6); cen.writeUInt32LE(0xffffffff, 20); cen.writeUInt32LE(0xffffffff, 24); cen.writeUInt16LE(n.length, 28); cen.writeUInt16LE(extra.length, 30); cen.writeUInt32LE(0xffffffff, 42);
  const cdOff = local.length + n.length + d.length;
  const cd = Buffer.concat([cen, n, extra]);
  const e64 = Buffer.alloc(56); e64.writeUInt32LE(0x06064b50, 0); e64.writeBigUInt64LE(44n, 4); e64.writeBigUInt64LE(1n, 24); e64.writeBigUInt64LE(1n, 32); e64.writeBigUInt64LE(BigInt(cd.length), 40); e64.writeBigUInt64LE(BigInt(cdOff), 48);
  const loc = Buffer.alloc(20); loc.writeUInt32LE(0x07064b50, 0); loc.writeBigUInt64LE(BigInt(cdOff + cd.length), 8); loc.writeUInt32LE(1, 16);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0xffff, 8); end.writeUInt16LE(0xffff, 10); end.writeUInt32LE(0xffffffff, 12); end.writeUInt32LE(0xffffffff, 16);
  return Buffer.concat([local, n, d, cd, e64, loc, end]);
}

const CLAUDE = [{ uuid: 'c1', name: 'Eigenvalues help', created_at: '2026-10-10T10:00:00Z', chat_messages: [{ sender: 'human', text: 'what is an eigenvalue', created_at: '2026-10-10T10:00:00Z' }, { sender: 'assistant', text: 'A scale factor.', created_at: '2026-10-10T10:00:01Z' }] }];
const CHATGPT = [{ id: 'g1', title: 'Diagonalization', create_time: 1760300000, current_node: 'b', mapping: { a: { message: { author: { role: 'user' }, content: { parts: ['How do I diagonalize?'] }, create_time: 1760300000 }, parent: null, children: ['b'] }, b: { message: { author: { role: 'assistant' }, content: { parts: ['Eigenvectors first.'] }, create_time: 1760300001 }, parent: 'a', children: [] } } }];
const GEMINI = [
  { header: 'Gemini Apps', title: 'Prompted what is a pivot table', time: '2026-10-15T14:00:00.000Z', products: ['Gemini Apps'], safeHtmlItem: [{ html: '<p>A table that <b>summarizes</b> data.</p>' }] },
  { header: 'Gemini Apps', title: 'Prompted and in Excel?', time: '2026-10-15T14:05:00.000Z', safeHtmlItem: [{ html: '<p>Insert &gt; PivotTable.</p>' }] },
  { header: 'Gemini Apps', title: 'Prompted plan my week', time: '2026-10-16T09:00:00.000Z' },
  { header: 'Search', title: 'Searched for pizza', time: '2026-10-16T09:00:00.000Z' },
];
const GEMINI_HTML = '<html><body><div class="outer-cell mdl-cell"><div class="mdl-grid"><div class="header-cell mdl-cell"><p class="mdl-typography--title">Gemini Apps<br></p></div>'
  + '<div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1">Prompted&nbsp;what is a pivot table<br>Oct 15, 2026, 9:00:00 AM CDT<br></div><div class="content-cell mdl-cell"><p>A table that summarizes data.</p></div>'
  + '<div class="content-cell mdl-cell mdl-cell--12-col mdl-typography--caption"><b>Products:</b><br>&emsp;Gemini Apps<br></div></div></div></body></html>';

test('zip: deflated and stored entries, nested names, and ZIP64 records', async () => {
  const buf = await zipOf({ 'a/conversations.json': '[1,2,3]', 'b.txt': 'hello '.repeat(1000) });
  const z = openZip(buf);
  assert.deepEqual(z.entries.map((e) => e.name), ['a/conversations.json', 'b.txt']);
  assert.equal(z.read(z.entries[0]).toString(), '[1,2,3]');
  assert.equal(z.read(z.entries[1]).length, 6000);
  assert.throws(() => z.read(z.entries[1], 100), /larger than/);
  const stored = openZip(await zipOf({ 'x.json': '{"a":1}' }, 'STORE'));
  assert.equal(stored.read(stored.entries[0]).toString(), '{"a":1}');
  const z64 = openZip(zip64Of('Takeout/Keep/n.json', '{"title":"t","textContent":"hi"}'));
  assert.equal(z64.entries[0].name, 'Takeout/Keep/n.json');
  assert.equal(JSON.parse(z64.read(z64.entries[0]).toString()).textContent, 'hi');
  assert.throws(() => openZip(Buffer.from('not a zip at all, sorry')), /not a zip/);
  void zlib;
});

test('ChatGPT and Claude export ZIPs become conversations', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'chatgpt.zip'), await zipOf({ 'conversations.json': JSON.stringify(CHATGPT), 'chat.html': '<html></html>', 'user.json': '{}' }));
  fs.writeFileSync(path.join(dir, 'claude.zip'), await zipOf({ 'data-2026/conversations.json': JSON.stringify(CLAUDE), 'data-2026/users.json': '[]' }));
  const g = I.readExportZip(path.join(dir, 'chatgpt.zip'));
  assert.deepEqual(g.kinds, ['chats']);
  assert.equal(g.conversations[0].id, 'chatgpt:g1');
  assert.equal(I.importedLine(g.conversations), 'Imported 1 conversation from ChatGPT');
  const c = I.readExportZip(path.join(dir, 'claude.zip'));
  assert.equal(c.conversations[0].source, 'claude');
});

test('Google Takeout: Gemini activity (JSON or HTML) by day, Keep notes, trashed notes skipped', async () => {
  const days = I.parseGeminiJson(GEMINI);
  assert.deepEqual(days.map((d) => d.id), ['gemini:day:2026-10-15', 'gemini:day:2026-10-16']);
  assert.deepEqual(days[0].messages.map((m) => [m.role, m.text]), [['user', 'what is a pivot table'], ['assistant', 'A table that summarizes data.'], ['user', 'and in Excel?'], ['assistant', 'Insert > PivotTable.']]);
  assert.match(days[0].title, /^Gemini, Oct 15, 2026: what is a pivot table/);
  const fromHtml = I.parseGeminiHtml(GEMINI_HTML);
  assert.equal(fromHtml.length, 1);
  assert.equal(fromHtml[0].messages[0].text, 'what is a pivot table');
  assert.match(fromHtml[0].messages[1].text, /summarizes data/);
  const buf = await zipOf({
    'Takeout/My Activity/Gemini Apps/MyActivity.json': JSON.stringify(GEMINI),
    'Takeout/Keep/Groceries.json': JSON.stringify({ title: 'Groceries', listContent: [{ text: 'milk', isChecked: true }, { text: 'eggs' }], userEditedTimestampUsec: 1760300000000000 }),
    'Takeout/Keep/Old.json': JSON.stringify({ title: 'Old', textContent: 'gone', isTrashed: true }),
    'Takeout/Keep/Groceries.html': '<html></html>',
    'Takeout/YouTube/history.json': '[]',
  });
  const r = I.readExportZip(buf);
  assert.deepEqual(r.kinds, ['gemini', 'keep']);
  const keep = r.conversations.filter((x) => x.source === 'keep');
  assert.equal(keep.length, 1);
  assert.equal(keep[0].messages[0].text, '[x] milk\n[ ] eggs');
  assert.equal(I.importedLine(r.conversations), 'Imported 2 conversations from Gemini and 1 note from Google Keep');
});

test('Apple data copy: iCloud Notes, one folder per note, also inside an outer ZIP', async () => {
  const inner = await zipOf({ 'iCloud Notes/Trip ideas/Trip ideas.txt': 'Kyoto in April', 'iCloud Notes/Trip ideas/photo.jpg': 'jpg', 'iCloud Notes/Empty/Empty.txt': '' });
  const outer = await zipOf({ 'Apple Data/iCloud Notes.zip': inner, 'Apple Data/readme.pdf': 'pdf' });
  for (const src of [inner, outer]) {
    const r = I.readExportZip(src);
    assert.deepEqual(r.kinds, ['apple-notes']);
    assert.equal(r.conversations.length, 1);
    assert.equal(r.conversations[0].title, 'Trip ideas');
    assert.equal(r.conversations[0].source, 'apple-notes');
  }
});

test('a ZIP that is not an export is recognised as such from its directory alone', async () => {
  const r = I.readExportZip(await zipOf({ 'setup.exe': 'MZ', 'readme.txt': 'hi' }));
  assert.equal(r.kinds, null);
  assert.deepEqual(r.conversations, []);
});

test('watcher: waits for a download to settle, imports once, remembers across restarts, never deletes, can be off', async () => {
  const dir = tmp(), state = path.join(tmp(), 'seen.json');
  let clock = Date.now() + 60000;
  const zip = path.join(dir, 'export.zip');
  fs.writeFileSync(zip, await zipOf({ 'conversations.json': JSON.stringify(CHATGPT) }));
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a zip');
  const calls = [];
  const imported = [];
  let on = true;
  const make = () => createImportWatcher({ folders: () => [dir, ''], enabled: () => on, seenFile: state, now: () => clock, onImported: (r) => imported.push(r.line),
    importZip: async (f) => { calls.push(f); const r = I.readExportZip(f); return { kinds: r.kinds, conversations: r.conversations.length, line: I.importedLine(r.conversations) }; } });
  const w = make();
  assert.deepEqual(await w.scan(), [], 'first look: remembered, not yet read');
  const done = await w.scan();
  assert.equal(done.length, 1);
  assert.deepEqual(imported, ['Imported 1 conversation from ChatGPT']);
  assert.equal(calls.length, 1);
  await w.scan();
  assert.equal(calls.length, 1, 'not read again');
  assert.ok(fs.existsSync(zip), 'never deleted');
  const again = make();
  await again.scan(); await again.scan();
  assert.equal(calls.length, 1, 'remembered after a restart');
  fs.appendFileSync(zip, Buffer.alloc(0));
  const other = path.join(dir, 'other.zip');
  fs.writeFileSync(other, await zipOf({ 'a.exe': 'MZ' }));
  on = false;
  await again.scan(); await again.scan();
  assert.equal(calls.length, 1, 'off means off');
  on = true;
  await again.scan(); await again.scan();
  assert.equal(calls.length, 2, 'a non-export is looked at once');
  await again.scan();
  assert.equal(calls.length, 2);
  clock = Date.now() - 1000;
  fs.writeFileSync(path.join(dir, 'fresh.zip'), 'still downloading');
  await again.scan(); await again.scan();
  assert.equal(calls.length, 2, 'a file touched seconds ago waits');
  assert.equal(again.status().imported, 1);
});
