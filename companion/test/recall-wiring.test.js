'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('nothing from notes or chats can become a memory fact', () => {
  for (const f of fs.readdirSync(path.join(root, 'companion', 'src', 'recall'))) {
    const s = read('companion/src/recall/' + f);
    assert.doesNotMatch(s, /require\(['"]\.\.\/memory['"]\)/, f + ' must not touch memory.js');
    assert.doesNotMatch(s, /\.remember\(|\.merge\(|memory\.add\(/, f);
  }
  const main = read('companion/index.js');
  const recallFn = main.slice(main.indexOf('async function answerRecall('), main.indexOf('function forgetFromWords('));
  assert.ok(recallFn.length > 100);
  assert.doesNotMatch(recallFn, /getMemory\(\)/);
});

test('memory asks route by code ahead of rewrite, the reflex layer and Hands', () => {
  const main = read('companion/index.js');
  const slow = main.slice(main.indexOf('function routeUtteranceSlow('));
  assert.ok(slow.indexOf('parseRecallAsk(kind.text)') > 0);
  assert.ok(slow.indexOf('parseRecallAsk(kind.text)') < slow.indexOf('const rw = rewriteAsk(kind.text)'), 'before rewrite');
  assert.match(main, /function ownPath\(text\) \{[^}]*parseRecallAsk\(text\)/, 'skips the reflex layer and Hands');
  // The passages ride in the user turn: answerPlain with a prompt, the system prompt untouched.
  assert.match(main, /answerPlain\(text, voice \? 'voice' : 'typed', heardAt, \{ prompt: r\.prompt,/);
  assert.match(main, /noFolders: !!opts\.prompt/);
  // The notes join the per-ask folder lookup, which is cached per ask and goes in the user turn.
  const guideCtx = main.slice(main.indexOf('function companionGuideContext('), main.indexOf('function warmGuideBrain('));
  assert.match(guideCtx, /getRecall\(\)\.vaultContext\(ask\)/);
  assert.match(guideCtx, /folderRefs\.set\(ask, text\)/);
  assert.match(guideCtx, /system: guideSystemPrompt\(params\.system\)/);
});

test('Home: the notes folder is a setting, imports and forget are wired, and the copy has no em dashes', () => {
  assert.match(read('companion/src/store.js'), /vaultPath: '',/);
  const mainCompanion = read('src/main-companion.js');
  for (const ch of ['panel', 'vault', 'vault-clear', 'import-folder', 'import-file', 'forget']) assert.match(mainCompanion, new RegExp("handle\\('home:recall:" + ch + "'"));
  const preload = read('companion/home/preload.js');
  assert.match(preload, /'home:recall'/);
  const html = read('companion/home/index.html');
  assert.match(html, /<h3>What Nūs knows about you<\/h3>/);
  for (const id of ['recall-counts', 'recall-vault', 'recall-import-folder', 'recall-import-file', 'recall-forget']) assert.ok(html.includes('id="' + id + '"'), id);
  assert.match(html, /Forget all imported chats/);
  const homeJs = read('companion/home/home.js');
  assert.match(homeJs, /confirm\('Forget all imported chats\?/);
  for (const f of ['companion/home/index.html', 'companion/home/home.js', ...fs.readdirSync(path.join(root, 'companion', 'src', 'recall')).map((f) => 'companion/src/recall/' + f)]) {
    const s = read(f);
    const start = f.endsWith('index.html') ? s.indexOf('id="recall-title"') : 0;
    assert.doesNotMatch(s.slice(start, f.endsWith('index.html') ? s.indexOf('</section>', start) : undefined), /\u2014/, f);
  }
});

test('the Companion main and overlay sources parse (a misplaced line once shipped a startup SyntaxError)', () => {
  for (const f of ['src/main-companion.js', 'companion/index.js', 'companion/home/home.js']) {
    assert.doesNotThrow(() => new Function('require', 'module', 'exports', '__filename', '__dirname', read(f)), f);
  }
});

test('a guide ask never waits for the first notes index', async () => {
  const { createVault } = require('../src/recall/vault');
  const { createRecall } = require('../src/recall/recall');
  const { createChats } = require('../src/recall/chats');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nus-wiring-'));
  fs.writeFileSync(path.join(dir, 'memo.md'), '# Memo\n\nThe raise is a pre-seed.');
  const vault = createVault({ root: () => dir });
  const r = createRecall({ chats: createChats({ file: path.join(dir, 'c.json') }), vault, vaultRoot: () => dir });
  assert.equal(await r.vaultContext('what does my memo say about the raise'), '', 'no index yet: nothing, and the build starts');
  await vault.ensure();
  assert.match(await r.vaultContext('what does my memo say about the raise'), /The raise is a pre-seed/);
});

test('v2 wiring: export watcher (off switch, never in smoke), meaning search, instant ack, early warm-up, topics', () => {
  const main = read('companion/index.js');
  assert.match(main, /enabled: \(\) => store\.getSettings\(\)\.watchImports !== false/);
  assert.match(main, /if \(!process\.argv\.includes\('--smoke'\)\) \{[\s\S]{0,400}getImportWatcher\(\)\.start\(\);/);
  assert.match(main, /embedder: createEmbedder\(/);
  assert.match(main, /sayAck\('recall', source, heardAt\); warmRecallBrain\(\);/);
  assert.match(main, /if \(parseRecallAsk\(text\)\) \{ warmRecallBrain\(\); return; \}/, 'the answer prompt warms while the person is still talking');
  assert.match(main, /system: guideSystemPrompt\(answerSystem\(ANSWER_SYSTEM\)\)/, 'warms exactly the prompt answerPlain sends');
  assert.match(main, /const system = answerSystem\(opts\.system \|\| ANSWER_SYSTEM\);/);
  assert.match(main, /recallTopics: \(\) =>/);
  assert.match(read('companion/src/store.js'), /watchImports: true,\n  watchFolder: '',/);
  const mc = read('src/main-companion.js');
  for (const ch of ['topics', 'watch', 'watch-folder']) assert.ok(mc.includes("handle('home:recall:" + ch + "'"), ch);
  assert.match(mc, /extensions: \['zip', 'json', 'md'\]/);
  const html = read('companion/home/index.html');
  for (const id of ['recall-watch', 'recall-watch-folder', 'topics-card', 'topics-refresh', 'topics-list']) assert.ok(html.includes('id="' + id + '"'), id);
  assert.match(html, /<h3>Topics <span class="badge">beta<\/span><\/h3>/);
  const cfg = read('electron-builder.companion.config.js');
  assert.match(cfg, /from: 'vendor\/embed-models', to: 'embed-models'/);
  assert.match(cfg, /'node_modules\/onnxruntime-node\/\*\*'/);
  assert.match(read('companion/src/voice/lines.js'), /recall: 'Let me check\.'/);
});
