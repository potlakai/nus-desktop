// Dictation (0.1.37): hold Ctrl + Win, speak, let go, the words are typed in.
// The key, the split, the spacing, where the words go, the stats name, the tour
// card, and that the whole path stays on this computer.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Dictate = require('../src/dictate');
const { wer, total, words } = require('../src/voice/wer');
const { createStats, FEATURES, STEPS } = require('../src/stats');
const Tour = require('../src/tour');
const { createChordTracker } = require('../src/voice/ptt-chord');

const VK = Dictate.VK;
// Read with LF endings: a Windows checkout with autocrlf has CRLF on disk, and the checks below match on a line feed.
const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8').replace(/\r\n/g, '\n');
const dictBlock = src.slice(src.indexOf('// -------- dictation: hold Ctrl + Win'), src.indexOf('// Reflex first. What it acts on never reaches the guide'));

test('Ctrl + Win down is one press, either order, left or right keys', () => {
  for (const [a, b] of [[VK.lcontrol, VK.lwin], [VK.lwin, VK.lcontrol], [VK.rcontrol, VK.rwin], [VK.control, VK.lwin]]) {
    const c = Dictate.createDictateChord();
    assert.equal(c.onKey(a, true), null);
    assert.equal(c.onKey(b, true), 'down');
    assert.equal(c.held, true);
    assert.equal(c.onKey(b, true), null, 'a repeat while held is not a new press');
    assert.equal(c.onKey(a, false), 'up');
    assert.equal(c.held, false);
    assert.equal(c.onKey(b, false), null);
  }
});

test('Alt or Shift joining a held Ctrl + Win cancels it; with them down first it never starts', () => {
  for (const extra of [VK.lalt, VK.ralt, VK.lshift, VK.rshift]) {
    const c = Dictate.createDictateChord();
    c.onKey(VK.lcontrol, true); assert.equal(c.onKey(VK.lwin, true), 'down');
    assert.equal(c.onKey(extra, true), 'cancel');
    assert.equal(c.held, false);
    assert.equal(c.onKey(extra, false), 'down', 'letting the extra key go with Ctrl + Win still held is a fresh press');
  }
  const c = Dictate.createDictateChord();
  c.onKey(VK.lalt, true); c.onKey(VK.lcontrol, true);
  assert.equal(c.onKey(VK.lwin, true), null, 'Ctrl + Alt + Win is not dictation');
});

test('Win alone, Ctrl alone and the talk key are not dictation; winDown is reported for the talk key guard', () => {
  const c = Dictate.createDictateChord();
  assert.equal(c.onKey(VK.lwin, true), null);
  assert.equal(c.winDown, true);
  assert.equal(c.onKey(VK.lwin, false), null);
  assert.equal(c.winDown, false);
  assert.equal(c.onKey(VK.lcontrol, true), null);
  assert.equal(c.onKey(VK.lalt, true), null, 'Ctrl + Alt is the talk key');
  assert.equal(c.onKey(65, true), null, 'a letter is ignored');
});

test('the talk key tracker never fires on Ctrl + Win, and index.js keeps the two apart', () => {
  const talk = createChordTracker('Control+Alt');
  assert.equal(talk.onKey(VK.lcontrol, true), null);
  assert.equal(talk.onKey(VK.lwin, true), null, 'Win is not a key the talk chord watches');
  assert.match(src, /if \(d === 'down' && !ptt\.held\) dictGate\(\);/, 'no dictation while the talk key is held');
  assert.match(src, /if \(r === 'down' && !dict\.held && !\(dict\.tracker && dict\.tracker\.winDown\)\) pttStart\(\);/, 'no talk key while dictating or while Win is down');
});

