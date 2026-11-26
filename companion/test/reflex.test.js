const test = require('node:test');
const assert = require('node:assert');
const { splitClauses, spokenDomain, decide, buildQuestions, words, INTENTS, POLICY } = require('../src/reflex/router');
const { buildCatalog } = require('../src/reflex/catalog');
const { createReflex, opensLikeGuideAsk } = require('../src/reflex');
const { CHORDS } = require('../src/reflex/executor');

test('code can tell a request for guidance from a command by how it opens', () => {
  for (const yes of ['where is the view menu', 'How do I make a pivot table?', 'hey nus, help me set up Stripe', 'can you show me where the export button is', 'walk me through adding a column', 'point at the save button', "where's word wrap"]) {
    assert.ok(opensLikeGuideAsk(yes), yes);
  }
  // Commands, and sentences that merely contain the words, never start a screen read this way.
  for (const no of ['open notepad', 'type where is the view menu', 'search how do i make a pivot table', 'create a new note', 'thanks', '', 'somewhere is fine']) {
    assert.ok(!opensLikeGuideAsk(no), no);
  }
});

const APPS = buildCatalog([
  { name: 'Notepad', appId: 'Microsoft.WindowsNotepad_8wekyb3d8bbwe!App' },
  { name: 'Google Chrome', appId: 'Chrome' },
  { name: 'Uninstall Foo', appId: 'foo.uninstall' },
  { name: 'Excel', appId: 'Microsoft.Office.EXCEL.EXE.15' }
]);

test('catalog drops junk and carries spoken aliases', () => {
  assert.deepStrictEqual(APPS.map((a) => a.name).sort(), ['Excel', 'Google Chrome', 'Notepad']);
  assert.match(APPS.find((a) => a.name === 'Notepad').describe, /notes app/);
});

test('clauses split on command verbs only', () => {
  assert.deepStrictEqual(splitClauses('open chrome, search norbert wiener, and open x dot com in a new tab'),
    ['open chrome', 'search norbert wiener', 'open x dot com in a new tab']);
  assert.deepStrictEqual(splitClauses('search for salt and pepper'), ['search for salt and pepper']);
  assert.deepStrictEqual(splitClauses('open notepad and then type hello'), ['open notepad', 'type hello']);
  assert.deepStrictEqual(splitClauses('Alright, can you open up the notes app for me and, once you\'re there, can you create a new note?').length, 3);
  // Live 2026-10-11: one clause, Word opened, the how-to was lost three times.
  assert.deepStrictEqual(splitClauses('Open Word and teach me how to create a table.'), ['Open Word', 'teach me how to create a table.']);
  assert.deepStrictEqual(splitClauses('open excel and show me where the sum button is'), ['open excel', 'show me where the sum button is']);
  assert.deepStrictEqual(splitClauses('open chrome and how do I clear my history'), ['open chrome', 'how do I clear my history']);
  assert.deepStrictEqual(splitClauses('search how to type faster'), ['search how to type faster'], 'no "and": nothing to split');
});

test('spoken domains are read by code', () => {
  assert.strictEqual(spokenDomain('now can you open up X dot com'), 'https://x.com');
  assert.strictEqual(spokenDomain('go to github.com please'), 'https://github.com');
  assert.strictEqual(spokenDomain('open notepad'), null);
});

test('word options cover every word that was said', () => {
  const { ws, questions } = buildQuestions('google search norbert wiener', APPS);
  assert.deepStrictEqual(ws, words('google search norbert wiener'));
  assert.ok(questions.slot_start.criteria.w2.includes('norbert'));
  assert.ok(questions.app.criteria.none);
  assert.ok(questions.intent.criteria.none);
});

const A = (intent, conf, extra) => Object.assign({ intent: { choice: intent, confidence: conf } }, extra || {});

test('a half sentence only fires launches, and only when sure', () => {
  const app = { app: { choice: APPS.find((a) => a.name === 'Notepad').key, confidence: 0.95 } };
  assert.strictEqual(decide('open up the notes app', A('open_app', 0.93, app), { final: false, apps: APPS }).fire, true);
  assert.strictEqual(decide('open up the no', A('open_app', 0.93, { app: { choice: 'none', confidence: 0.6 } }), { final: false, apps: APPS }).fire, false);
  assert.strictEqual(decide('open up the notes', A('open_app', 0.6, app), { final: false, apps: APPS }).fire, false);
  assert.strictEqual(decide('type hello wor', A('type_text', 0.99, { slot_start: { choice: 'w1', confidence: 0.9 }, slot_end: { choice: 'w2', confidence: 0.9 } }), { final: false, apps: APPS }).fire, false);
  assert.strictEqual(decide('close that ta', A('close_tab', 0.99), { final: false, apps: APPS }).fire, false);
});

