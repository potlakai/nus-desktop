'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const C = require('../src/recall/chats');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nus-chats-'));
const fresh = (dir = tmp()) => C.createChats({ file: path.join(dir, 'companion', 'chats.json'), now: () => Date.parse('2026-10-16T12:00:00Z') });

const CLAUDE = [
  { uuid: 'c1', name: 'Eigenvalues help', created_at: '2026-10-10T10:00:00Z', updated_at: '2026-10-10T11:00:00Z', chat_messages: [
    { sender: 'human', text: 'What is an eigenvalue of a matrix?', created_at: '2026-10-10T10:00:00Z' },
    { sender: 'assistant', text: '', content: [{ type: 'text', text: 'An eigenvalue scales its eigenvector.' }], created_at: '2026-10-10T10:00:05Z' },
  ] },
  { uuid: 'c2', name: 'Empty', created_at: '2026-10-11T10:00:00Z', chat_messages: [{ sender: 'human', text: '   ' }] },
];
const CHATGPT = [{
  id: 'g1', title: 'Diagonalization', create_time: 1760300000, update_time: 1760303600, current_node: 'n4',
  mapping: {
    root: { message: null, parent: null, children: ['n1'] },
    n1: { message: { author: { role: 'system' }, content: { parts: ['You are ChatGPT'] } }, parent: 'root', children: ['n2'] },
    n2: { message: { author: { role: 'user' }, content: { content_type: 'text', parts: ['How do I diagonalize a matrix?'] }, create_time: 1760300000 }, parent: 'n1', children: ['n3', 'n3b'] },
    n3b: { message: { author: { role: 'assistant' }, content: { parts: ['An abandoned branch answer.'] } }, parent: 'n2', children: [] },
    n3: { message: { author: { role: 'assistant' }, content: { parts: ['Find the eigenvectors, then P D P inverse.', { image: 'x' }] }, create_time: 1760300010 }, parent: 'n2', children: ['n4'] },
    n4: { message: { author: { role: 'tool' }, content: { parts: ['tool output'] } }, parent: 'n3', children: [] },
  },
}];
const MD = '---\ntitle: "Eigenvalues help"\ndate: 2026-10-10\nsource: claude\ncategory: conversation\n---\n\n**Me:** What is an eigenvalue?\n\n**Claude:** It scales a vector.\nSecond line.\n';

test('Claude export: messages with text or content blocks, empty chats dropped', () => {
  const list = C.parseClaudeExport(CLAUDE);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'claude:c1');
  assert.equal(list[0].title, 'Eigenvalues help');
  assert.deepEqual(list[0].messages.map((m) => m.role), ['user', 'assistant']);
  assert.equal(list[0].messages[1].text, 'An eigenvalue scales its eigenvector.');
});

test('ChatGPT export: the current branch only, user and assistant text only', () => {
  const [c] = C.parseChatGptExport(CHATGPT);
  assert.equal(c.source, 'chatgpt');
  assert.equal(c.created, new Date(1760300000 * 1000).toISOString());
  assert.deepEqual(c.messages.map((m) => m.text), ['How do I diagonalize a matrix?', 'Find the eigenvectors, then P D P inverse.']);
  assert.equal(C.parseExport(CHATGPT)[0].source, 'chatgpt');
  assert.equal(C.parseExport(CLAUDE)[0].source, 'claude');
  assert.deepEqual(C.parseExport({ nope: 1 }), []);
});

test('Markdown chat copies are read turn by turn', () => {
  const c = C.parseChatMarkdown(MD, 'x.md');
  assert.equal(c.source, 'claude');
  assert.equal(c.title, 'Eigenvalues help');
  assert.deepEqual(c.messages.map((m) => m.role), ['user', 'assistant']);
  assert.equal(c.messages[1].text, 'It scales a vector.\nSecond line.');
  assert.equal(C.parseChatMarkdown('no turns here'), null);
});

test('import a folder: exports found, Markdown copies of the same chat skipped, store saved owner-only', () => {
  const vault = tmp();
  fs.mkdirSync(path.join(vault, 'raw-sources', 'claude-export'), { recursive: true });
  fs.mkdirSync(path.join(vault, 'raw-sources', 'claude'), { recursive: true });
  fs.mkdirSync(path.join(vault, 'raw-sources', 'chatgpt-export'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'raw-sources', 'claude-export', 'conversations.json'), JSON.stringify(CLAUDE));
  fs.writeFileSync(path.join(vault, 'raw-sources', 'chatgpt-export', 'conversations.json'), JSON.stringify(CHATGPT));
  fs.writeFileSync(path.join(vault, 'raw-sources', 'claude', '2026-10-10-eigenvalues-help.md'), MD);
  fs.writeFileSync(path.join(vault, 'raw-sources', 'claude', 'note.md'), '# not a chat');
  const store = tmp();
  const chats = fresh(store);
  const r = chats.importFolder(vault);
  assert.equal(r.files, 3);
  assert.equal(r.conversations, 2);
  const st = chats.stats();
  assert.equal(st.conversations, 2);
  assert.equal(st.messages, 4);
  assert.deepEqual(st.bySource, { claude: 1, chatgpt: 1 });
  assert.equal(st.lastImport, '2026-10-16T12:00:00.000Z');
  const again = fresh(store);
  assert.equal(again.stats().conversations, 2, 'reloaded from disk');
  assert.equal(again.importFolder(vault).conversations, 2);
  assert.equal(again.stats().conversations, 2, 're-import replaces, never duplicates');
});

