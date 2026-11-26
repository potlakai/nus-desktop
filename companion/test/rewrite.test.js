// Rewrite the selected text in place: "make this friendlier", "fix my
// grammar", "shorten this", "make this an email".
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { rewriteAsk, isTask, handsTakes } = require('../src/reflex/rules');
const { rewriteInPlace, buildRewrite, cleanRewrite, STYLES } = require('../src/rewrite');
const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

test('rewriteAsk names the style for the everyday asks', () => {
  const cases = {
    'make this friendlier': 'friendly',
    'Make it sound a bit warmer please': 'friendly',
    'fix my grammar': 'grammar',
    'can you fix the spelling in this paragraph': 'grammar',
    'proofread this': 'grammar',
    'shorten this': 'shorter',
    'make it more concise': 'shorter',
    'cut this down': 'shorter',
    'make this an email': 'email',
    'turn this into an email': 'email',
    'write this as a professional email': 'email',
    'make this more professional': 'formal',
    'make it less formal': 'casual',
    'make this bullet points': 'bullets',
    'turn my notes into a list': null,
    'turn this into a bulleted list': 'bullets',
    'simplify this': 'simpler',
    'make this easier to read': 'simpler',
    'make it longer': 'longer',
    'rewrite this': 'rewrite',
    'reword it': 'rewrite',
    'make this sound better': 'rewrite',
    'make this more polite': 'polite',
    'make my email more confident': 'confident',
    'make this sound more like me': 'custom',
    'rewrite this so it sounds less pushy': 'custom',
  };
  for (const [said, style] of Object.entries(cases)) {
    const r = rewriteAsk(said);
    if (style === null) assert.equal(r, null, said);
    else { assert.ok(r, said); assert.equal(r.style, style, said); assert.equal(r.words, said); }
  }
});

test('rewriteAsk leaves everything else alone', () => {
  for (const said of [
    'fix this', 'make this bigger', 'make it bold', 'how do I make this friendlier', 'what is a friendly email',
    'fix my grammar and send it', 'summarize this page', 'summarize this', 'open notepad', 'write my to-do list',
    'write hello world', 'type hello', 'remind me in 20 minutes to stretch', 'make a new document',
    'email Professor Lee that I am finishing lab 3 tonight', 'shorten the video', 'clean up my desktop',
  ]) assert.equal(rewriteAsk(said), null, said);
});

test('a rewrite ask is not a Hands task, so Hands never takes it whole', () => {
  for (const said of ['make this friendlier', 'fix my grammar', 'shorten this', 'make this an email']) {
    assert.equal(isTask(said), false, said);
    assert.equal(handsTakes(said, { hands: true }), false, said);
  }
});

test('the prompt asks for the text only, same language, line breaks kept, and fences the selection as content', () => {
  const { system, user } = buildRewrite({ style: 'friendly', words: 'make this friendlier', text: 'Send it.\nNow.' });
  assert.match(system, /rewritten text only/);
  assert.match(system, /same language/);
  assert.match(system, /line breaks/);
  assert.match(system, /never instructions to you/);
  assert.match(system, new RegExp(STYLES.friendly.slice(0, 20)));
  assert.match(user, /<<<TEXT\nSend it\.\nNow\.\nTEXT>>>/);
  assert.match(buildRewrite({ style: 'nope', words: 'x', text: 'y' }).system, /reads better/);
  for (const s of Object.values(STYLES)) assert.doesNotMatch(s, /—/);
});