test('new item, new tab and close tab need a clear ask: a half-heard how-to never opens a document', () => {
  // Live 2026-10-11: "how do I insert a table" clipped to "I insert a table", Jev said new_item 0.57, Ctrl+N hit Word.
  const clipped = decide('I insert a table', A('new_item', 0.57), { final: true, apps: APPS });
  assert.strictEqual(clipped.fire, false); assert.strictEqual(clipped.brain, true, 'the words go to the thinking model');
  assert.strictEqual(decide('how do I make a new document', A('new_item', 0.9), { final: true, apps: APPS }).fire, false);
  assert.strictEqual(decide('new tab', A('new_tab', 0.7), { final: true, apps: APPS }).fire, true, 'the rules client gives 0.7');
  assert.strictEqual(decide('create a new note', A('new_item', 0.92), { final: true, apps: APPS }).fire, true);
  assert.strictEqual(decide('close this tab', A('close_tab', 0.6), { final: true, apps: APPS }).fire, false);
});

test('finished clauses: slots are copied from the words, never invented', () => {
  const d = decide('google search norbert wiener', A('web_search', 0.9, { slot_start: { choice: 'w2', confidence: 0.8 }, slot_end: { choice: 'w3', confidence: 0.8 } }), { final: true, apps: APPS });
  assert.strictEqual(d.fire, true);
  assert.strictEqual(d.text, 'norbert wiener');
  const t = decide('make the title say "Hello."', A('type_text', 0.9, { slot_start: { choice: 'w4', confidence: 0.8 }, slot_end: { choice: 'w4', confidence: 0.8 } }), { final: true, apps: APPS });
  assert.strictEqual(t.text, 'Hello');
});

test('command words are cut by code; Jev only has to find the end', () => {
  const none = { slot_start: { choice: 'none', confidence: 0.9 }, slot_end: { choice: 'none', confidence: 0.9 } };
  assert.strictEqual(decide('add a note call akrit on friday', A('remember_note', 0.99, none), { final: true, apps: APPS }).text, 'call akrit on friday');
  assert.strictEqual(decide('can you remember that the pop script is due tuesday', A('remember_note', 0.99, none), { final: true, apps: APPS }).text, 'the pop script is due tuesday');
  assert.strictEqual(decide('search for cheap flights to austin on google', A('web_search', 0.99, none), { final: true, apps: APPS }).text, 'cheap flights to austin');
  assert.strictEqual(decide('lets make the title say hello from nus', A('type_text', 0.99, none), { final: true, apps: APPS }).text, 'hello from nus');
  assert.strictEqual(decide('type i built a working nus with jev', A('type_text', 0.99, none), { final: true, apps: APPS }).text, 'i built a working nus with jev');
  // No known prefix: Jev's start is pulled back to the earliest word it gave real weight to.
  const fuzzy = { slot_start: { choice: 'w4', confidence: 0.53, probabilities: { w3: 0.3, w4: 0.53, none: 0.1 } }, slot_end: { choice: 'w6', confidence: 0.44 } };
  assert.strictEqual(decide('jot this down call akrit on friday', A('remember_note', 0.9, fuzzy), { final: true, apps: APPS }).text, 'call akrit on friday');
});

test('help and questions go to the thinking model, filler goes nowhere', () => {
  const g = decide('help me make a pivot table', A('guide', 0.9), { final: true, apps: APPS });
  assert.deepStrictEqual([g.fire, g.brain], [false, true]);
  const n = decide('great great', A('none', 0.95), { final: true, apps: APPS });
  assert.deepStrictEqual([n.fire, n.brain], [false, false]);
  const u = decide('do the thing with the stuff from before', A('type_text', 0.3), { final: true, apps: APPS });
  assert.deepStrictEqual([u.fire, u.brain], [false, true]);
});

test('the registry has nothing destructive in it', () => {
  const banned = /delete|remove|send|email|pay|buy|purchase|password|shutdown|format|uninstall|post|publish/i;
  for (const k of Object.keys(INTENTS)) assert.ok(!banned.test(k), k);
  for (const k of Object.keys(CHORDS)) assert.ok(INTENTS[k], k + ' must be a registered intent');
  assert.ok(POLICY.earlyIntents.size === 2);
});

