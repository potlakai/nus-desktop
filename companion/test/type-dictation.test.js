// "Type ..." through the talk key: the words after it are typed, whole, whatever
// the classifier makes of them. Every sentence here was said by Pranav into
// Notepad on 2026-11-20 (route.log), where the same ask fired on one press and
// went to the guide ("Let me look") on the next.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { decide, splitClauses, typePayload, plainDictation, words } = require('../src/reflex/router');
const { buildCatalog } = require('../src/reflex/catalog');
const { createReflex } = require('../src/reflex');
const { carriesText } = require('../src/reflex/rules');

const APPS = buildCatalog([{ name: 'Notepad', appId: 'np' }, { name: 'Google Chrome', appId: 'Chrome' }]);
const A = (intent, conf, extra) => Object.assign({ intent: { choice: intent, confidence: conf } }, extra || {});

test('the words to type start after the verb, however whisper wrote the breath after it', () => {
  for (const [said, text] of [
    ['Type, I just built an app.', 'I just built an app'],
    ['Type I just built an app', 'I just built an app'],
    ['Type. I just built an app.', 'I just built an app'],
    ['Type: hello from Nus', 'hello from Nus'],
    ['Type "I built an app"', 'I built an app'],
    ['Can you type? I just wrote an app.', 'I just wrote an app'],
    ['Type in, I just built an app.', 'I just built an app'],
    ['type out hello there', 'hello there'],
    ['Write, I just built an app.', 'I just built an app'],
    ['write down call Akrit on Friday', 'call Akrit on Friday'],
    ['Write this down, the demo is Thursday.', 'the demo is Thursday'],
    ['write these down: milk, eggs', 'milk, eggs'],
    ['please type it out, hello', 'hello'],
  ]) assert.equal(typePayload(said), text, said);
  for (const none of ['open notepad', 'what type of cheese is this', 'I just built an app', 'typewriter', 'write']) assert.equal(typePayload(none), null, none);
});

test('where to type is not what to type', () => {
  for (const [said, text] of [
    // Live: "Notepad, I just built an app" was typed into Notepad.
    ['Type in Notepad, I just built an app.', 'I just built an app'],
    ['Type in notepad. I just built an app. That lets you type at the speed light.', 'I just built an app. That lets you type at the speed light'],
    ['Type in this notepad. I just built a app that lets you right at the speed of light.', 'I just built a app that lets you right at the speed of light'],
    ['type in notepad hello from Nus', 'hello from Nus'],
    ['write in Notepad, hello', 'hello'],
    ['type into the document hello there', 'hello there'],
    ['type in the text box my name is Pranav', 'my name is Pranav'],
    ['type in Word, hello', 'hello'],
    ['type in here: hello', 'hello'],
  ]) assert.equal(typePayload(said), text, said);
  // A name that is also a word goes only with the pause after it; without a
  // place, "in" and "on" after "write" are the text's own.
  assert.equal(typePayload('type in the word hello'), 'the word hello');
  assert.equal(typePayload('type in code we trust'), 'code we trust');
  assert.equal(typePayload('type notepad is great'), 'notepad is great', 'no "in": the name is the text');
  assert.equal(typePayload('write on my way'), 'on my way');
  assert.equal(typePayload('type there are three options'), 'there are three options');
  // The verb and the place and nothing else: no text yet.
  for (const bare of ['Type in.', 'type in notepad', 'Type in Notepad.', 'can you type in the notepad?', 'Type,']) assert.equal(typePayload(bare), '', bare);
});

test('"type ..." is dictation; "write ..." is too, unless it asks for something to be composed', () => {
  for (const yes of ['Type, I just built an app.', 'type hello', 'can you type I am on my way', 'Type in Notepad, I just built an app.', 'Write, I just built an app.', 'write I built an app', 'write this down, the demo is Thursday', 'write down the demo is Thursday']) assert.equal(plainDictation(yes), true, yes);
  for (const no of ['write an email to Professor Lee', 'write me a poem', 'write the report for me', 'write about dogs', 'write a function that sorts', 'type of cheese', 'what type of cheese is this', 'Type in.', 'type', 'enter my name', 'open notepad', 'I just built an app']) assert.equal(plainDictation(no), false, no);
});

