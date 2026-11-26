'use strict';
// A person with no working microphone must be able to finish the whole tour by typing (friend test of
// 0.1.20, 2026-11-11: the tour offered typing, he typed his name, nothing registered, and the card had
// no way on). These tests walk every card in typed mode and pin the wiring that makes a typed answer count.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const T = require('../src/tour');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
// No microphone words (whisper false), no AI, no Hands: the barest PC.
const typedCaps = { whisper: false, source: false, cli: false, keyReady: false, hands: false, english: true, ptt: 'Control+Alt', device: '', island: false, hideFromCapture: false, captureForcedOff: false, voice: { installed: true } };

test('every card, typed: a way on that always works (an enabled button, a typed answer, or Continue lighting by itself), and Skip the tour', () => {
  for (let step = 0; step <= T.OF; step++) {
    const c = T.card(step, { caps: typedCaps, name: '' });
    const enabled = (c.actions || []).some((a) => !a.disabled);
    const lights = T.stuck(c.actions) && T.unstuck(c.actions).some((a) => a.id === 'tour-next' && !a.disabled);
    assert.ok(enabled || lights, 'card ' + step + ' (' + c.kind + ') has a way on');
    if (step >= 1 && step < T.OF) assert.equal(c.skip, true, 'card ' + step + ' shows Skip the tour');
  }
  assert.ok(T.UNSTICK_MS > 0 && T.UNSTICK_MS <= 10000, 'a waiting Continue lights within ten seconds');
});

test('the typed cards wait for what they ask for, whether or not a microphone works', () => {
  assert.equal(T.hearFor(T.STEP.key), 'name', 'the name card waits for a name, typed or spoken');
  assert.equal(T.hearFor(T.STEP.questions), 'q1');
  assert.equal(T.hearFor(T.STEP.mic), null);
  const key = T.card(T.STEP.key, { caps: typedCaps });
  assert.deepEqual(key.input, { action: 'tour-name', placeholder: 'Your name', label: 'Continue' });
  assert.match(key.body, /type your name/);
  const q = T.card(T.STEP.questions, { caps: typedCaps });
  assert.equal(q.input.action, 'tour-answer');
  assert.ok(q.actions.some((a) => a.id === 'tour-skip-questions' && !a.disabled), 'the questions can be skipped');
});

test('a typed name: read like a spoken one, and plain names taken as typed', () => {
  assert.equal(T.typedName('Maya'), 'Maya');
  assert.equal(T.typedName('my name is maya'), 'Maya');
  assert.equal(T.typedName('  pranav  '), 'Pranav');
  assert.equal(T.typedName('Maya Lopez Garcia'), 'Maya Lopez Garcia', 'three words typed are a name, not a sentence');
  assert.equal(T.typedName('Jean-Luc'), 'Jean-Luc');
  assert.equal(T.typedName('what is 2+2'), '');
  assert.equal(T.typedName(''), '');
});

test('wiring: the typed name counts, moves on, and no card can hold the tour', () => {
  const idx = read('companion/index.js');
  assert.match(idx, /tour\.hear = Tour\.hearFor\(tour\.step\);/, 'set for typed and spoken alike (0.1.20 set nothing when typing)');
  assert.doesNotMatch(idx, /Tour\.STEP\.key && tour\.caps\.whisper \? 'name'/, 'the old rule is gone');
  assert.match(idx, /if \(action === 'tour-name' && tour\.step === S\.key\) \{ tourHeard\(text, 'typed'\); return; \}/);
  const heard = idx.slice(idx.indexOf('function tourHeard('), idx.indexOf('function tourHome('));
  assert.match(heard, /const name = typed \? Tour\.typedName\(t\) : Tour\.nameFrom\(t\);/);
  assert.match(heard, /if \(!name\) \{[^\n]*actions: Tour\.continueActions\(false\)/, 'not a name: Continue still works');
  assert.match(heard, /if \(typed\) \{ const T = tour, step = T\.step; setTimeout\(\(\) => \{ if \(tour === T && T\.step === step\) tourNext\(\); \}, 1500\); \}/, 'a typed name moves on by itself');
  assert.match(idx, /tourUnstick\(card\);\n\}/, 'every card arms the Continue that lights by itself');
  assert.match(idx, /send\('tour:update', \{ actions: Tour\.unstuck\(card\.actions\) \}\)/);
  assert.match(idx, /if \(action === 'tour-answer' && tour\.step === S\.questions && \/\^q\[123\]\$\/\.test\(String\(tour\.hear\)\)\) \{ tourHeard\(text, 'typed'\); return; \}/);
});