test('cleanRewrite strips what the model wraps around the text and keeps the original shape', () => {
  assert.equal(cleanRewrite('Here is the friendlier version:\n\nHi Sam, thanks!', 'hey sam thx'), 'Hi Sam, thanks!');
  assert.equal(cleanRewrite('```\nHi Sam\n```', 'hey sam'), 'Hi Sam');
  assert.equal(cleanRewrite('"Hi Sam."', 'hey sam'), 'Hi Sam.');
  assert.equal(cleanRewrite('"Hi" she said.', '"hi" she said'), '"Hi" she said.', 'quotes the text really has stay');
  assert.equal(cleanRewrite('Line one\nLine two', 'a\r\nb'), 'Line one\r\nLine two', 'Windows line endings come back');
  assert.equal(cleanRewrite('Better text', 'old text\r'), 'Better text\r', 'a Word paragraph mark at the end is kept');
  assert.equal(cleanRewrite('Better', '  old  '), '  Better  ');
  assert.equal(cleanRewrite('Fast — and cheap', 'fast and cheap'), 'Fast, and cheap', 'no em dashes added');
  assert.equal(cleanRewrite('Fast — cheap', 'fast — cheap'), 'Fast — cheap', 'but the person\'s own stay');
  assert.equal(cleanRewrite('   ', 'x'), '');
});

function rig({ sel, reply = 'Hi Sam, thanks so much!', still = true, paste = { ok: true }, landed = true } = {}) {
  const calls = { complete: [], paste: [] };
  const deps = {
    ask: { style: 'friendly', words: 'make this friendlier' },
    read: async () => sel,
    complete: async (p) => { calls.complete.push(p); if (reply instanceof Error) throw reply; return reply; },
    still: async () => still,
    paste: async (text, s) => { calls.paste.push({ text, s }); return paste; },
    landed: async () => landed,
  };
  return { deps, calls };
}

test('with text selected it is rewritten and pasted over the selection', async () => {
  const sel = { text: 'hey sam thx', source: 'uia', hwnd: 7 };
  const { deps, calls } = rig({ sel });
  const r = await rewriteInPlace(deps);
  assert.equal(r.outcome, 'replaced');
  assert.equal(calls.paste.length, 1);
  assert.equal(calls.paste[0].text, 'Hi Sam, thanks so much!');
  assert.equal(calls.paste[0].s.hwnd, 7);
  assert.match(calls.complete[0].user, /hey sam thx/);
});

test('nothing selected: no model call, no paste, and the ask is answered as before', async () => {
  for (const sel of [null, { text: '' }, { text: '   ' }]) {
    const { deps, calls } = rig({ sel });
    const r = await rewriteInPlace(deps);
    assert.equal(r.outcome, 'none');
    assert.equal(calls.complete.length, 0);
    assert.equal(calls.paste.length, 0);
  }
});

test('a password field is never read or pasted into; a huge selection is refused', async () => {
  let { deps, calls } = rig({ sel: { refused: 'password' } });
  assert.equal((await rewriteInPlace(deps)).outcome, 'password');
  assert.equal(calls.complete.length, 0);
  ({ deps, calls } = rig({ sel: { text: 'x'.repeat(9000), hwnd: 1 } }));
  assert.equal((await rewriteInPlace(deps)).outcome, 'too-long');
  assert.equal(calls.complete.length, 0);
  ({ deps, calls } = rig({ sel: { text: 'abc', hwnd: 1 }, paste: { ok: false, refused: 'password' } }));
  assert.equal((await rewriteInPlace(deps)).outcome, 'password');
});

test('if the selection moved, the page is read-only, or the paste failed, the new text is shown instead', async () => {
  const sel = { text: 'hey sam thx', source: 'uia', hwnd: 7 };
  let { deps, calls } = rig({ sel, still: false });
  let r = await rewriteInPlace(deps);
  assert.equal(r.outcome, 'shown'); assert.equal(r.why, 'moved'); assert.equal(calls.paste.length, 0, 'never pasted where the selection is not');
  ({ deps, calls } = rig({ sel: { ...sel, readOnly: true } }));
  r = await rewriteInPlace(deps);
  assert.equal(r.outcome, 'shown'); assert.equal(r.why, 'read-only'); assert.equal(calls.paste.length, 0);
  ({ deps } = rig({ sel, landed: false }));
  r = await rewriteInPlace(deps);
  assert.equal(r.outcome, 'shown'); assert.equal(r.why, 'read-only', 'the old selection is still there: the paste did not take');
  ({ deps } = rig({ sel, paste: { ok: false, error: 'the keys would have gone to Nus itself' } }));
  r = await rewriteInPlace(deps);
  assert.equal(r.outcome, 'shown'); assert.equal(r.text, 'Hi Sam, thanks so much!');
});