test('through the talk key the classifier\'s guess about the sentence does not decide whether it is typed', () => {
  // The classifier reads the sentence after "Type," as chat, a question, or nothing.
  for (const guess of [A('ask', 0.8), A('guide', 0.7), A('none', 0.9), A('type_text', 0.3), Object.assign(A('ask', 0.8), { addressed: { noul: 0.1 } })]) {
    const d = decide('Type, I just built an app that lets you speak at the speed of light.', guess, { final: true, apps: APPS, keyed: true });
    assert.equal(d.fire, true, JSON.stringify(guess));
    assert.equal(d.intent, 'type_text');
    assert.equal(d.text, 'I just built an app that lets you speak at the speed of light');
  }
  // Not on a half sentence, and not from the open room mic, where the classifier keeps its say.
  assert.equal(decide('Type, I just built', A('ask', 0.8), { final: false, apps: APPS, keyed: true }).fire, false);
  const room = decide('Type, I just built an app.', A('ask', 0.8), { final: true, apps: APPS });
  assert.deepEqual([room.fire, room.intent], [false, 'ask']);
  // Composing stays the model's job even through the key.
  assert.equal(decide('write an email to Professor Lee', A('ask', 0.8), { final: true, apps: APPS, keyed: true }).fire, false);
  // The place is cut for the classifier's own type_text too.
  assert.equal(decide('Type in Notepad, I just built an app.', A('type_text', 0.9), { final: true, apps: APPS }).text, 'I just built an app');
  // "called" and "says" inside a typed sentence are its words, not where it starts.
  assert.equal(decide('type my app is called Nus and it says hello', A('type_text', 0.9), { final: true, apps: APPS }).text, 'my app is called Nus and it says hello');
  assert.equal(decide('make the title say hello from nus', A('type_text', 0.9), { final: true, apps: APPS }).text, 'hello from nus', 'no "type" opening: the old rule still reads it');
});

test('a sentence being typed is never cut at the command words inside it', () => {
  const said = 'Type, I just built an app that lets you speak and type at the speed of light. Make it count, then open your eyes.';
  assert.deepEqual(splitClauses(said, { keyed: true }), [said]);
  assert.ok(splitClauses(said).length > 1, 'off the key the old cut stands');
  // A command before it still runs on its own; everything from "type" on is the text.
  assert.deepEqual(splitClauses('open notepad and type I built it. Open Chrome to see', { keyed: true }), ['open notepad', 'type I built it. Open Chrome to see']);
  // Nothing typed: the usual cuts.
  assert.deepEqual(splitClauses('open chrome, search norbert wiener', { keyed: true }), ['open chrome', 'search norbert wiener']);
  assert.deepEqual(splitClauses('open notepad and then type hello', { keyed: true }), ['open notepad', 'type hello']);
});

// A classifier that, like the real one on 2026-11-20, does not see a command in these.
function unsureJev(calls) {
  // ("hello" is the engine warming the connection at start, not an ask.)
  return { ready: () => true, systemOne: async ({ state }) => { if (state.utterance !== 'hello') calls.push(state.utterance); return { answers: { intent: { choice: 'ask', confidence: 0.8 }, addressed: { noul: 0.9 } }, ms: 150, model: 'fake' }; } };
}
function rig() {
  const calls = []; const ops = []; const fires = []; const brain = [];
  const probe = { request: async (op, p) => { ops.push(op + (p && p.text ? ':' + p.text : '')); if (op === 'fg') return { hwnd: 1 }; if (op === 'apps.list') return { apps: [{ name: 'Notepad', appId: 'np' }] }; return { ok: true }; } };
  const reflex = createReflex({ probe, shell: { openExternal: async () => {} }, jevClient: unsureJev(calls), onFire: (f) => fires.push(f), onBrain: (t) => brain.push(t), spawnFn: () => ({ unref() {} }) });
  return { reflex, calls, ops, fires, brain };
}