// A scripted Jev: answers by looking at the utterance, like the real one would.
function fakeJev(calls) {
  return {
    ready: () => true,
    systemOne: async ({ state }) => {
      const u = state.utterance.toLowerCase();
      calls.push(u);
      const ws = words(state.utterance);
      const notepad = APPS.find((a) => a.name === 'Notepad').key;
      let answers = { intent: { choice: 'none', confidence: 0.9 } };
      if (/notes app|notepad/.test(u)) answers = { intent: { choice: 'open_app', confidence: 0.95 }, app: { choice: notepad, confidence: 0.95 } };
      else if (/^open up the no/.test(u)) answers = { intent: { choice: 'open_app', confidence: 0.9 }, app: { choice: 'none', confidence: 0.5 } };
      else if (/type/.test(u)) answers = { intent: { choice: 'type_text', confidence: 0.9 }, slot_start: { choice: 'w1', confidence: 0.9 }, slot_end: { choice: 'w' + (ws.length - 1), confidence: 0.9 } };
      else if (/pivot/.test(u)) answers = { intent: { choice: 'guide', confidence: 0.9 } };
      return { answers, ms: 120, model: 'fake' };
    }
  };
}

function fakeProbe(log) {
  let hwnd = 100;
  return {
    request: async (op, p) => {
      log.push(op + (p && p.text ? ':' + p.text : ''));
      if (op === 'fg') return { hwnd: hwnd++ };
      if (op === 'apps.list') return { apps: [{ name: 'Notepad', appId: 'np' }] };
      return { ok: true };
    }
  };
}

test('streaming: a launch fires once on the partial, the rest waits for the end', async () => {
  const calls = []; const ops = []; const fires = [];
  // spawnFn: do not really launch anything from a unit test.
  const reflex = createReflex({ probe: fakeProbe(ops), shell: { openExternal: async () => {} }, jevClient: fakeJev(calls), onFire: (f) => fires.push(f), spawnFn: () => ({ unref() {} }) });
  await reflex.start();
  await reflex.handle('open up the no', { final: false });
  assert.strictEqual(fires.length, 0);
  await reflex.handle('open up the notes app', { final: false });
  assert.strictEqual(fires.length, 1);
  assert.strictEqual(fires[0].early, true);
  await reflex.handle('open up the notes app and type hello there', { final: false });
  assert.strictEqual(fires.length, 1, 'typing never fires on a partial');
  const out = await reflex.handle('open up the notes app and type hello there', { final: true });
  assert.strictEqual(fires.length, 2);
  assert.strictEqual(fires[1].intent, 'type_text');
  assert.ok(ops.includes('keys.text:hello there'));
  assert.strictEqual(out.handled, true);
  assert.strictEqual(out.brainText, null);
});

// 2026-09-21, real microphone: whisper looped and one sentence opened 43 Firefox windows.
const LOOP = 'then go to Firefox ' + 'and then go to Firefox '.repeat(42).trim();

test('a transcription loop is collapsed, and an impossible transcript is thrown away', () => {
  const { collapseLoops, plausible, clean } = require('../src/reflex/listen');
  assert.strictEqual(collapseLoops('then go to Firefox and then go to Firefox and then go to Firefox and then go to Firefox'), 'then go to Firefox and then go to Firefox');
  assert.ok(collapseLoops(LOOP).split(' ').length < 12, 'the 43x loop collapses to one or two phrases');
  assert.strictEqual(collapseLoops('great great okay lets move on'), 'great great okay lets move on', 'saying a word twice is normal');
  assert.strictEqual(collapseLoops('open notepad create a new note type hello from nus'), 'open notepad create a new note type hello from nus');
  assert.strictEqual(plausible('open notepad and type hello', 2000), true);
  assert.strictEqual(plausible(LOOP, 3000), false, '170 words do not fit in 3 seconds');
  assert.strictEqual(clean('one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty', 1500), '');
});

test('guard rails: however wrong the words are, one sentence cannot flood the desktop', async () => {
  const fires = []; const spawned = [];
  const jevFirefox = { ready: () => true, systemOne: async () => ({ answers: { intent: { choice: 'open_app', confidence: 1 }, app: { choice: 'firefox', confidence: 1 } }, ms: 100, model: 'fake' }) };
  const probe = { request: async (op) => (op === 'apps.list' ? { apps: [{ name: 'Firefox', appId: 'ff' }] } : op === 'fg' ? { hwnd: 1 } : { ok: true }) };
  const reflex = createReflex({ probe, shell: { openExternal: async () => {} }, jevClient: jevFirefox, onFire: (f) => fires.push(f), spawnFn: (exe, args) => { spawned.push(args[0]); return { unref() {} }; } });
  await reflex.start();
  // The raw looped transcript, as if the listener's own checks had failed too.
  await reflex.handle(LOOP, { final: true });
  assert.strictEqual(spawned.length, 1, 'one Firefox, not 43');
  // Saying it again straight away is inside the cooldown.
  await reflex.handle('open firefox', { final: true });
  assert.strictEqual(spawned.length, 1, 'the same launch within the cooldown is blocked');
});