// What the probe answered on Pranav's PC, 2026-11-23 (op 'focus.text'), per window.
const FOCUS = {
  notepad: { cls: 'Notepad', focusCls: 'RichEditD2DPT', type: 'Document', caret: true, hasValue: true, readOnly: false, hasText: true, textReadOnly: false },
  claudeBox: { cls: 'Chrome_WidgetWin_1', type: 'Group', caret: true, caretVia: 'acc', hasValue: false, hasText: false },
  edgeInput: { cls: 'Chrome_WidgetWin_1', type: 'Edit', caret: true, caretVia: 'acc', hasValue: true, readOnly: false, hasText: true, textReadOnly: false },
  edgeEditable: { cls: 'Chrome_WidgetWin_1', type: 'Group', caret: true, caretVia: 'acc', hasValue: false, hasText: true, textReadOnly: false },
  edgePage: { cls: 'Chrome_WidgetWin_1', type: 'Document', caret: false, hasValue: true, readOnly: true, hasText: true, textReadOnly: true },
  edgeAsleep: { cls: 'Chrome_WidgetWin_1', type: 'Pane', caret: false, hasValue: false, hasText: false },
  explorerFiles: { cls: 'CabinetWClass', focusCls: 'DirectUIHWND', type: 'ListItem', caret: false, hasValue: true, readOnly: false, hasText: false },
  firefoxAsleep: { cls: 'MozillaWindowClass', type: 'Pane', caret: false, hasValue: false, hasText: false },
};

test('Ctrl + Win wakes only where words can go: a text box, a document, a terminal', () => {
  for (const k of ['notepad', 'claudeBox', 'edgeInput', 'edgeEditable']) assert.equal(Dictate.focusTakesText(FOCUS[k]).text, 'yes', k);
  assert.equal(Dictate.focusTakesText({ cls: 'CASCADIA_HOSTING_WINDOW_CLASS', type: 'Text' }).text, 'yes', 'a terminal always takes typing');
  assert.equal(Dictate.focusTakesText({ cls: 'X', type: 'Edit' }).text, 'yes', 'an edit box that says nothing more');
  assert.equal(Dictate.focusTakesText({ cls: 'OpusApp', type: 'Document', hasText: true, textReadOnly: null }).text, 'yes', 'a document that does not say read-only');
});

test('it stays asleep on the desktop, a file list, a button, a read-only page and a password box', () => {
  assert.deepEqual(Dictate.focusTakesText(FOCUS.explorerFiles), { text: 'no', why: 'ListItem' }, 'a file name can be set, but a file list is not a text box');
  assert.equal(Dictate.focusTakesText(FOCUS.edgePage).text, 'no', 'a web page with no box in focus');
  for (const cls of ['Progman', 'WorkerW', 'Shell_TrayWnd']) assert.equal(Dictate.focusTakesText({ cls, type: 'List', caret: false }).text, 'no', cls);
  assert.equal(Dictate.focusTakesText({ cls: 'X', type: 'Button' }).text, 'no');
  assert.equal(Dictate.focusTakesText({ cls: 'X', type: 'Edit', hasValue: true, readOnly: true }).text, 'no', 'a read-only field');
  assert.deepEqual(Dictate.focusTakesText({ cls: 'X', type: 'Edit', caret: true, password: true }), { text: 'no', why: 'password' }, 'even with a caret');
  // A browser that has described its page and shows a bare group (a video player) has no box in focus.
  assert.equal(Dictate.focusTakesText({ cls: 'Chrome_WidgetWin_1', type: 'Group', caret: false }, { second: true }).text, 'no');
});

test('an app that says nothing still gets dictation; a browser is asked once more first', () => {
  const first = Dictate.focusTakesText(FOCUS.edgeAsleep);
  assert.deepEqual([first.text, first.retry], ['unknown', true], 'Edge and Electron describe the page a moment after the first question');
  assert.equal(Dictate.focusTakesText(FOCUS.edgeAsleep, { second: true }).text, 'unknown', 'still asleep: do not lock the person out');
  assert.equal(Dictate.focusTakesText(FOCUS.firefoxAsleep, { second: true }).text, 'unknown', 'Firefox answered Pane every time');
  assert.deepEqual(Dictate.focusTakesText({ cls: 'UnrealWindow', type: 'Pane' }), { text: 'unknown', why: 'Pane', retry: false });
  assert.equal(Dictate.focusTakesText(null).text, 'unknown', 'the probe did not answer in time');
  assert.equal(Dictate.focusTakesText({ ours: true }).text, 'ours');
  assert.deepEqual(['yes', 'unknown', 'no', 'ours'].map((t) => Dictate.gateOpens({ text: t }, false)), [true, true, false, false]);
  assert.equal(Dictate.gateOpens({ text: 'ours' }, true), true, 'the tour card is a Nūs window in front: its practice line still works');
});