test('the engine types the sentence, once, with no model asked and nothing sent to the guide', async () => {
  for (const [said, typed] of [
    ['Type, I just built an app.', 'I just built an app'],
    ['Type, I just built an app that lets you speak and type at the speed of light.', 'I just built an app that lets you speak and type at the speed of light'],
    ['Type in Notepad, I just built an app.', 'I just built an app'],
    ['Type, I built an app that lets you type.', 'I built an app that lets you type'],
    ['Type I love to write', 'I love to write'],
  ]) {
    const r = rig();
    await r.reflex.start();
    const out = await r.reflex.handle(said, { final: true, keyed: true });
    assert.deepEqual(r.ops.filter((o) => o.startsWith('keys.text')), ['keys.text:' + typed], said);
    assert.equal(out.fired, 1, said);
    assert.equal(out.brainText, null, said + ': nothing for the guide to "look" at');
    assert.deepEqual(r.brain, []);
    assert.deepEqual(r.calls, [], said + ': the classifier is not asked');
  }
});

test('off the key the same words are still the classifier\'s call', async () => {
  const r = rig();
  await r.reflex.start();
  const out = await r.reflex.handle('Type, I just built an app.', { final: true });
  assert.equal(out.fired, 0);
  assert.deepEqual(r.ops.filter((o) => o.startsWith('keys.text')), []);
  assert.equal(r.calls.length, 1);
});

test('the verb and the place alone are held, and the next words are typed', async () => {
  for (const first of ['Type in.', 'Can you type in the notepad?', 'Type in Notepad.']) {
    const r = rig();
    await r.reflex.start();
    const held = await r.reflex.handle(first, { final: true, keyed: true });
    assert.equal(held.held, 'type', first);
    assert.deepEqual(r.ops.filter((o) => o.startsWith('keys.text')), [], first + ': "in" and "the notepad" are not typed');
    await r.reflex.handle('I just built an app.', { final: true, keyed: true });
    assert.deepEqual(r.ops.filter((o) => o.startsWith('keys.text')), ['keys.text:I just built an app'], first);
  }
});

test('a held "type" waits fifteen seconds for its sentence, a held "open" six', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000000 });
  const a = rig();
  await a.reflex.start();
  await a.reflex.handle('open notepad and type', { final: true, keyed: true });
  t.mock.timers.tick(12000);   // live: the sentence came 12 s later, once Notepad was up
  await a.reflex.handle('Hello from Nus.', { final: true, keyed: true });
  assert.deepEqual(a.ops.filter((o) => o.startsWith('keys.text')), ['keys.text:Hello from Nus']);
  const b = rig();
  await b.reflex.start();
  await b.reflex.handle('type', { final: true, keyed: true });
  t.mock.timers.tick(16000);
  await b.reflex.handle('Hello from Nus.', { final: true, keyed: true });
  assert.deepEqual(b.ops.filter((o) => o.startsWith('keys.text')), [], 'too late: not typed');
  const c = rig();
  await c.reflex.start();
  await c.reflex.handle('open', { final: true, keyed: true });
  t.mock.timers.tick(7000);
  const out = await c.reflex.handle('the pod bay doors', { final: true, keyed: true });
  assert.equal(out.brainText, 'the pod bay doors', 'a held "open" is gone after six seconds, as before');
});

test('the words that hold a sentence open across a pause still see the comma form', () => {
  for (const t of ['Type, I just built an app.', 'Type in, I just built an app.', 'Can you type? I just', 'Write, I built']) assert.equal(carriesText(t), true, t);
  assert.equal(words('Type, I just built an app.').length, 6);
});

test('the Companion passes the key to the engine, and never for the open room mic', () => {
  const main = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.js'), 'utf8');
  assert.match(main, /r\.handle\(text, \{ final: true, heardAt, uttId, keyed: !openMicSource\(source\) \}\)/);
  assert.match(main, /getReflex\(\)\.handle\(text, \{ final: false, uttId: meta && meta\.seg, keyed: !OPEN_MIC \}\)/);
});

// ---- the key comes up mid-sentence, and the whole press is heard again ----
// The real join functions from index.js, with the rest stubbed (as in listen.test.js).
function joinRig({ whole = async () => '', wanted = (t) => carriesText(t) } = {}) {
  const fs = require('fs'), path = require('path'), vm = require('vm');
  const main = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const a = main.indexOf('const MID_PHRASE_MS = 1500;'), b = main.indexOf('function flash(text, ms)');
  assert.ok(a > 0 && b > a);
  const routed = []; const log = []; const asked = [];
  const rules = require('../src/reflex/rules');
  const ctx = { ptt: { held: true, finals: 0, press: 7 }, routed, log, asked, setTimeout, clearTimeout, console, heardSegment() {}, handsOn: () => false, handsFollowUp: () => false,
    carriesText: rules.carriesText, endsMidPhrase: rules.endsMidPhrase, trimCutOff: rules.trimCutOff, wholePressWanted: wanted, routeLog: (m) => log.push(m),
    getListener: () => ({ whole: async (pcm) => { asked.push(pcm); return whole(pcm); } }), routeUtterance: (t, s, at) => routed.push([t, at]) };
  vm.runInNewContext(main.slice(a, b).replace('MID_PHRASE_MS = 1500', 'MID_PHRASE_MS = 40'), ctx);
  return ctx;
}