test('a search goes to the browser that was just named, not the system default', async () => {
  const spawned = []; const external = [];
  const chromeKey = APPS.find((a) => a.name === 'Google Chrome').key;
  const jevSeq = { ready: () => true, systemOne: async ({ state }) => (/search/.test(state.utterance)
    ? { answers: { intent: { choice: 'web_search', confidence: 1 } }, ms: 100, model: 'fake' }
    : { answers: { intent: { choice: 'open_app', confidence: 1 }, app: { choice: chromeKey, confidence: 1 } }, ms: 100, model: 'fake' }) };
  const probe = { request: async (op) => (op === 'apps.list' ? { apps: [{ name: 'Google Chrome', appId: 'Chrome' }] } : op === 'fg' ? { hwnd: Math.random() } : { ok: true }) };
  const reflex = createReflex({ probe, shell: { openExternal: async (u) => { external.push(u); } }, jevClient: jevSeq, spawnFn: (exe, args) => { spawned.push([exe, args[0]]); return { unref() {} }; } });
  await reflex.start();
  await reflex.handle('open chrome and search norbert wiener', { final: true });
  const search = spawned.find(([, a]) => String(a).includes('google.com/search'));
  if (require('../src/reflex/executor').browserExe('Google Chrome')) {
    assert.ok(search && /chrome\.exe$/i.test(search[0]), 'the search was started in chrome.exe');
    assert.strictEqual(external.length, 0, 'the default browser was not used');
  } else {
    assert.strictEqual(external.length, 1, 'no Chrome on this machine: default browser');
  }
});

test('words meant for someone else in the room are never acted on or sent to the brain', () => {
  const chat = { addressed: { noul: 0.08 } };
  const sorry = decide('Sorry, yeah', A('ask', 0.45, chat), { final: true, apps: APPS });
  assert.deepStrictEqual([sorry.fire, sorry.brain], [false, false]);
  const dad = decide('Now you can give me one second my dad called', A('guide', 0.9, chat), { final: true, apps: APPS });
  assert.deepStrictEqual([dad.fire, dad.brain], [false, false]);
  const vol = decide('turn the volume down', A('volume_down', 0.99, chat), { final: true, apps: APPS });
  assert.strictEqual(vol.fire, false, 'even a clear command, if it was said to a person');
  const real = decide('help me make a pivot table', A('guide', 0.9, { addressed: { noul: 0.95 } }), { final: true, apps: APPS });
  assert.strictEqual(real.brain, true);
  const mumble = decide('uh so the thing is', A('ask', 0.3, { addressed: { noul: 0.4 } }), { final: true, apps: APPS });
  assert.strictEqual(mumble.brain, false, 'unsure AND not clearly addressed: dropped');
});

test('a verb left hanging by a pause waits for its words', async () => {
  const calls = []; const ops = []; const fires = [];
  const reflex = createReflex({ probe: fakeProbe(ops), shell: { openExternal: async () => {} }, jevClient: fakeJev(calls), onFire: (f) => fires.push(f), spawnFn: () => ({ unref() {} }) });
  await reflex.start();
  // Live 2026-09-21: "Create a new note type." [pause] "Hello, Nūs."
  const first = await reflex.handle('open notepad and type', { final: true });
  assert.strictEqual(fires.length, 1, 'notepad opens now');
  assert.strictEqual(first.handled, true);
  assert.ok(!calls.some((c) => c === 'type'), 'the bare verb is not sent to Jev on its own');
  await reflex.handle('hello from nus', { final: true });
  assert.strictEqual(fires.length, 2);
  assert.strictEqual(fires[1].intent, 'type_text');
  assert.ok(ops.includes('keys.text:hello from nus'), 'typed exactly what followed the pause');
  // A lone verb is held, not thrown at the brain.
  const lone = await reflex.handle('and search', { final: true });
  assert.deepStrictEqual([lone.handled, lone.brainText, lone.held], [true, null, 'search']);
});

test('a garbled app name is matched by sound, and only when there is a clear winner', () => {
  const { soundsLike } = require('../src/reflex/soundslike');
  const apps = buildCatalog([{ name: 'Notepad', appId: 'np' }, { name: 'Notepad++', appId: 'npp' }, { name: 'OneNote', appId: 'on' }, { name: 'Node.js', appId: 'node' }, { name: 'Google Chrome', appId: 'c' }, { name: 'Firefox', appId: 'ff' }]);
  // Live 2026-09-21, whisper base.en on "open notepad":
  assert.strictEqual(soundsLike('Open NordPad', apps).app.name, 'Notepad');
  assert.strictEqual(soundsLike('Open node path', apps).app.name, 'Notepad', 'and the plain Notepad, not Notepad++');
  assert.strictEqual(soundsLike('open fire fog', apps).app.name, 'Firefox');
  assert.strictEqual(soundsLike('open the door', apps), null);
  assert.strictEqual(soundsLike('open up a bank account', apps), null);
  assert.strictEqual(soundsLike('what is a notepad', apps), null, 'no launch verb, no match');
  // decide(): Jev half-believes it is a launch (0.52 live) and names no app.
  const d = decide('Open node path', A('open_app', 0.52, { app: { choice: 'none', confidence: 0.7 } }), { final: true, apps });
  assert.deepStrictEqual([d.fire, d.app && d.app.name], [true, 'Notepad']);
  const p = decide('Open node', A('open_app', 0.9, { app: { choice: 'none', confidence: 0.7 } }), { final: false, apps });
  assert.strictEqual(p.fire, false, 'never on a half-heard partial');
});

