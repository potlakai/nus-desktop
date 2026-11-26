const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createListener } = require('../src/reflex/listen');
const { earlyVoiceCommand } = require('../src/guide/assignment-router');

const pcm = (ms, level = 1000) => {
  const b = Buffer.alloc(ms * 32);
  for (let i = 0; i < b.length; i += 2) b.writeInt16LE(level, i);
  return b;
};
const tick = () => new Promise(r => setImmediate(r));
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

test('early voice commands require a complete standalone phrase', () => {
  for (const t of ['voice mode off', 'Voice mode of.', 'please turn off the voice mode', 'mute']) assert.equal(earlyVoiceCommand(t), 'voice_off');
  assert.equal(earlyVoiceCommand('voice mode on'), 'voice_on');
  for (const t of ['voice mode', 'voice mode o', 'do not turn off the voice mode', 'say voice mode off', 'voice mode on or off', 'I said voice mode off yesterday']) assert.equal(earlyVoiceCommand(t), null);
});

test('complete partial consumes once even when pause has already queued a final', async () => {
  const pending = deferred(), commands = [], finals = []; let calls = 0;
  const l = createListener({ transcribe: () => { calls++; return pending.promise; },
    onCommand: text => { if (!earlyVoiceCommand(text)) return false; commands.push(text); return true; },
    onFinal: text => finals.push(text) });
  l.push(pcm(700)); l.push(pcm(200));
  const done = l.flush();
  pending.resolve('voice mode off'); await done;
  assert.deepEqual(commands, ['voice mode off']); assert.deepEqual(finals, []);
  assert.equal(calls, 1, 'no redundant final transcription');
  await l.flush(); assert.equal(commands.length, 1);
});

test('reset discards an in-flight final and the next mic session still works', async () => {
  const pending = deferred(), finals = []; let calls = 0;
  const l = createListener({ transcribe: () => ++calls === 1 ? pending.promise : 'voice mode on', onFinal: t => finals.push(t) });
  l.push(pcm(400)); const done = l.flush();
  l.reset(); pending.resolve('voice mode off'); await done;
  assert.deepEqual(finals, []);
  l.push(pcm(400)); await l.flush();
  assert.deepEqual(finals, ['voice mode on']);
});

test('reset also discards queued finals and stale partial commands', async () => {
  const pending = deferred(), heard = []; let calls = 0;
  const l = createListener({ transcribe: () => { calls++; return pending.promise; }, onCommand: t => { heard.push(t); return true; }, onFinal: t => heard.push(t) });
  l.push(pcm(700)); l.push(pcm(200)); const done = l.flush();
  l.reset(); pending.resolve('voice mode off'); await done;
  assert.deepEqual(heard, []); assert.equal(calls, 1);
});

test('an incomplete partial waits for final and ordinary phrases are preserved', async () => {
  const finals = []; let calls = 0;
  const l = createListener({ transcribe: async () => ++calls === 1 ? 'voice mode' : 'voice mode off', onCommand: t => Boolean(earlyVoiceCommand(t)), onFinal: t => finals.push(t) });
  l.push(pcm(700)); await tick(); l.push(pcm(200)); await l.flush();
  assert.deepEqual(finals, ['voice mode off']);
});

test('ordinary segments finishing behind a partial still deliver in order', async () => {
  const pending = deferred(), finals = []; let calls = 0;
  const l = createListener({ transcribe: () => ++calls === 1 ? pending.promise : 'next step', onFinal: t => finals.push(t) });
  l.push(pcm(700)); const first = l.flush();
  l.push(pcm(400)); const second = l.flush();
  pending.resolve('hello there'); await Promise.all([first, second]);
  assert.deepEqual(finals, ['hello there', 'next step']);
});