test('index.js asks before anything wakes: no mic, no Knot and no hint until the focus takes text', () => {
  const gate = dictBlock.slice(dictBlock.indexOf('async function dictGate'), dictBlock.indexOf('function dictStart'));
  assert.match(gate, /probe\.request\('focus\.text', \{ ignorePid: process\.pid \}, DICT_GATE_MS\)/);
  assert.match(gate, /if \(dict\.gate !== g\) return;/, 'let go before the answer: nothing happens');
  assert.match(gate, /if \(!Dictate\.gateOpens\(verdict, tour && tour\.dictating\)\) \{\s+g\.blocked = true;/);
  assert.doesNotMatch(gate.slice(0, gate.indexOf('dictStart(g);')), /send\(|getParakeet|getHands|flash\(/, 'nothing is shown or loaded before the answer');
  assert.match(gate, /g\.blocked && reason === 'release' && Date\.now\(\) - g\.at >= DICT_NUDGE_MS/, 'only a long hold with no text box is told why');
  assert.match(dictBlock, /dict\.startedAt = gate && gate\.at \? gate\.at : Date\.now\(\);/, 'a tap is timed from the keys going down');
  const ps = fs.readFileSync(path.join(__dirname, '..', 'src', 'win', 'probe.ps1'), 'utf8');
  const op = ps.slice(ps.indexOf("'focus.text' {"), ps.indexOf("'uia.text' {"));
  assert.ok(op.length > 200, 'the probe has the op');
  assert.doesNotMatch(op, /Current\.Value|GetText\(/, 'facts about the focus only: no value or text is read');
});

test('the split is half and half, fixed per install id, and matches the SQL twin', () => {
  const ids = Array.from({ length: 4000 }, () => crypto.randomUUID());
  const on = ids.filter((id) => Dictate.armOf(id) === 'on').length;
  assert.ok(on > 1850 && on < 2150, 'about half: ' + on);
  for (const id of ids.slice(0, 50)) assert.equal(Dictate.armOf(id), Dictate.armOf(id), 'the same every time');
  // The server computes get_byte(sha256(install_id || '|dictate-0137'), 0) % 2 = 0 -> on.
  const id = '96765e17-16bb-4d24-a570-8441ab747300';
  const byte = crypto.createHash('sha256').update(id + '|dictate-0137').digest()[0];
  assert.equal(Dictate.armOf(id), byte % 2 === 0 ? 'on' : 'off');
  assert.equal(Dictate.armOf(''), 'off', 'no install id: off');
});

test('the Settings switch wins either way; unset follows the install half', () => {
  const onId = Array.from({ length: 50 }, () => crypto.randomUUID()).find((id) => Dictate.armOf(id) === 'on');
  const offId = Array.from({ length: 50 }, () => crypto.randomUUID()).find((id) => Dictate.armOf(id) === 'off');
  assert.equal(Dictate.enabled({}, onId), true);
  assert.equal(Dictate.enabled({}, offId), false);
  assert.equal(Dictate.enabled({ dictation: true }, offId), true);
  assert.equal(Dictate.enabled({ dictation: false }, onId), false);
  assert.equal(Dictate.why({}, onId), 'arm-on');
  assert.equal(Dictate.why({ dictation: false }, onId), 'setting');
});

test('the words: tidied, nothing when there are none, a space when they follow the last dictation into the same window', () => {
  assert.equal(Dictate.tidy('  Hello   there. '), 'Hello there.');
  assert.equal(Dictate.tidy(' ... '), '');
  assert.equal(Dictate.tidy(''), '');
  const t = { hwnd: 42 };
  const now = 1e9;
  assert.equal(Dictate.textToPaste('Second line.', t, null, now), 'Second line.');
  assert.equal(Dictate.textToPaste('Second line.', t, { hwnd: 42, at: now - 30000 }, now), ' Second line.');
  assert.equal(Dictate.textToPaste('Second line.', t, { hwnd: 7, at: now - 30000 }, now), 'Second line.', 'another window starts clean');
  assert.equal(Dictate.textToPaste('Second line.', t, { hwnd: 42, at: now - Dictate.JOIN_MS - 1 }, now), 'Second line.', 'a while later starts clean');
});

test('the window the words go to: the front one, or the one behind Nūs', () => {
  const self = 100;
  assert.deepEqual(Dictate.pickTarget({ hwnd: 5, pid: 9, process: 'notepad' }, { hwnd: 6, pid: 8 }, self), { hwnd: 5, process: 'notepad', title: '', behindSelf: false });
  assert.equal(Dictate.pickTarget({ hwnd: 5, pid: self }, { hwnd: 6, pid: 8, process: 'firefox' }, self).hwnd, 6, 'a Nūs card in front: the window behind it');
  assert.equal(Dictate.pickTarget({ hwnd: 5, pid: self }, null, self), null);
  assert.equal(Dictate.pickTarget(null, null, self), null);
});

test('how a dictation ended, in the stats words', () => {
  assert.equal(Dictate.outcomeOf({ text: 'Hi.', paste: { ok: true, how: 'paste' } }), 'ok');
  assert.equal(Dictate.outcomeOf({ text: 'Hi.', paste: { ok: true, how: 'sendkeys' } }), 'ok');
  assert.equal(Dictate.outcomeOf({ text: 'Hi.', paste: { ok: true, how: 'none' } }), 'failed', 'a multi-line paste that could not be confirmed did not go in');
  assert.equal(Dictate.outcomeOf({ text: 'Hi.', paste: { ok: false, error: 'the keys would have gone to Nus itself' } }), 'failed');
  assert.equal(Dictate.outcomeOf({ text: '', paste: null }), 'failed');
  assert.equal(Dictate.outcomeOf({ cancelled: true }), 'cancelled');
});

test('the check log line keeps the raw words and timings, nothing else about the person', () => {
  const line = JSON.parse(Dictate.checkLine({ at: Date.parse('2026-11-23T20:00:00Z'), n: 3, audioMs: 2501.4, engine: 'parakeet', decodeMs: 270, loadMs: 0, keyUpToPasteMs: 612, raw: 'Hello there.', pasted: ' Hello there.', how: 'paste', verified: true, app: 'notepad', wav: '1.wav' }));
  assert.deepEqual(Object.keys(line), ['at', 'n', 'audioMs', 'engine', 'decodeMs', 'loadMs', 'keyUpToPasteMs', 'raw', 'pasted', 'how', 'verified', 'app', 'wav']);
  assert.equal(line.audioMs, 2501);
  assert.equal(line.raw, 'Hello there.');
});

test('word error rate: punctuation, case and hyphens are not errors; substitutions, drops and extras are', () => {
  assert.deepEqual(words("Open Notepad, and make a to-do list."), ['open', 'notepad', 'and', 'make', 'a', 'to', 'do', 'list']);
  assert.equal(wer('Open Notepad.', 'open notepad').errors, 0);
  assert.equal(wer('Search YouTube for lo-fi beats.', 'Search YouTube for Lo Fi beats.').errors, 0);
  const w = wer('Search Norbert Wiener on Google.', 'Serge Norbert Wiener on Google.');
  assert.deepEqual([w.sub, w.del, w.ins, w.ref], [1, 0, 0, 5]);
  assert.deepEqual([wer('thanks for the help', 'thanks the help').del, wer('a b', 'a x b').ins], [1, 1]);
  assert.equal(wer("I'm late", 'I am late').errors, 2, "contractions are compared as written");
  const t = total([{ ref: 'a b c d', hyp: 'a b c d' }, { ref: 'a b c d e f', hyp: 'a b x d e f' }]);
  assert.deepEqual([t.ref, t.errors, t.exact], [10, 1, 1]);
});

function statsRig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nus-stats-dict-'));
  const calls = [];
  let settings = { sendStats: true };
  const stats = createStats({ userData: dir, settings: { get: () => settings, set: (p) => { settings = { ...settings, ...p }; } }, appVersion: '0.1.37', platform: 'win32', packaged: true, env: {},
    fetch: async (url, init) => { calls.push(JSON.parse(init.body)); return { status: 204 }; }, now: () => Date.parse('2026-11-23T10:00:00Z'), setInterval: () => ({ unref() {} }), clearInterval() {}, idleSeconds: () => 0 });
  return { stats, calls, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('a dictation is an ask row named dictation, spoken; never a first ask, never a first win', async () => {
  assert.ok(FEATURES.includes('dictation'));
  assert.ok(STEPS.includes('tour_dictate'));
  const r = statsRig();
  await r.stats.dictation('ok');
  await r.stats.dictation('failed');
  await r.stats.dictation('whatever');
  assert.deepEqual(r.calls.map((c) => c.name), ['ask', 'ask', 'ask']);
  assert.deepEqual(r.calls.map((c) => c.props), [{ mode: 'voice', feature: 'dictation', outcome: 'ok' }, { mode: 'voice', feature: 'dictation', outcome: 'failed' }, { mode: 'voice', feature: 'dictation', outcome: 'ok' }]);
  await r.stats.ask('voice', 'guide');
  assert.equal(r.calls[3].name, 'first_ask', 'the first ask is still the first real ask to the Knot');
  assert.equal(r.stats.status().asked, true);
  r.done();
});

test('the host counts a dictation as engaged, under its own hook, and never through noteAsk or noteWin', () => {
  const note = dictBlock.slice(dictBlock.indexOf('function noteDictation'), dictBlock.indexOf('function dictStart'));
  assert.match(note, /noteEngaged\(\)/);
  assert.match(note, /hooks\.onDictation/);
  assert.doesNotMatch(dictBlock, /noteAsk\(|noteWin\(/, 'not an ask to the Knot, not a first win, no reaction prompt');
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main-companion.js'), 'utf8');
  assert.match(main, /onDictation: outcome => stats\.dictation\(outcome\)/);
  assert.match(main, /installId: \(\) => stats\.installId\(\)/);
  assert.match(main, /if \(typeof patch\.dictation === 'boolean'\) clean\.dictation = patch\.dictation;/, 'the dashboard switch reaches the store');
});

test('the whole path stays on this computer: Parakeet or whisper, the Hands paste, no model, no cloud speech', () => {
  assert.match(dictBlock, /getParakeet\(\)/);
  assert.match(dictBlock, /getListener\(\)\.whole\(/);
  assert.match(dictBlock, /stt-local/);
  assert.match(dictBlock, /getHands\(\)\.request\('keys\.text'/, 'the paste that puts the old clipboard back');
  for (const banned of [/createSTT\(/, /guideLlm\(/, /createLLM\(/, /\.complete\(/, /routeUtterance\(/, /publik/i, /gemini/i, /fetch\(/]) assert.doesNotMatch(dictBlock, banned, String(banned));
});

test('the probe watches the Win keys only when dictation is on; off, it asks for what 0.1.36 asked for', () => {
  const base = dictBlock.slice(dictBlock.indexOf('function applyProbeBase'), dictBlock.indexOf('function dictateCheckDir'));
  assert.match(base, /probe\.setBase\(on \? MOD_VKS\.concat\(Dictate\.WIN_VKS\) : MOD_VKS\)/);
  assert.match(base, /else probe\.setBase\(null\)/);
  assert.match(src, /ptt\.chord = createChordTracker\(wanted\);\n\s+applyProbeBase\(\);/);
  assert.match(src, /hasOwnProperty\.call\(patch, 'dictation'\)\) \{ applyProbeBase\(\);/, 'the switch takes effect at once');
});

test('the test switches: NUS_DICTATION overrides, and a fake mic exists only in a dev run', () => {
  assert.match(dictBlock, /process\.env\.NUS_DICTATION === '1' \|\| process\.env\.NUS_DICTATION === '0'/);
  assert.match(dictBlock, /if \(app\.isPackaged \|\| !process\.env\.NUS_DICTATE_FAKE_WAV\) return null;/, 'a packaged build always listens to the mic');
});

test('a tap, a cancel and silence type nothing; the words go to the window from key-down', () => {
  const stop = dictBlock.slice(dictBlock.indexOf('async function dictStop'));
  assert.match(stop, /reason === 'cancel' \|\| \(reason === 'release' && heldMs < Dictate\.TAP_MS\)/);
  assert.match(stop, /rms16\(pcm\) < RMS_GATE/);
  assert.match(stop, /hwnd: target \? target\.hwnd : undefined, selfPid: process\.pid, max: 5000, retype: false/);
  // Firefox: the read sees the address bar, so an unconfirmed paste must not be typed again (tried 2026-11-23).
  const ps = fs.readFileSync(path.join(__dirname, '..', 'src', 'reflex', 'hands.ps1'), 'utf8');
  const retype = ps.indexOf("$req.retype -eq $false"), sendkeys = ps.indexOf("$how = 'sendkeys'");
  assert.ok(retype > 0 && retype < sendkeys, 'the no-retype branch comes before the SendKeys fallback');
  assert.match(ps.slice(retype, retype + 600), /\$how = 'paste'/);
  assert.match(stop, /'copy-rewrite'/, 'words that could not go in are shown with Copy');
  assert.match(src, /if \(dict\.held\) \{ dict\.chunks\.push\(Buffer\.from\(arrayBuffer\)\); return; \}/, 'dictated audio never reaches the talk key ears');
  assert.match(src, /\(!companionVoiceEnabled \|\| ptt\.held \|\| ptt\.dictating\)\) data = \{ \.\.\.data, speak: undefined \}/, 'the Knot does not speak into an open dictation mic');
  assert.match(dictBlock, /ptt\.dictating = true;/);
  assert.match(dictBlock, /ptt\.dictating = false;/);
});

test('the tour card: once, after the talk key card, on its step number, practice line into the person\'s own app', () => {
  const c = Tour.dictateCard({ caps: {} });
  assert.equal(c.step, Tour.STEP.key);
  assert.equal(c.of, Tour.OF);
  assert.equal(c.kind, 'dictate');
  assert.deepEqual(c.keys, ['Ctrl', 'Win']);
  assert.match(c.body, /like Notepad or a search box/, 'no hello ran (Quick tour, or the hello was off): no claim that Nūs opened Notepad');
  assert.match(Tour.dictateCard({ caps: { helloTyped: true } }).body, /the Notepad I opened/);
  assert.match(Tour.dictateCard({ caps: { helloTyped: false } }).body, /like Notepad or a search box/);
  assert.match(c.chip, /This is my first note with Nūs\./);
  assert.ok(Tour.stuck(c.actions), 'Continue waits for a try, and lights by itself after UNSTICK_MS like every card');
  assert.ok(Tour.cachedLines().includes(c.spoken), 'its line is made ahead, like every tour line');
  assert.ok(Tour.cachedLines().includes(Tour.DICTATE_DONE_LINE));
  assert.match(src, /if \(tour\.step === Tour\.STEP\.key && !tour\.dictateShown && dictationOn\(\)\) \{ tourDictateCard\(\); return; \}/);
  assert.match(src, /noteStep\('tour_dictate'\)/);
});

test('the dashboard has the switch and paints it from the effective state', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'home', 'index.html'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '..', 'home', 'home.js'), 'utf8');
  assert.match(html, /<input id="dictation" type="checkbox">Dictation/);
  assert.match(js, /'dictation':\['dictation',e=>e\.checked\]/);
  assert.match(js, /\$\('#dictation'\)\.checked=!!\(s\._dictation&&s\._dictation\.on\)/);
});

test('the transcript check script scores a log against the sentences', () => {
  const { score } = require('../../scripts/dictate-check');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nus-dict-check-'));
  fs.writeFileSync(path.join(dir, 's.txt'), 'Open Notepad.\nAdd bread and butter.\n');
  fs.writeFileSync(path.join(dir, 'log.jsonl'), [Dictate.checkLine({ raw: 'Open notepad.', engine: 'parakeet' }), Dictate.checkLine({ raw: 'Add bread and better.', engine: 'parakeet' })].join('\n') + '\n');
  const out = [];
  const log = console.log; console.log = (m) => out.push(String(m));
  try { score(path.join(dir, 'log.jsonl'), path.join(dir, 's.txt')); } finally { console.log = log; }
  assert.ok(out.some((l) => /1 of 6 words wrong \(16\.7%\), 1 of 2 sentences word-perfect/.test(l)), out.join('\n'));
  assert.ok(out.some((l) => /More than 1 word in 10/.test(l)));
  fs.rmSync(dir, { recursive: true, force: true });
});