test('a sentence whose transcript arrives late is not swallowed by the next one', async () => {
  // Live 2026-09-21: sentence 2 ("open chrome") fired early while sentence 1's
  // final was still in whisper. Sentence 1 then found "clause 0 done" and vanished.
  const calls = []; const ops = []; const fires = [];
  const chrome = { name: 'Google Chrome', appId: 'Chrome' };
  const jev2 = { ready: () => true, systemOne: async ({ state }) => {
    const u = state.utterance.toLowerCase(); calls.push(u);
    const ws = words(state.utterance);
    if (/chrome/.test(u)) return { answers: { intent: { choice: 'open_app', confidence: 1 }, app: { choice: 'google_chrome', confidence: 1 } }, ms: 100, model: 'fake' };
    if (/^type/.test(u)) return { answers: { intent: { choice: 'type_text', confidence: 1 }, slot_start: { choice: 'w1', confidence: 0.9 }, slot_end: { choice: 'w' + (ws.length - 1), confidence: 0.9 } }, ms: 100, model: 'fake' };
    if (/new no/.test(u)) return { answers: { intent: { choice: 'new_item', confidence: 0.95 } }, ms: 100, model: 'fake' };
    return { answers: { intent: { choice: 'none', confidence: 0.9 } }, ms: 100, model: 'fake' };
  } };
  const probe = { request: async (op, p) => { ops.push(op + (p && p.text ? ':' + p.text : '')); return op === 'apps.list' ? { apps: [chrome] } : op === 'fg' ? { hwnd: Math.random() } : { ok: true }; } };
  const reflex = createReflex({ probe, shell: { openExternal: async () => {} }, jevClient: jev2, onFire: (f) => fires.push(f), spawnFn: () => ({ unref() {} }) });
  await reflex.start();
  await reflex.handle('Open Chrome.', { final: false, uttId: 8 });                       // sentence 2, early
  assert.deepStrictEqual(fires.map((f) => f.intent), ['open_app']);
  // Sentence 1's final lands now. whisper dropped the comma: two commands, one clause.
  const out = await reflex.handle('Create a new node type Hello from Nūs.', { final: true, uttId: 7 });
  assert.deepStrictEqual(fires.map((f) => f.intent), ['open_app', 'new_item', 'type_text'], 'both halves of sentence 1 ran');
  assert.ok(ops.includes('keys.text:Hello from Nūs'));
  assert.strictEqual(out.handled, true);
  await reflex.handle('Open Chrome and search', { final: true, uttId: 8 });               // sentence 2's final
  assert.strictEqual(fires.filter((f) => f.intent === 'open_app').length, 1, 'Chrome is not opened twice');
});