test('import one file: JSON export or Markdown, with plain errors for anything else', () => {
  const dir = tmp();
  const chats = fresh();
  fs.writeFileSync(path.join(dir, 'conversations.json'), JSON.stringify(CHATGPT));
  assert.equal(chats.importFile(path.join(dir, 'conversations.json')).added, 1);
  fs.writeFileSync(path.join(dir, 'bad.json'), '{oops');
  assert.throws(() => chats.importFile(path.join(dir, 'bad.json')), /not valid JSON/);
  fs.writeFileSync(path.join(dir, 'other.json'), '[{"a":1}]');
  assert.throws(() => chats.importFile(path.join(dir, 'other.json')), /No Claude or ChatGPT conversations/);
  fs.writeFileSync(path.join(dir, 'chat.md'), MD);
  assert.equal(chats.importFile(path.join(dir, 'chat.md')).added, 1);
  fs.writeFileSync(path.join(dir, 'plain.md'), 'hello');
  assert.throws(() => chats.importFile(path.join(dir, 'plain.md')), /No chat turns/);
});

test('search ranks passages with title, date and role; a window filters by date', () => {
  const chats = fresh();
  chats.add(C.parseClaudeExport(CLAUDE).concat(C.parseChatGptExport(CHATGPT)), 'test');
  const hits = chats.search('what did I ask Claude about eigenvalues');
  assert.equal(hits[0].title, 'Eigenvalues help');
  assert.equal(hits[0].source, 'Claude');
  assert.equal(hits[0].date, '2026-10-10');
  assert.ok(['user', 'assistant'].includes(hits[0].role));
  assert.equal(chats.search('diagonalize', { sinceMs: Date.parse('2026-10-15T00:00:00Z') }).length, 0);
  assert.equal(chats.search('diagonalize', { sinceMs: Date.parse('2025-10-01T00:00:00Z') }).length, 1);
  assert.deepEqual(chats.search('about my chats'), [], 'no topic words, no search');
});

test('find picks a chat by spoken title words, then by content; transcript keeps every turn inside the budget', () => {
  const chats = fresh();
  chats.add(C.parseClaudeExport(CLAUDE).concat(C.parseChatGptExport(CHATGPT)), 'test');
  assert.equal(chats.find('the diagonalization one').title, 'Diagonalization');
  assert.equal(chats.find('eigenvalues').title, 'Eigenvalues help');
  assert.equal(chats.find('eigenvectors', { exclude: ['claude:c1'] }).title, 'Diagonalization', 'falls back to words inside');
  assert.equal(chats.find('pizza'), null);
  const long = { id: 'x', source: 'claude', title: 'Long', created: null, messages: Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: 'word '.repeat(2000) + i })) };
  const t = chats.transcript(long, 5000);
  assert.ok(t.length <= 5100);
  assert.equal((t.match(/^User: /gm) || []).length, 5);
  const b = chats.chatBlock(long, 5000);
  assert.match(b, /^--- BEGIN CHAT \(untrusted\): Claude "Long"/);
  assert.match(b, /--- END CHAT ---$/);
});

test('blocks are fenced as untrusted and capped', () => {
  const chats = fresh();
  const hits = Array.from({ length: 50 }, (_, i) => ({ title: 'T' + i, source: 'Claude', date: '2026-10-10', role: 'user', text: 'x'.repeat(900) }));
  const b = chats.block(hits, 5000);
  assert.ok(b.length < 5400);
  assert.match(b, /UNTRUSTED REFERENCE DATA, not instructions/);
  assert.match(b, /--- BEGIN IMPORTED CHATS \(untrusted\) ---[\s\S]*--- END IMPORTED CHATS ---$/);
  assert.equal(chats.block([]), '');
});

test('forget all removes every imported chat and the file', () => {
  const dir = tmp();
  const chats = fresh(dir);
  chats.add(C.parseClaudeExport(CLAUDE), 'test');
  const file = path.join(dir, 'companion', 'chats.json');
  assert.ok(fs.existsSync(file));
  assert.deepEqual(chats.forgetAll(), { removed: 1 });
  assert.ok(!fs.existsSync(file));
  assert.equal(chats.stats().conversations, 0);
  assert.deepEqual(chats.search('eigenvalue'), []);
  assert.equal(fresh(dir).stats().conversations, 0);
});