test('the microphone card says what it saw in route.log, so a tester can send it', () => {
  const idx = read('companion/index.js'), r = read('companion/renderer/renderer.js');
  assert.match(idx, /if \(\/\^\(mic\[: \]\|tour mic\|voice: \(said\|not said\)\)\/\.test\(String\(msg \|\| ''\)\)\) routeLog\(String\(msg\)\.slice\(0, 300\)\);/);
  assert.match(r, /nus\.log\('mic: ' \+ found\.list\.length \+ ' input device\(s\), default '/);
  assert.match(r, /nus\.log\('tour mic: failed \('/);
  assert.match(r, /nus\.log\('tour mic: ' \+ kind \+ ' after '/);
});

test('the hello line is spoken, in Fable, and the log says how (Pranav\'s try of 0.1.20: not heard)', () => {
  const idx = read('companion/index.js'), r = read('companion/renderer/renderer.js');
  // The Knot's window learns the voice state whenever it loads; it missed the one announcement.
  const load = idx.slice(idx.indexOf("win.webContents.on('did-finish-load', () => {"), idx.indexOf("win.webContents.on('did-finish-load', () => {") + 600);
  assert.match(load, /send\('voice:state', getVoice\(\)\.status\(\)\)/);
  // The hello waits for Fable (up to 8 s) before its card and line, and logs what it did.
  const hello = idx.slice(idx.indexOf('async function tourHello('), idx.indexOf('function tourLater('));
  assert.match(hello, /await Promise\.race\(\[v\.warm\(\), sleep\(8000\)\]\)/);
  assert.ok(hello.indexOf("send('voice:state', now)") < hello.lastIndexOf('tourCardOut()'), 'the window knows Fable is ready before the line is sent');
  assert.match(hello, /routeLog\('hello line: '/);
  assert.match(hello, /getVoice\(\)\.synth\(Tour\.HELLO_LINE\)\)\.then\(\(a\) => \{ getLines\(\)\.put\(Tour\.HELLO_LINE, a\);/, 'the line is made in Fable while the note is typed');
  assert.ok(hello.indexOf('getVoice().synth(Tour.HELLO_LINE)') < hello.indexOf('Hello.run('), 'started before the typing');
  // The renderer reports how each card's line was said, and that goes in route.log.
  assert.match(r, /vlog\('voice: said in Fable: "'/);
  assert.match(r, /vlog\('voice: said in the Windows voice \('/);
  assert.match(r, /vlog\('voice: not said \('/);
  assert.match(r, /function vlog\(m\) \{ try \{ if \(nus\.log\) nus\.log\(m\); \} catch/, 'a log line never stops the speech');
  assert.match(idx, /voice: \(said\|not said\)\)\/\.test\(String\(msg \|\| ''\)\)\) routeLog/);
});

test('the name card always offers typing, even with a working microphone, and a typed name corrects a misheard one', () => {
  const spoken = T.card(T.STEP.key, { caps: Object.assign({}, typedCaps, { whisper: true }) });
  assert.deepEqual(spoken.input, { action: 'tour-name', placeholder: 'Or type your name', label: 'Continue' });
  assert.equal(spoken.chip, 'My name is ...', 'speaking stays the main way');
  const idx = read('companion/index.js');
  assert.match(idx, /' Not quite\? Say it again, or type it below\.'/);
  // The questions card already takes typed answers beside spoken ones.
  assert.equal(T.card(T.STEP.questions, { caps: Object.assign({}, typedCaps, { whisper: true }) }).input.placeholder, 'Or type your answer');
});