test('said in one breath: the front command fires mid-sentence, and nothing is typed twice', async () => {
  // Live 2026-09-21, one 6.5 s segment. Partials exactly as whisper produced them.
  const ops = []; const fires = [];
  const jev4 = { ready: () => true, systemOne: async ({ state }) => {
    const u = state.utterance.toLowerCase(); const ws = words(state.utterance);
    // The trailing verb muddies the whole partial, as it did live.
    if (/^open note ?pad create/.test(u)) return { answers: { intent: { choice: 'new_item', confidence: 0.5 } }, ms: 100, model: 'fake' };
    if (/^open note ?pad/.test(u)) return { answers: { intent: { choice: 'open_app', confidence: 1 }, app: { choice: 'notepad', confidence: 1 } }, ms: 100, model: 'fake' };
    if (/^create a new no/.test(u)) return { answers: { intent: { choice: 'new_item', confidence: 0.97 } }, ms: 100, model: 'fake' };
    if (/^type/.test(u)) return { answers: { intent: { choice: 'type_text', confidence: 1 }, slot_start: { choice: 'w1', confidence: 0.9 }, slot_end: { choice: 'w' + (ws.length - 1), confidence: 0.9 } }, ms: 100, model: 'fake' };
    return { answers: { intent: { choice: 'none', confidence: 0.9 } }, ms: 100, model: 'fake' };
  } };
  const reflex = createReflex({ probe: fakeProbe(ops), shell: { openExternal: async () => {} }, jevClient: jev4, onFire: (f) => fires.push(f), spawnFn: () => ({ unref() {} }) });
  await reflex.start();
  await reflex.handle('Open note', { final: false, uttId: 3 });
  await reflex.handle('Open notepad create', { final: false, uttId: 3 });
  assert.deepStrictEqual(fires.map((f) => f.intent), ['open_app'], 'Notepad opens on the partial, not 3.6 s later');
  await reflex.handle('Open notepad create a new node', { final: false, uttId: 3 });
  // whisper doubled the last sentence, with different capitals.
  await reflex.handle('Open Notepad, create a new node. Type hello from Nūs. Type Hello from Nūs.', { final: true, uttId: 3 });
  assert.deepStrictEqual(fires.map((f) => f.intent), ['open_app', 'new_item', 'type_text']);
  assert.strictEqual(ops.filter((o) => o.startsWith('keys.text')).length, 1, 'typed once');
  const { clean } = require('../src/reflex/listen');
  assert.strictEqual(clean('Type hello from Nūs. Type hello from Nūs.', 3000), 'Type hello from Nūs.');

  // Same sentence, but whisper gives the final NO punctuation at all. The
  // partials cut it into pieces; the final must be cut into the same pieces,
  // or "piece 0 is done" swallows the whole sentence (caught live 2026-09-21).
  fires.length = 0; ops.length = 0;
  await new Promise((r) => setTimeout(r, 10));
  const words10 = 'Open notepad create a new node type hello from Nūs'.split(' ');
  // A new app key so the launch cooldown from above does not apply: reuse Notepad after it.
  const reflex2 = createReflex({ probe: fakeProbe(ops), shell: { openExternal: async () => {} }, jevClient: jev4, onFire: (f) => fires.push(f), spawnFn: () => ({ unref() {} }) });
  await reflex2.start();
  for (let n = 1; n < words10.length; n++) await reflex2.handle(words10.slice(0, n).join(' '), { final: false, uttId: 9 });
  assert.deepStrictEqual(fires.map((f) => f.intent), ['open_app', 'new_item'], 'both finished commands ran while still speaking');
  await reflex2.handle(words10.join(' '), { final: true, uttId: 9 });
  assert.deepStrictEqual(fires.map((f) => f.intent), ['open_app', 'new_item', 'type_text'], 'and the final typed the text, once');
  assert.ok(ops.includes('keys.text:hello from Nūs'));
});