// The join itself: the real functions from index.js with the rest stubbed.
function joinRig() {
  const fs = require('fs'), path = require('path'), vm = require('vm');
  const main = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const a = main.indexOf('const MID_PHRASE_MS = 1500;'), b = main.indexOf('function flash(text, ms)');
  assert.ok(a > 0 && b > a);
  const routed = [];
  const ctx = { ptt: { held: true, finals: 0 }, routed, setTimeout, clearTimeout, heardSegment() {}, handsOn: () => false, handsFollowUp: () => false, carriesText: () => false,
    endsMidPhrase: require('../src/reflex/rules').endsMidPhrase, trimCutOff: require('../src/reflex/rules').trimCutOff, routeUtterance: (t, s, at) => routed.push([t, at]) };
  vm.runInNewContext(main.slice(a, b).replace('MID_PHRASE_MS = 1500', 'MID_PHRASE_MS = 40'), ctx);
  return ctx;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

test('a final that ends mid-phrase waits for the next one and they go out as one ask', async () => {
  const c = joinRig();
  c.joinFinal('Draft an email to...', { reason: 'pause', heardAt: 111, seg: 1 });
  assert.deepEqual(c.routed, []);
  c.joinFinal('lee@nus.edu,', { reason: 'pause', heardAt: 222, seg: 2 });
  assert.deepEqual(c.routed, [], 'an address, a comma: still open');
  c.joinFinal("saying the demo is Thursday, don't send.", { reason: 'pause', heardAt: 333, seg: 3 });
  assert.deepEqual(c.routed.map(r => r[0]), ["Draft an email to... lee@nus.edu, saying the demo is Thursday, don't send."]);
  assert.equal(c.routed[0][1], 111, 'timed from the first words');
  await sleep(70);
  assert.equal(c.routed.length, 1, 'nothing goes out twice');
});

test('with nothing after it, a mid-phrase final goes out on its own after the wait', async () => {
  const c = joinRig();
  c.joinFinal('Remove my', { reason: 'pause', heardAt: 1, seg: 1 });
  assert.deepEqual(c.routed, []);
  await sleep(70);
  assert.deepEqual(c.routed.map(r => r[0]), ['Remove my']);
  assert.equal(c.ptt.heldText, null);
});

test('a whole sentence does not wait', () => {
  const c = joinRig();
  c.joinFinal('Open Notepad.', { reason: 'pause', heardAt: 1, seg: 1 });
  c.joinFinal('Open Word,', { reason: 'flush', heardAt: 2, seg: 2 });
  assert.deepEqual(c.routed.map(r => r[0]), ['Open Notepad.', 'Open Word,']);
});

test('the words that hold a sentence open keep holding until the key comes up, with no timer', async () => {
  const c = joinRig();
  c.carriesText = () => true;
  c.joinFinal('remember I take CS', { reason: 'pause', heardAt: 1, seg: 1 });
  await sleep(70);
  assert.deepEqual(c.routed, []);
  assert.equal(c.ptt.heldText.text, 'remember I take CS');
  c.routeHeldText();
  assert.deepEqual(c.routed.map(r => r[0]), ['remember I take CS']);
});

test('a sentence held while the key was down still gets the wait when the key comes up, and a new press can finish it', async () => {
  const c = joinRig();
  c.carriesText = () => true;
  c.joinFinal('Open Instagram on...', { reason: 'pause', heardAt: 1, seg: 1 });
  assert.ok(!c.ptt.midTimer, 'held, no timer, while the key is down');
  c.ptt.held = false;
  c.routeHeldOnRelease();
  assert.deepEqual(c.routed, [], 'the release does not send it');
  assert.ok(c.ptt.midTimer, 'it waits');
  await sleep(70);
  assert.deepEqual(c.routed.map(r => r[0]), ['Open Instagram'], 'nothing came: the broken tail does not go to Hands');
  // A whole sentence held the same way goes at once.
  const d = joinRig();
  d.carriesText = () => true;
  d.joinFinal('Open Notepad and write my list', { reason: 'pause', heardAt: 1, seg: 1 });
  d.ptt.held = false;
  d.routeHeldOnRelease();
  assert.deepEqual(d.routed.map(r => r[0]), ['Open Notepad and write my list']);
  // The next press finishes it: the timer goes, and the text joins.
  const e = joinRig();
  e.carriesText = () => false;
  e.ptt.heldText = { text: 'Open Instagram on...', heardAt: 5, seg: 1 };
  e.ptt.held = false;
  e.routeHeldOnRelease();
  clearTimeout(e.ptt.midTimer); e.ptt.midTimer = null;
  e.ptt.held = true;
  e.joinFinal('Firefox.', { reason: 'pause', heardAt: 9, seg: 2 });
  assert.deepEqual(e.routed.map(r => r[0]), ['Open Instagram on... Firefox.']);
  assert.equal(e.routed[0][1], 5);
});

test('trimCutOff: the words leading nowhere go; a finished ask or too little left stays', () => {
  const { trimCutOff } = require('../src/reflex/rules');
  for (const [said, out] of [['Open Instagram on...', 'Open Instagram'], ['Draft an email to', 'Draft an email'], ['Open Notepad and...', 'Open Notepad'], ['Send it to the…', 'Send it'], ['Open Chrome, ', 'Open Chrome'], ['Open Notepad.', 'Open Notepad.'], ['Remove my', 'Remove my'], ['to...', 'to...'], ['open mic on...', 'open mic']]) assert.equal(trimCutOff(said), out, said);
});

test('endsMidPhrase: prepositions, addresses, a trailing comma and a whisper ellipsis; finished asks do not', () => {
  const { endsMidPhrase } = require('../src/reflex/rules');
  for (const t of ['Draft an email to', 'Draft an email to...', 'Meet me at', 'send it to Lee and', 'Write to the', 'lee@nus.edu', '1@gmail. com,', 'Remove my...', 'Email Lee,', 'Add this to my', 'a message saying']) assert.equal(endsMidPhrase(t), true, t);
  for (const t of ['Open Notepad.', 'What is the Nyquist rate?', 'open mic on', 'rewrite this', 'turn it up', 'Thanks.', 'Close tab.', '']) assert.equal(endsMidPhrase(t), false, t);
  assert.equal(endsMidPhrase('Open Notepad,', { keyUp: true }), false, 'whisper ends finished commands in a comma');
  assert.equal(endsMidPhrase('Open Notepad,'), true, 'with the key still down the next words are near');
  assert.equal(endsMidPhrase('Draft an email to', { keyUp: true }), true);
});

test('a new press takes over from the wait, and key up leaves it running', () => {
  const main = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.js'), 'utf8');
  assert.match(main, /if \(ptt\.midTimer\) \{ clearTimeout\(ptt\.midTimer\); ptt\.midTimer = null; \} else ptt\.heldText = null;/);
  assert.match(main, /if \(!ptt\.heldText || ptt\.midTimer\) return;/);
  assert.match(main, /onFinal: joinFinal/);
  assert.match(main, /onPartial: \(text, meta\) => \{ showHeard\(text\); if \(ptt\.heldText \|\| /, 'the next words of a held sentence fire nothing on their own');
});

test('the Knot heard back is nothing: its own lines, whole, and never a person\'s ask or answer', () => {
  const { heardBack, ACKS } = require('../src/voice/lines');
  for (const t of ['After this one.', 'after this one', 'After this one. After this one.', 'Sure, doing that.', 'On it.', 'Let me look', 'Let me check.', 'Okay, reading it.', 'Sure, writing it.', 'Looking.', 'Still on the last task.']) assert.equal(heardBack(t), true, t);
  for (const t of ['Sure.', 'sure', 'yes', 'next', 'After this one open Notepad', 'do this after this one', 'Let me look at that', 'On it now, open Word', '', 'keep going']) assert.equal(heardBack(t), false, t);
  assert.ok(Object.keys(ACKS).length > 0);
  const main = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.js'), 'utf8');
  const route = main.slice(main.indexOf('async function routeUtterance('));
  assert.ok(route.indexOf('heardBack(text)') > 0 && route.indexOf('heardBack(text)') < route.indexOf('getReflex()'), 'before the reflex layer can fire');
  assert.match(route, /heardBack\(text\) && !\(agent && agent\.asking\(\)\)/, 'with a card up the words answer the card');
  assert.match(main, /onPartial: \(text, meta\) => \{ showHeard\(text\); if \(ptt\.heldText \|\| heardBack\(text\)/, 'a partial cannot fire it either');
});