test('the key comes up while the first half is still being transcribed: both halves go out as one ask', async () => {
  // Live 2026-11-20 00:50:53Z: "Type in, I just built an app." was typed, then
  // "That lets you type in the speed of light." went out as a second ask.
  const c = joinRig({ wanted: () => false });
  c.ptt.held = false; c.ptt.flushing = true;
  c.joinFinal('Type in, I just built an app.', { reason: 'pause', heardAt: 11, seg: 1 });
  assert.deepEqual(c.routed, [], 'the last words of the press are still coming');
  c.joinFinal('That lets you type in the speed of light.', { reason: 'flush', heardAt: 22, seg: 2 });
  assert.deepEqual(c.routed, [['Type in, I just built an app. That lets you type in the speed of light.', 11]]);
  // Once the flush is over a late final is on its own, as before.
  const d = joinRig({ wanted: () => false });
  d.ptt.held = false; d.ptt.flushing = false;
  d.joinFinal('Type hello.', { reason: 'pause', heardAt: 1, seg: 1 });
  assert.deepEqual(d.routed.map((r) => r[0]), ['Type hello.']);
});

test('a typed line waits for the whole press to be heard again, and the careful words go out', async () => {
  const c = joinRig({ whole: async () => 'Type, I just built an app that lets you type at the speed of light.' });
  c.ptt.held = false; c.ptt.flushing = true;
  c.joinFinal('Type, I just build a nap.', { reason: 'pause', heardAt: 11, seg: 1 });
  c.joinFinal('That lets you spread at the speed of light.', { reason: 'flush', heardAt: 22, seg: 2 });
  assert.deepEqual(c.routed, [], 'held for the careful pass');
  c.ptt.flushing = false;
  await c.hearWholePress(Buffer.from('pcm'), 7);
  assert.deepEqual(c.routed, [['Type, I just built an app that lets you type at the speed of light.', 11]]);
  assert.equal(c.asked.length, 1);
  assert.equal(c.ptt.heldText, null);
  assert.match(c.log[0], /whole press heard again in \d+ms: "Type, I just built an app that lets you type.*\(in pieces: "Type, I just build a nap\. That lets you spread/);
  c.routeHeldOnRelease();
  assert.equal(c.routed.length, 1, 'nothing goes out twice');
});

test('the fast words stand when the careful pass has no answer, or one that is no longer the same ask', async () => {
  for (const [better, why] of [['', /gave no answer/], ['Tai hello from Nus.', /not kept: "Tai hello from Nus\."/], ['Type hello from Nus.', /heard the same/]]) {
    const c = joinRig({ whole: async () => better });
    c.ptt.held = false; c.ptt.flushing = true;
    c.joinFinal('Type hello from Nus.', { reason: 'flush', heardAt: 5, seg: 1 });
    c.ptt.flushing = false;
    await c.hearWholePress(Buffer.from('pcm'), 7);
    assert.deepEqual(c.routed, [['Type hello from Nus.', 5]], better);
    assert.match(c.log[0], why);
  }
  // A whisper that throws is no answer either.
  const e = joinRig({ whole: async () => { throw new Error('gone'); } });
  e.ptt.held = false; e.ptt.flushing = true;
  e.joinFinal('Type hello.', { reason: 'flush', heardAt: 5, seg: 1 });
  await e.hearWholePress(Buffer.from('pcm'), 7);
  assert.deepEqual(e.routed.map((r) => r[0]), ['Type hello.']);
});