test('routines: offered after a run of actions, saved only on a yes, replayed on request', async () => {
  const os = require('os'); const fsx = require('fs'); const pathx = require('path');
  const file = pathx.join(fsx.mkdtempSync(pathx.join(os.tmpdir(), 'reflex-rt-')), 'routines.json');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const make = () => {
    const ops = []; const fires = []; const offers = []; const closed = []; const spoken = []; const launched = [];
    const jev5 = { ready: () => true, systemOne: async ({ state, questions }) => {
      if (questions.reply) {
        const u = state.utterance.toLowerCase();
        const c = /^(no|nope|nah)\b/.test(u) ? 'no' : /^(yes|yeah|sure)\b/.test(u) ? 'yes' : 'other';
        return { answers: { reply: { choice: c, confidence: 0.95 } }, ms: 90, model: 'fake' };
      }
      const u = state.utterance.toLowerCase(); const ws = words(state.utterance);
      if (/routine/.test(u)) return { answers: { intent: { choice: 'run_routine', confidence: 0.98 } }, ms: 90, model: 'fake' };
      if (/^open notepad/.test(u)) return { answers: { intent: { choice: 'open_app', confidence: 1 }, app: { choice: 'notepad', confidence: 1 } }, ms: 90, model: 'fake' };
      if (/^create/.test(u)) return { answers: { intent: { choice: 'new_item', confidence: 0.97 } }, ms: 90, model: 'fake' };
      if (/^type/.test(u)) return { answers: { intent: { choice: 'type_text', confidence: 1 }, slot_start: { choice: 'w1', confidence: 0.9 }, slot_end: { choice: 'w' + (ws.length - 1), confidence: 0.9 } }, ms: 90, model: 'fake' };
      if (/volume/.test(u)) return { answers: { intent: { choice: 'volume_down', confidence: 1 } }, ms: 90, model: 'fake' };
      return { answers: { intent: { choice: 'none', confidence: 0.9 } }, ms: 90, model: 'fake' };
    } };
    const reflex = createReflex({ probe: fakeProbe(ops), shell: { openExternal: async () => {} }, jevClient: jev5, routinesFile: file, offerDelayMs: 30,
      onFire: (f) => fires.push(f.intent), onOffer: (s) => offers.push(s.length), onOfferClosed: (h) => closed.push(h), onSpeak: (t) => spoken.push(t),
      spawnFn: (exe, args) => { launched.push(args[0]); return { unref() {} }; } });
    return { reflex, ops, fires, offers, closed, spoken, launched };
  };

  // Two actions: not worth an offer.
  let t = make(); await t.reflex.start();
  await t.reflex.handle('open notepad, create a new note', { final: true }); await wait(80);
  assert.deepStrictEqual(t.offers, [], 'no offer for a two step run');

  // Three actions, then quiet: one offer. "No" saves nothing.
  t = make(); await t.reflex.start();
  await t.reflex.handle('open notepad, create a new note, type hello from nus', { final: true }); await wait(80);
  assert.deepStrictEqual(t.offers, [3]);
  const no = await t.reflex.handle('No', { final: true });
  assert.deepStrictEqual([no.handled, no.offer], [true, 'no']);
  assert.deepStrictEqual(t.closed, ['declined']);
  assert.strictEqual(fsx.existsSync(file), false, 'declined means nothing on disk');
  await t.reflex.handle('turn the volume down', { final: true }); await wait(80);
  assert.deepStrictEqual(t.offers, [3], 'asked once per run, never nagged');

  // A new command instead of an answer: the offer is dropped and the command still runs.
  t = make(); await t.reflex.start();
  await t.reflex.handle('open notepad, create a new note, type hello from nus', { final: true }); await wait(80);
  await t.reflex.handle('turn the volume down', { final: true });
  assert.deepStrictEqual(t.closed, ['ignored']);
  assert.strictEqual(t.fires[t.fires.length - 1], 'volume_down');

  // "Yes" writes a real routine, and "run my routine" replays every step of it.
  t = make(); await t.reflex.start();
  await t.reflex.handle('open notepad, create a new note, type hello from nus', { final: true }); await wait(80);
  await t.reflex.handle('yes', { final: true });
  assert.deepStrictEqual(t.closed, ['saved']);
  const saved = JSON.parse(fsx.readFileSync(file, 'utf8')).routines;
  assert.deepStrictEqual(saved[0].steps.map((s) => s.intent), ['open_app', 'new_item', 'type_text']);
  assert.strictEqual(saved[0].steps[2].text, 'hello from nus');
  const t2 = make(); await t2.reflex.start();
  await t2.reflex.handle('run my routine', { final: true }); await wait(80);
  assert.deepStrictEqual(t2.fires, ['open_app', 'new_item', 'type_text', 'run_routine']);
  assert.ok(t2.ops.includes('keys.text:hello from nus'));
  assert.deepStrictEqual(t2.offers, [], 'a replay is not offered back as a new routine');
});

test('a command verb inside text to type or search for never splits the sentence', async () => {
  const fires = [];
  const jev3 = { ready: () => true, systemOne: async ({ state }) => {
    const ws = words(state.utterance);
    return { answers: { intent: { choice: 'web_search', confidence: 1 }, slot_start: { choice: 'w1', confidence: 0.9 }, slot_end: { choice: 'w' + (ws.length - 1), confidence: 0.9 } }, ms: 100, model: 'fake' };
  } };
  const reflex = createReflex({ probe: fakeProbe([]), shell: { openExternal: async () => {} }, jevClient: jev3, onFire: (f) => fires.push(f), spawnFn: () => ({ unref() {} }) });
  await reflex.start();
  await reflex.handle('search how to type faster on a keyboard', { final: true });
  assert.strictEqual(fires.length, 1);
  assert.strictEqual(fires[0].label, 'Search: how to type faster on a keyboard'.slice(0, 40));
});

test('what the reflex layer cannot do comes back for the brain', async () => {
  const reflex = createReflex({ probe: fakeProbe([]), shell: { openExternal: async () => {} }, jevClient: fakeJev([]) });
  const out = await reflex.handle('help me make a pivot table', { final: true });
  assert.strictEqual(out.handled, false);
  assert.strictEqual(out.brainText, 'help me make a pivot table');
});

test('a request for guidance costs one Jev call, and is announced while the sentence is still being spoken', async () => {
  const calls = []; const heard = [];
  const reflex = createReflex({ probe: fakeProbe([]), shell: { openExternal: async () => {} }, jevClient: fakeJev(calls), onIntent: (d) => heard.push(d), spawnFn: () => ({ unref() {} }) });
  // "make" is a command verb, but the clause opens like a request for help: never cut, never asked about.
  const out = await reflex.handle('help me make a pivot table', { final: true, uttId: 1 });
  assert.strictEqual(out.brainText, 'help me make a pivot table');
  assert.deepStrictEqual(calls, ['help me make a pivot table'], 'one call, not a second one for "help me"');
  assert.strictEqual(heard.length, 1);
  assert.strictEqual(heard[0].intent, 'guide');

  // Mid-sentence: nothing fires, nothing goes to the brain, but the caller is told to get ready.
  heard.length = 0;
  const part = await reflex.handle('how do i make a pivot', { final: false, uttId: 2 });
  assert.strictEqual(part.brainText, null);
  assert.strictEqual(heard.length, 1);
  assert.strictEqual(heard[0].final, false);

  // A plain command announces nothing, and a sentence with a real second command still splits.
  heard.length = 0; calls.length = 0;
  await reflex.handle('open notepad type hello there', { final: true, uttId: 3 });
  assert.strictEqual(heard.length, 0);
  assert.ok(calls.includes('open notepad'), 'the front command was still tried on its own');
});