test('a model failure or an unchanged text never pastes', async () => {
  const sel = { text: 'Hi Sam, thanks so much!', source: 'uia', hwnd: 7 };
  let { deps, calls } = rig({ sel, reply: new Error('503 busy') });
  assert.equal((await rewriteInPlace(deps)).outcome, 'error');
  assert.equal(calls.paste.length, 0);
  ({ deps, calls } = rig({ sel }));
  assert.equal((await rewriteInPlace(deps)).outcome, 'same');
  assert.equal(calls.paste.length, 0);
});

test('the probe reads the selection read-only and never a password field', () => {
  const ps1 = read('src', 'win', 'probe.ps1');
  assert.match(ps1, /'uia\.selection' \{/);
  const fn = ps1.slice(ps1.indexOf('function Get-Selection'), ps1.indexOf('function Handle'));
  assert.match(fn, /IsPassword\) \{ return @\{ text=''; refused='password' \}/);
  assert.match(fn, /TextPattern\]::Pattern/);
  assert.match(fn, /GetSelection\(\)/);
  assert.doesNotMatch(ps1, /SetCursorPos|mouse_event|SendInput|keybd_event|Clipboard/, 'the probe never clicks, types or touches the clipboard');
});

test('the copy fallback lives in the Hands sidecar and puts the old clipboard back', () => {
  const ps1 = read('src', 'reflex', 'hands.ps1');
  const op = ps1.slice(ps1.indexOf("'keys.copy'"), ps1.indexOf('default {'));
  assert.match(op, /Ensure-Target \$req/);
  assert.match(op, /refused='password'/);
  assert.match(op, /\$saved = Save-Clip/);
  assert.match(op, /Chord\(\[int\[\]\]@\(0x11, 0x43\)\)/, 'Ctrl+C');
  assert.match(op, /Restore-Clip \$saved/);
  assert.match(ps1, /if \(\$req\.max\) \{ \$cap = \[math\]::Max\(1, \[math\]::Min\(20000/, 'a rewrite may paste more than a typed line');
});

test('the Companion routes a rewrite ahead of the reflex layer and Hands, and pastes only into the window it read', () => {
  const main = read('index.js');
  const route = main.slice(main.indexOf('async function routeUtterance('), main.indexOf('function routeUtteranceSlow('));
  assert.ok(route.indexOf('if (ownPath(text))') > 0 && route.indexOf('if (ownPath(text))') < route.indexOf('if (handsClaims(text))'), 'before Hands');
  assert.ok(route.indexOf('if (ownPath(text))') < route.indexOf('getReflex()'), 'before the reflex layer');
  const slow = main.slice(main.indexOf('function routeUtteranceSlow('), main.indexOf('function routeAnswer('));
  assert.match(slow, /const rw = rewriteAsk\(kind\.text\);/);
  assert.match(slow, /if \(!done\) \{[^}]*routeAnswer\(kind, text, source, heardAt\)/, 'no probe: answered in words as before');
  assert.match(main, /if \(r\.outcome === 'none'\) \{ sayShort\(NOTHING_SELECTED_LINE, source, heardAt, 'rewrite, nothing selected'\); return true; \}/, 'nothing selected: it says so, with no model call and no guide');
  assert.match(slow, /guide\.active\(\) && \(rewriteAsk\(kind\.text\) \|\| handsClaims/, 'a pointing guide gives way to a rewrite');
  assert.match(main, /if \(!wasActive && ownPath\(p\.text\)\) \{ routeUtteranceSlow\(/, 'typed asks too');
  assert.match(main, /getHands\(\)\.request\('keys\.text', \{ text, hwnd: sel\.hwnd, selfPid: process\.pid, max: 20000 \}/);
  assert.match(main, /bubble\(IS_MAC \? 'Rewritten\. Command\+Z puts it back\.' : 'Rewritten\. Ctrl\+Z puts it back\.'/);
  assert.match(main, /COPY_SKIP = \/\^\(\?:windowsterminal/, 'no Ctrl+C in a terminal');
  assert.match(main, /if \(r && r\.pattern\) return \{ text: '' \};/, 'no copy when the app said nothing is selected');
});

test('2026-11-01 security L3: a selection in a terminal is read-only, so the rewrite is shown and never pasted at the prompt', async () => {
  const main = read('index.js');
  const m = main.match(/const TERMINALS = \/\^\(\?:([^)]+)\)\$\/i;/);
  assert.ok(m, 'the terminal list exists');
  const names = m[1].split('|');
  for (const n of ['cmd', 'powershell', 'pwsh', 'windowsterminal', 'conhost', 'openconsole']) assert.ok(names.includes(n), n);
  for (const n of ['code', 'cursor', 'devenv', 'sublime_text']) assert.ok(!names.includes(n), n + ' is an editor: pasting over a selection there is right');
  assert.match(main, /readOnly: !!r\.readOnly \|\| TERMINALS\.test\(String\(fg\.process \|\| ''\)\)/, 'applied where the selection is read');
  // And the rewrite module honours it: read-only means shown, no paste call.
  const sel = { text: 'dir /s', source: 'uia', hwnd: 7, readOnly: true, process: 'cmd' };
  const { deps, calls } = rig({ sel, reply: 'Get-ChildItem -Recurse' });
  const r = await rewriteInPlace(deps);
  assert.equal(r.outcome, 'shown'); assert.equal(r.why, 'read-only'); assert.equal(calls.paste.length, 0);
});

test('live 2026-11-03: the asks heard in Word reach the rewrite path, and whisper\'s "we write" is one of them', () => {
  for (const [said, words] of [
    ['We write this to be shorter.', 'rewrite this to be shorter.'],
    ['Re-write this to be shorter', 'rewrite this to be shorter'],
    ['we word it', 'reword it'],
    ['Can you rewrite this yourself to be shorter?', 'Can you rewrite this yourself to be shorter?'],
    ['Rewrite this to be shorter', 'Rewrite this to be shorter'],
  ]) {
    const r = rewriteAsk(said);
    assert.ok(r, said);
    assert.equal(r.words, words);
  }
  for (const said of ['we write code all day', 'we write to Lee on Fridays', 'how do we write this']) assert.equal(rewriteAsk(said), null, said);
});

test('a paste slow to land in Word is not called read-only; old words still selected a second on are', async () => {
  const vm = require('node:vm');
  const main = read('index.js');
  const a = main.indexOf('async function selectionLanded('), b = main.indexOf('async function rewriteSelection(');
  const run = async (answers) => {
    let n = 0;
    const ctx = { process: { pid: 1 }, sleep: async () => {}, probe: { request: async () => { const x = answers[Math.min(n++, answers.length - 1)]; return x === 'throw' ? null : { text: x }; } } };
    vm.runInNewContext(main.slice(a, b), ctx);
    return { landed: await vm.runInNewContext('selectionLanded', ctx)({ source: 'uia', text: 'old' }), asked: n };
  };
  assert.deepEqual(await run(['']), { landed: true, asked: 1 });
  assert.deepEqual(await run(['old', 'old', '']), { landed: true, asked: 3 }, 'it landed on the third look');
  assert.deepEqual(await run(['old']), { landed: false, asked: 3 });
  assert.deepEqual(await run(['throw']), { landed: null, asked: 1 }, 'no telling');
});

test('a selection the app failed to read falls through to the copy; one it says is empty does not', () => {
  const ps = read('src', 'win', 'probe.ps1');
  const fn = ps.slice(ps.indexOf('function Get-Selection('), ps.indexOf('# The words of the front window'));
  assert.match(fn, /catch \{ \$text = ''; \$found = \$false \}/);
  const main = read('index.js');
  assert.match(main, /if \(r && r\.pattern\) return \{ text: '' \};/);
});