test('a command is not held for the careful pass, and words from another press are left alone', async () => {
  const c = joinRig({ whole: async () => 'never asked' });
  c.ptt.held = false; c.ptt.flushing = true;
  c.joinFinal('Open Notepad.', { reason: 'flush', heardAt: 1, seg: 1 });
  assert.deepEqual(c.routed.map((r) => r[0]), ['Open Notepad.'], 'out at once, on the fast words');
  await c.hearWholePress(Buffer.from('pcm'), 7);
  assert.equal(c.asked.length, 0);
  // Held since an earlier press (its audio is not this press's audio).
  const d = joinRig({ whole: async () => 'never asked' });
  d.ptt.heldText = { text: 'Type hello from', heardAt: 1, seg: 1, press: 6 };
  await d.hearWholePress(Buffer.from('pcm'), 7);
  assert.equal(d.asked.length, 0);
  assert.equal(d.ptt.heldText.text, 'Type hello from');
  // A careful sentence that stops mid-phrase gets the usual breath before it goes.
  const e = joinRig({ whole: async () => 'Type I am going to the' });
  e.ptt.held = false; e.ptt.flushing = true;
  e.joinFinal('Type I am going to the', { reason: 'flush', heardAt: 1, seg: 1 });
  e.ptt.flushing = false;
  await e.hearWholePress(Buffer.from('pcm'), 7);
  assert.deepEqual(e.routed, []);
  assert.ok(e.ptt.midTimer);
  await new Promise((r) => setTimeout(r, 70));
  assert.equal(e.routed.length, 1);
});

test('key up runs the flush, then the careful pass, then routes what is still held', () => {
  const main = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.js'), 'utf8');
  assert.match(main, /ptt\.flushing = true;\s+try \{ await getListener\(\)\.flush\(\); \} catch \(e\) \{[^}]+\} finally \{ ptt\.flushing = false; \}\s+await hearWholePress\(pcm, press\);\s+routeHeldOnRelease\(\);/);
  assert.match(main, /function wholePressWanted\(text\) \{ return process\.env\.NUS_WHOLE_PRESS !== '0' && !OPEN_MIC && carriesText\(text\); \}/);
});

// ---- the listener: the whole press, and a flush that waits ----
const { createListener } = require('../src/reflex/listen');
const { echoesPrompt } = require('../src/reflex/prompt-echo');
const pcm = (ms, level = 1000) => { const b = Buffer.alloc(ms * 32); for (let i = 0; i < b.length; i += 2) b.writeInt16LE(level, i); return b; };
function residentWhisper(answer, state = 'ready') {
  const asked = [];
  return { asked, warm() {}, status: () => ({ state }), transcribe: async (wav, opts) => { asked.push(Object.assign({ bytes: wav.length }, opts)); return typeof answer === 'function' ? answer(opts) : answer; } };
}

test('the whole press goes to the resident whisper once, as a careful decode with the hint list', async () => {
  const server = residentWhisper((o) => (o.careful ? ' Type, I just built an app.\n' : 'fast'));
  const l = createListener({ transcribe: async () => 'fast', server, vocabulary: () => ['Professor Lee'] });
  assert.equal(await l.whole(pcm(3000)), 'Type, I just built an app.');
  const ask = server.asked.find((a) => a.careful);
  assert.equal(ask.prompt, 'Nūs Companion, Professor Lee.');
  assert.equal(ask.audioCtx, undefined, 'the encoder keeps its whole context');
  assert.equal(ask.timeoutMs, l.CFG.wholeBudgetMs);
  assert.ok(ask.bytes > 3000 * 32, 'the press as one WAV');
});

test('no answer worth having is an empty string: the caller keeps the fast words', async () => {
  // No resident whisper, or one still loading.
  assert.equal(await createListener({ transcribe: async () => 'fast' }).whole(pcm(2000)), '');
  assert.equal(await createListener({ transcribe: async () => 'fast', server: residentWhisper('words', 'starting') }).whole(pcm(2000)), '');
  // It could not answer in time (null), it threw, or there was no audio.
  assert.equal(await createListener({ transcribe: async () => 'fast', server: residentWhisper(null) }).whole(pcm(2000)), '');
  assert.equal(await createListener({ transcribe: async () => 'fast', server: residentWhisper(() => { throw new Error('reset'); }) }).whole(pcm(2000)), '');
  assert.equal(await createListener({ transcribe: async () => 'fast', server: residentWhisper('words') }).whole(Buffer.alloc(0)), '');
  // The hint list said back, a decoder loop, more words than the audio could hold.
  assert.equal(await createListener({ transcribe: async () => 'fast', server: residentWhisper('Nūs Companion.') }).whole(pcm(2000)), '');
  assert.equal(await createListener({ transcribe: async () => 'fast', server: residentWhisper('Nūs Companion, Professor Lee.'), vocabulary: () => ['Professor Lee'] }).whole(pcm(2000)), '');
  assert.equal(await createListener({ transcribe: async () => 'fast', server: residentWhisper('one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty') }).whole(pcm(1500)), '');
  // A new press began while it was decoding: its answer belongs to nobody.
  let l; const late = residentWhisper(() => { l.reset(); return 'Type hello.'; });
  l = createListener({ transcribe: async () => 'fast', server: late });
  assert.equal(await l.whole(pcm(2000)), '');
});