test('room talk that sounds like a question never triggers a screen read', async () => {
  const heard = [];
  const jevRoom = { ready: () => true, systemOne: async () => ({ answers: { intent: { choice: 'ask', confidence: 0.9 }, addressed: { noul: 0.2 } }, ms: 100, model: 'fake' }) };
  const reflex = createReflex({ probe: fakeProbe([]), shell: { openExternal: async () => {} }, jevClient: jevRoom, onIntent: (d) => heard.push(d) });
  await reflex.handle('what did she say about the appointment', { final: false, uttId: 1 });
  await reflex.handle('what did she say about the appointment', { final: true, uttId: 1 });
  assert.strictEqual(heard.length, 0);
});

test('focus guard: the intent is registered, and code reads the feed and the condition out of the words', async () => {
  assert.ok(INTENTS.focus_guard, 'focus_guard is a registered intent');
  assert.match(INTENTS.focus_guard, /keep me off reels/);
  // Jev says "focus_guard"; code says what for. Each listed phrase, final.
  const cases = [
    ['keep me off reels', { kind: 'start', feeds: ['Instagram', 'Reels'], minutes: null, untilApp: null }],
    ['no reels for 20 minutes', { kind: 'start', feeds: ['Instagram', 'Reels'], minutes: 20, untilApp: null }],
    ['block tiktok until I close word', { kind: 'start', feeds: ['TikTok'], minutes: null, untilApp: 'word' }],
    ['ok let me back', { kind: 'back' }]
  ];
  for (const [said, want] of cases) {
    const d = decide(said, A('focus_guard', 0.9), { final: true, apps: APPS });
    assert.strictEqual(d.fire, true, said);
    assert.deepStrictEqual(d.focus, want, said);
  }
  // Never on a half sentence, and a wavering Jev is rescued only by a readable phrase.
  assert.strictEqual(decide('keep me off re', A('focus_guard', 0.95), { final: false, apps: APPS }).fire, false);
  assert.strictEqual(decide('keep me off reels for 20 minutes', A('focus_guard', 0.45), { final: true, apps: APPS }).fire, true, 'rescued: the words are plain');
  const vague = decide('maybe I should stop scrolling', A('focus_guard', 0.45), { final: true, apps: APPS });
  assert.strictEqual(vague.fire, false, 'not rescued: nothing readable');
  // Jev sure, words unreadable by code: the guard still runs, on its defaults.
  assert.deepStrictEqual(decide('I need you to stop me doomscrolling', A('focus_guard', 0.9), { final: true, apps: APPS }).focus, { kind: 'start', feeds: [], minutes: null, untilApp: null });
  // Clauses: a guard after a command splits like any command does.
  assert.deepStrictEqual(splitClauses('open word and keep me off reels for 20 minutes'), ['open word', 'keep me off reels for 20 minutes']);

  // Through the engine: the host's hook gets the parsed command, nothing is typed or launched.
  const got = []; const ops = []; const fires = [];
  const jevFocus = { ready: () => true, systemOne: async () => ({ answers: { intent: { choice: 'focus_guard', confidence: 0.95 } }, ms: 90, model: 'fake' }) };
  const reflex = createReflex({ probe: fakeProbe(ops), shell: { openExternal: async () => {} }, jevClient: jevFocus, onFire: (f) => fires.push(f.intent), onFocusGuard: (c) => got.push(c), spawnFn: () => ({ unref() {} }) });
  await reflex.start();
  const out = await reflex.handle('block tiktok until I close word', { final: true });
  assert.deepStrictEqual(got, [{ kind: 'start', feeds: ['TikTok'], minutes: null, untilApp: 'word' }]);
  assert.deepStrictEqual(fires, ['focus_guard']);
  assert.strictEqual(out.handled, true);
  assert.ok(!ops.some((o) => /keys\./.test(o)), 'the engine pressed nothing itself');
});

test('no key means the Companion behaves exactly as before', async () => {
  const reflex = createReflex({ probe: fakeProbe([]), shell: {}, jevClient: { ready: () => false } });
  const out = await reflex.handle('open notepad', { final: true });
  assert.deepStrictEqual(out, { handled: false, brainText: 'open notepad' });
});