test('the hint list said back is told from speech that only uses its words', () => {
  const prompt = 'Nūs Companion, CS 2110, Professor Lee.';
  for (const echo of ['Nūs Companion, CS 2110, Professor Lee.', 'nūs companion cs 2110 professor lee', 'Nūs Companion, CS 2110, Professor Lee, Nūs Companion']) assert.equal(echoesPrompt(echo, prompt), true, echo);
  // Most of a longer list, in the order it was sent, is still the list.
  assert.equal(echoesPrompt('Nūs Companion, CS 2110, Professor Lee', 'Nūs Companion, CS 2110, Professor Lee, Akrit.'), true);
  // Two of three entries is under the bar: a person may well say just that.
  assert.equal(echoesPrompt('Nūs Companion, CS 2110.', prompt), false);
  for (const speech of ['Type, I just built an app.', 'Email Professor Lee about CS 2110 tomorrow', 'Professor Lee', 'open Nūs Companion settings', '']) assert.equal(echoesPrompt(speech, prompt), false, speech);
  // One phrase in the prompt: it can loop whole; saying part of it is speech.
  assert.equal(echoesPrompt('Nūs Companion. Nūs Companion.', 'Nūs Companion.'), true);
  assert.equal(echoesPrompt('Nūs', 'Nūs Companion.'), false);
});

test('a flush with nothing buffered still waits for the final a pause started', async () => {
  let release; const pending = new Promise((r) => { release = r; });
  const finals = [];
  const l = createListener({ transcribe: () => pending, onFinal: (t, m) => finals.push([t, m.reason]) });
  l.push(pcm(700)); l.push(pcm(500, 0));        // speech, then a pause: its final is with whisper now
  let over = false;
  const done = l.flush().then(() => { over = true; });
  await new Promise((r) => setImmediate(r));
  assert.equal(over, false, 'the press is not over until those words land');
  release('type hello');
  await done;
  assert.deepEqual(finals, [['type hello', 'pause']]);
});

test('the whole press goes to Parakeet first when it is loaded, and to the careful whisper when it is not', async () => {
  const server = residentWhisper((o) => (o.careful ? 'Type, I just build a nap.' : 'fast'));
  const said = [];
  const engine = (ready, answer) => ({ name: 'parakeet', wanted: () => ready, ready: () => ready, transcribe: async (p) => { said.push(p.length); return typeof answer === 'function' ? answer() : answer; } });
  // Loaded: Parakeet's words, and whisper is not asked.
  const l = createListener({ transcribe: async () => 'fast', server, finalEngine: engine(true, ' Type, I just built an app.') });
  assert.equal(await l.whole(pcm(2000)), 'Type, I just built an app.');
  assert.equal(server.asked.filter((a) => a.careful).length, 0);
  assert.equal(said.length, 1);
  // Not loaded, heard nothing, or failed: the careful whisper answers.
  for (const e of [engine(false, 'never'), engine(true, ''), engine(true, () => { throw new Error('worker exited'); })]) {
    const s2 = residentWhisper((o) => (o.careful ? 'Type, I just build a nap.' : 'fast'));
    const l2 = createListener({ transcribe: async () => 'fast', server: s2, finalEngine: e });
    assert.equal(await l2.whole(pcm(2000)), 'Type, I just build a nap.');
    assert.equal(s2.asked.filter((a) => a.careful).length, 1);
  }
  // No whisper either: no answer, the fast words stand.
  assert.equal(await createListener({ transcribe: async () => 'fast', finalEngine: engine(false, 'x') }).whole(pcm(2000)), '');
});
