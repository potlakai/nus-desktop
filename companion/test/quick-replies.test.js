// The "feels fast" round (0.1.7): the acknowledgement before the action,
// small talk in one word, the reply shape, the live words by the Knot, and
// cutting the Knot off.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { ACKS, NEUTRAL_ACK, SMALL_TALK_LINES, LINES, ackForIntent, smallTalk, createLineCache, readWav } = require('../src/voice/lines');
const { classifyUtterance } = require('../src/guide/voice');
const { createReflex } = require('../src/reflex');
const { activityView } = require('../src/usage-ledger');

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const main = read('index.js');
const ui = read('renderer', 'renderer.js');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nus-lines-'));
// Half a second of a 24 kHz tone, as the voice worker would hand it back.
function tone(n = 12000) { const b = Buffer.alloc(n * 2); for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(8000 * Math.sin(i / 7)), i * 2); return { sampleRate: 24000, pcm: b, ms: 600, secs: n / 24000 }; }

test('the acknowledgements are the short lines from the plan, one per kind of ask', () => {
  assert.deepEqual(ACKS, { open: 'On it.', search: 'Looking.', sure: 'Sure.', hands: 'Sure, doing that.', message: 'Sure, writing it.', guide: 'Let me look.', reading: 'Okay, reading it.', recall: 'Let me check.' });
  assert.deepEqual(SMALL_TALK_LINES, ['Anytime.', 'Thanks.', 'Happy to.']);
  for (const l of LINES) { assert.ok(l.split(/\s+/).length <= 5, l); assert.doesNotMatch(l, /—|–/, 'no dashes in what it says'); }
  assert.equal(ackForIntent('open_app'), 'open'); assert.equal(ackForIntent('open_site'), 'open');
  assert.equal(ackForIntent('web_search'), 'search');
  assert.equal(ackForIntent('volume_down'), 'sure'); assert.equal(ackForIntent('volume_up'), 'sure');
  // Instant and silent, or answering for itself: no ack.
  for (const i of ['snap_left', 'type_text', 'remember_note', 'brief', 'dismiss', 'next', 'guide', 'none']) assert.equal(ackForIntent(i), null, i);
});

test('small talk gets one word back, and an ask after it still goes through', () => {
  const cases = [
    ['Thanks.', 'Anytime.', ''], ['thank you', 'Anytime.', ''], ['Thank you so much!', 'Happy to.', ''],
    ['Good job.', 'Thanks.', ''], ['Good job Nūs', 'Thanks.', ''], ['Oh that was pretty fast. Good job.', 'Thanks.', ''],
    ['That was pretty good.', 'Thanks.', ''], ["You're the best", 'Thanks.', ''], ['Perfect.', 'Thanks.', ''], ['nice', 'Thanks.', ''],
    ['Perfect, thank you.', 'Anytime.', ''], ['great job on the outline', 'Thanks.', ''],
    ['Thanks, now open Word.', 'Anytime.', 'open Word.'], ['Nice, turn it down a bit', 'Thanks.', 'turn it down a bit'],
    ['Good job. Now remind me at 9 to submit it.', 'Thanks.', 'remind me at 9 to submit it.'],
  ];
  for (const [said, line, rest] of cases) assert.deepEqual(smallTalk(said), { line, rest }, said);
  // Words that only look like praise are asks.
  for (const t of ['perfect the essay', 'nice weather today?', 'open notepad', 'great britain population', 'how do I say thanks in French', '']) assert.equal(smallTalk(t), null, t);
});

test('the lines are made once, kept as WAV files, and read back without a synthesis', async () => {
  const dir = tmp();
  let calls = 0;
  let key = 'fable:kokoro-v1_0:25:1';
  const cache = createLineCache({ dir, voiceKey: () => key, synth: async () => { calls++; return tone(); } });
  assert.equal(cache.get('On it.'), null, 'nothing before it is made');
  assert.deepEqual(cache.missing(), LINES);
  const r = await cache.prerender();
  assert.deepEqual(r, { made: LINES.length, left: 0 });
  assert.equal(calls, LINES.length);
  assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith('.wav')).length, LINES.length);
  // A fresh cache (a restart) reads the same samples from disk.
  const again = createLineCache({ dir, voiceKey: () => key, synth: async () => { throw new Error('must not synthesize'); } });
  const a = again.get('Let me look.');
  assert.equal(a.sampleRate, 24000);
  assert.ok(a.pcm.equals(tone().pcm));
  await again.prerender();
  // Only the short lines are kept, never a whole reply.
  assert.equal(again.put('The capital of France is Paris.', tone()), false);
  assert.equal(again.get('The capital of France is Paris.'), null);
  // Another voice makes its own.
  key = 'other:voice:1:1';
  assert.equal(again.get('Let me look.'), null);
  // No voice installed: nothing is made and nothing is served.
  key = '';
  assert.deepEqual(await cache.prerender(), { made: 0, left: LINES.length });
  assert.equal(cache.get('On it.'), null);
});

test('live speech does not end the making: the line it cut off is made again, once it is quiet', async () => {
  const dir = tmp();
  const lines = ['One.', 'Two.', 'Three.'];
  let live = false, calls = [];
  const cache = createLineCache({ dir, voiceKey: () => 'k', keep: () => true, quiet: () => !live, sleep: () => new Promise((r) => setTimeout(r, 1)),
    synth: async (line) => { calls.push(line); if (calls.length === 1 || calls.length === 3) { live = true; setTimeout(() => { live = false; }, 5); throw new Error('stopped'); } return tone(); } });
  const r = await cache.prerender(lines);
  assert.deepEqual(r, { made: 3, left: 0 }, 'not "0 made, 3 left"');
  assert.deepEqual(calls, ['One.', 'One.', 'Two.', 'Two.', 'Three.']);
  for (const l of lines) assert.ok(cache.get(l));
});

test('the making waits while something live is going on', async () => {
  let live = true, calls = 0;
  const cache = createLineCache({ dir: tmp(), voiceKey: () => 'k', keep: () => true, quiet: () => !live, sleep: () => new Promise((r) => setTimeout(r, 1)), synth: async () => { calls++; return tone(); } });
  const done = cache.prerender(['One.']);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls, 0, 'nothing made while the person talks');
  live = false;
  assert.deepEqual(await done, { made: 1, left: 0 });
});

test('a later ask goes to the front, and shares the run already going', async () => {
  const order = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const cache = createLineCache({ dir: tmp(), voiceKey: () => 'k', keep: () => true, synth: async (l) => { order.push(l); await gate; return tone(); } });
  const first = cache.prerender(['A.', 'B.']);
  await new Promise((r) => setImmediate(r));
  const second = cache.prerender(['C.', 'A.']);
  release();
  const r = await second;
  assert.equal(await first, r);
  assert.deepEqual(order, ['A.', 'C.', 'B.']);
  assert.deepEqual(r, { made: 3, left: 0 });
});

test('a changed voice or the app going away ends the making', async () => {
  let key = 'k', calls = 0;
  const cache = createLineCache({ dir: tmp(), voiceKey: () => key, keep: () => true, synth: async () => { calls++; key = 'other'; return tone(); } });
  await cache.prerender(['A.', 'B.']);
  assert.equal(calls, 1);
  key = 'k'; calls = 0;
  const c2 = createLineCache({ dir: tmp(), voiceKey: () => key, keep: () => true, synth: async () => { calls++; c2.cancel(); return tone(); } });
  await c2.prerender(['A.', 'B.']);
  assert.equal(calls, 1);
});

test('the Companion makes lines behind live speech and the talk key', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.match(main, /quiet: \(\) => !ptt\.held && getVoice\(\)\.idle\(\),/);
  assert.match(main, /if \(lineCache\) lineCache\.cancel\(\); voice\.close\(\);/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'src', 'voice', 'index.js'), 'utf8'), /idle: \(\) => !pending\.size/);
});

test('a voice stopped over and over leaves the rest for next time', async () => {
  const dir = tmp();
  let n = 0;
  const cache = createLineCache({ dir, voiceKey: () => 'k', synth: async () => { if (++n > 2) throw new Error('stopped'); return tone(); } });
  const r = await cache.prerender();
  assert.equal(r.made, 2);
  assert.equal(r.left, LINES.length - 2);
  assert.ok(readWav(fs.readFileSync(cache.file(LINES[0]))));
});

test('a ready-made line is served in milliseconds, against a synthesis that takes most of a second', async () => {
  const dir = tmp();
  const synthMs = 600;   // measured: "Done." through Kokoro Fable on the Ryzen 7 4700U
  const cache = createLineCache({ dir, voiceKey: () => 'k', synth: async () => { await new Promise((r) => setTimeout(r, 30)); return tone(); } });
  await cache.prerender(['On it.']);
  const cold = createLineCache({ dir, voiceKey: () => 'k', synth: async () => tone() });
  let t0 = process.hrtime.bigint();
  assert.ok(cold.get('On it.'));
  const fromDisk = Number(process.hrtime.bigint() - t0) / 1e6;
  t0 = process.hrtime.bigint();
  assert.ok(cold.get('On it.'));
  const fromMemory = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(fromDisk < 100, 'from disk ' + fromDisk + ' ms');
  assert.ok(fromMemory < 5, 'from memory ' + fromMemory + ' ms');
  assert.ok(fromDisk < synthMs / 6);
});

test('the main process says the ack once per press, only for a spoken ask, never with the key down', () => {
  const body = main.slice(main.indexOf('let lastAck = null;'), main.indexOf('async function routeUtterance('));
  const sent = [], logs = [];
  const ctx = { ACKS, ptt: { held: false, press: 1 }, companionVoiceEnabled: true, Date, Math, Boolean,
    send: (c, p) => sent.push([c, p]), routeLog: (m) => logs.push(m), getLines: () => ({ get: (l) => (l === 'On it.' ? { pcm: Buffer.alloc(2) } : null) }) };
  vm.runInNewContext(body, ctx);
  assert.equal(vm.runInNewContext('sayAck("open", "typed", Date.now())', ctx), false, 'typed asks are not spoken to');
  ctx.ptt.held = true;
  assert.equal(vm.runInNewContext('sayAck("open", "voice", Date.now())', ctx), false, 'never while the key is down');
  ctx.ptt.held = false;
  assert.equal(vm.runInNewContext('sayAck("open", "voice", Date.now() - 420)', ctx), true);
  assert.deepEqual(JSON.parse(JSON.stringify(sent.at(-1))), ['guide:say', { text: 'On it.', first: true, ack: true, sessionId: null, cached: true }]);
  assert.equal(vm.runInNewContext('sayAck("sure", "voice", Date.now())', ctx), false, 'one per press');
  assert.match(logs.at(-1), /ack "On it\." \d+ms after the words/);
  // The ledger row for that ask takes its timing once.
  const a = vm.runInNewContext('takeAck()', ctx);
  assert.ok(a.ms >= 400 && a.ms < 2000);
  assert.equal(vm.runInNewContext('takeAck()', ctx), null);
  ctx.ptt.press = 2;
  assert.equal(vm.runInNewContext('sayAck("guide", "voice", Date.now())', ctx), true, 'the next press gets its own');
  assert.equal(sent.at(-1)[1].cached, false, 'not made yet: the voice makes it (or the system voice says it)');
});

test('2026-11-02: key up says nothing (the spoken "Mm." is retired); the intent ack goes out first and once', () => {
  const body = main.slice(main.indexOf('let lastAck = null;'), main.indexOf('async function routeUtterance('));
  const sent = [], logs = [];
  const { greeting } = require('../src/reflex/rules');
  const { classifyUtterance } = require('../src/guide/voice');
  const ctx = { ACKS, NEUTRAL_ACK, ptt: { held: false, press: 1 }, companionVoiceEnabled: true, assignment: null, agent: null, Date, Math, Boolean, String,
    greeting, smallTalk, classifyUtterance, parseRecallAsk: require('../src/recall/asks').parseRecallAsk,
    send: (c, p) => sent.push([c, p]), routeLog: (m) => logs.push(m), getLines: () => ({ get: (l) => l === NEUTRAL_ACK || l === 'On it.' ? { pcm: Buffer.alloc(2) } : null }) };
  vm.runInNewContext(body, ctx);
  assert.ok(!LINES.includes(NEUTRAL_ACK), 'not made any more');
  for (const t of ['open spotify', null, 'yes', '']) assert.equal(vm.runInNewContext('sayNeutral(' + JSON.stringify(t) + ', Date.now() - 5)', ctx), false, 'never spoken: ' + t);
  assert.equal(sent.length, 0, 'nothing said at key up');
  assert.equal(vm.runInNewContext('takeNeutral()', ctx), null, 'no first_sound row to claim');
  // The intent ack is the first thing heard, once per press.
  assert.equal(vm.runInNewContext('sayAck("open", "voice", Date.now())', ctx), true);
  assert.deepEqual(JSON.parse(JSON.stringify(sent.at(-1))), ['guide:say', { text: 'On it.', first: true, ack: true, sessionId: null, cached: true }]);
  assert.equal(vm.runInNewContext('sayAck("sure", "voice", Date.now())', ctx), false, 'one intent ack per press');
  assert.equal(sent.length, 1);
});

test('key up says the neutral line before the last words are flushed or transcribed', () => {
  const stop = main.slice(main.indexOf('async function pttStop('), main.indexOf('// Reflex first.'));
  assert.ok(stop.indexOf('sayNeutral(heardText(ptt.lastPartial), keyUpAt)') > 0);
  assert.ok(stop.indexOf('sayNeutral(heardText(ptt.lastPartial), keyUpAt)') < stop.indexOf('getListener().flush()'));
  assert.ok(stop.indexOf('sayNeutral(null, keyUpAt)') > 0);
  assert.ok(stop.indexOf('sayNeutral(null, keyUpAt)') < stop.indexOf('stt.transcribe(pcm)'));
  const ledger = main.slice(main.indexOf('function getLedger()'), main.indexOf('function guideSystemPrompt('));
  assert.match(ledger, /\{ first_sound: n\.ms \}/);
});

test('the ack goes out before the action, the model or the screen read', () => {
  // The reflex layer: decided, then the ack, then the keys or the launch.
  const reflexSrc = read('src', 'reflex', 'index.js');
  const fire = reflexSrc.slice(reflexSrc.indexOf('async function fire('), reflexSrc.indexOf('// People pause after the verb'));
  assert.ok(fire.indexOf('onWillFire(d)') > 0 && fire.indexOf('onWillFire(d)') < fire.indexOf('await exec.run(d)'));
  assert.match(main, /onWillFire: \(d\) => \{ const k = ackForIntent\(d\.intent\); if \(k && d\.final && reflexTurn\) sayAck\(k, reflexTurn\.source, reflexTurn\.heardAt\); \}/);
  // Hands, the guide, the page and homework.
  const answer = main.slice(main.indexOf('function routeAnswer('), main.indexOf('const ANSWER_SYSTEM'));
  assert.ok(answer.indexOf("sayAck(messageAsk(kind.text) ? 'message' : 'hands'") < answer.indexOf('getAgent().run('));
  assert.ok(answer.indexOf("sayAck('guide', source, heardAt)") < answer.indexOf("getGuide().start(kind.text, 'voice'"));
  assert.match(main, /sayAck\('reading', source, heardAt\);/);
  assert.match(main, /sayAck\('reading', source \|\| 'voice', assignmentHeardAt\)/);
  // The Knot moving or resizing.
  assert.match(main, /if \(sc\) \{ sayAck\('sure', source, heardAt\); runSelfCommands\(sc\.cmds\);/);
  // A plain answer and a hello have their own words ready: no ack in front.
  const plain = main.slice(main.indexOf('async function answerPlain('), main.indexOf('// -------- rewrite the selection'));
  assert.doesNotMatch(plain, /sayAck\(/);
});

test('a reflex ack is said before the volume key is pressed', async () => {
  const log = [];
  const probe = { request: async (op, p) => { log.push(op); if (op === 'fg') return { hwnd: 1 }; if (op === 'apps.list') return { apps: [] }; return { ok: true }; } };
  const jev = { ready: () => true, async systemOne() { return { answers: { intent: { choice: 'volume_down', confidence: 0.9 }, addressed: { noul: 0.9 } }, ms: 5, model: 'fake' }; } };
  const reflex = createReflex({ probe, shell: {}, jevClient: jev, onWillFire: (d) => log.push('ack:' + d.intent + ':' + d.final), spawnFn: () => ({ unref() {} }) });
  await reflex.start();
  await reflex.handle('turn it down', { final: true });
  assert.ok(log.indexOf('ack:volume_down:true') >= 0);
  assert.ok(log.indexOf('ack:volume_down:true') < log.indexOf('keys.chord'));
});

test('the usage ledger carries the ack time, and a spoken quick action gets its own row', () => {
  const ledger = main.slice(main.indexOf('function getLedger()'), main.indexOf('function guideSystemPrompt('));
  assert.match(ledger, /timings: Object\.assign\(\{\}, rec\.timings \|\| \{\}, \{ ack: a\.ms \}\)/);
  assert.match(main, /getLedger\(\)\.record\(\{ feature: 'reflex', provider: jev\.ready\(\) \? 'jev' : 'rules', outcome: f\.ok \? 'ok' : 'error', ms: f\.totalMs, timings: \{ ack: a\.ms, first_speech: a\.ms, jev: f\.jevMs \}/);
  const v = activityView([{ at: new Date().toISOString(), feature: 'reflex', outcome: 'ok', ms: 640, timings: { ack: 610, first_speech: 610 } }]);
  assert.equal(v.rows[0].feature, 'Quick action');
  assert.match(read('src', 'usage-ledger.js'), /ack: ms from the end of the person's words/);
});

test('the voice serves ready-made lines from the files and makes them at install and after a start', () => {
  const say = main.slice(main.indexOf("companionIpc.handle('companion:voice:say'"), main.indexOf("companionIpc.on('companion:voice:stop'"));
  assert.ok(say.indexOf('getLines().get(line)') < say.indexOf('getVoice().synth(line)'), 'the file before the model');
  assert.match(say, /getLines\(\)\.put\(line, a\)/);
  assert.match(main, /voiceInstall: \(name\) => getVoice\(\)\.install\(name\)\.then\(\(st\) => \{ if \(st && st\.installed\) prerenderLines\('install'\);/);
  assert.match(main, /setTimeout\(\(\) => prerenderLines\('start'\), 30000\)/);
  assert.match(main, /dir: path\.join\(app\.getPath\('userData'\), 'voice', 'lines'\)/);
  // The hello in the Knot's voice is kept too.
  assert.match(main, /keep: \(line\) => LINES\.includes\(line\) \|\| TOUR_LINES\.has\(line\) \|\| \/\^Hi/);
});

test('the reply after an ack queues behind it; without an ack a new reply still cuts in', () => {
  const body = ui.slice(ui.indexOf('  let companionVoiceEnabled ='), ui.indexOf('  async function runMode('));
  const spoken = []; let cancels = 0;
  const ctx = { settings: { speakReplies: true }, pttHeld: false, voice: null, plainify: (t) => t, Date,
    SpeechSynthesisUtterance: function (t) { this.text = t; }, speechSynthesis: { cancel() { cancels++; }, speak: (u) => spoken.push(u) },
    nus: { on() {} }, syncKnotUi() {}, setTimeout, clearTimeout };
  vm.runInNewContext(body, ctx);
  vm.runInNewContext('say("On it.", { restart: true, ack: true }); say("Opening Notepad.", { restart: true });', ctx);
  assert.deepEqual(spoken.map((u) => u.text), ['On it.'], 'the reply waits its turn');
  const c0 = cancels;
  spoken[0].onend();
  assert.deepEqual(spoken.map((u) => u.text), ['On it.', 'Opening Notepad.']);
  assert.equal(cancels, c0, 'nothing was cut off');
  // Later, a new reply restarts as it always did.
  vm.runInNewContext('say("Next thing.", { restart: true });', ctx);
  assert.ok(cancels > c0);
  // A ready-made line plays in the Knot's voice even while the model loads.
  assert.match(ui, /ownVoice\.ready \|\| \(opts && opts\.cached && ownVoice\.installed\)/);
  // (0.1.38: the line also carries its sentence number, for marks drawn as it is spoken.)
  assert.match(ui, /say\(p\.text, \{ restart: !!p\.first, ack: !!p\.ack, cached: !!p\.cached, sid: [^}]+\}\)/);
});

test('small talk and hello are answered by code, before Hands, the reflex layer or a model', () => {
  const route = main.slice(main.indexOf('async function routeUtterance('), main.indexOf('function routeUtteranceSlow('));
  const iTalk = route.indexOf('smallTalk(text)');
  assert.ok(iTalk > route.indexOf('greeting(text)'));
  assert.ok(iTalk < route.indexOf('if (handsClaims(text))'));
  assert.ok(iTalk < route.indexOf('r.handle(text'));
  assert.match(route, /knotBusyWithSomething\(\) \? null : smallTalk\(text\)/, '"thanks" still winds up a walkthrough or answers a card');
  assert.match(main, /function sayShort\(line, source, heardAt, what\)/);
  assert.match(main, /function sayHello\(source, heardAt\) \{ sayShort\(helloLine\(\), source, heardAt, 'hello'\); \}/);
});

test('"stop" and "I got it from here" cut the Knot off', () => {
  for (const t of ['stop', 'Stop.', 'stop talking', 'I got it from here.', "I've got it", 'okay I got it from here', 'I can take it from here', "I'll take it from here", 'got it', 'be quiet', 'shh', "I'm good"]) assert.equal(classifyUtterance(t).kind, 'dismiss', t);
  for (const t of ['I got it working, now open Word', 'stop the music', 'how do I stop this']) assert.equal(classifyUtterance(t).kind, 'ask', t);
  const route = main.slice(main.indexOf('async function routeUtterance('), main.indexOf('function routeUtteranceSlow('));
  assert.match(route, /if \(classifyUtterance\(text\)\.kind === 'dismiss' && !\(assignment && assignment\.isOn\(\)\)\) \{ routeLog\('-> stop: "' \+ String\(text\)\.slice\(0, 60\) \+ '"'\); hushSpeech\('voice'\);/);
  assert.ok(route.indexOf("classifyUtterance(text).kind === 'dismiss'") < route.indexOf('r.handle(text'));
  assert.match(read('preload.js'), /'voice:hush'/);
  assert.match(ui, /nus\.on\('voice:hush', \(\) => stopSpeaking\(\)\)/);
  // The talk key going down already stops the voice in the renderer.
  assert.match(ui, /if \(pttHeld\) \{ stopSpeaking\(\); startMic\(\); \}/);
});

// Start-up lag (2026-11-11): asking which lines are missing read every line's audio on the main
// thread, 150 to 730 ms at a time. The question is answered from each file's header now.
test('which lines are missing is answered without reading their audio', async () => {
  const dir = tmp();
  const made = createLineCache({ dir, voiceKey: () => 'k', synth: async () => tone() });
  await made.prerender();
  const fsMod = require('node:fs');
  const cold = createLineCache({ dir, voiceKey: () => 'k', synth: async () => { throw new Error('must not synthesize'); } });
  const real = fsMod.readFileSync;
  let reads = 0;
  fsMod.readFileSync = function (...args) { reads++; return real.apply(this, args); };
  try {
    assert.deepEqual(cold.missing(), [], 'every line is there');
    assert.equal(reads, 0, 'and no audio file was read to find that out');
    assert.equal(cold.has(LINES[0]), true);
    assert.equal(cold.has('A line nobody made.'), false);
  } finally { fsMod.readFileSync = real; }
  // A file cut short (a crash mid-save leaves it empty or tiny) counts as missing, so it is made again.
  fsMod.writeFileSync(cold.file(LINES[0]), '');
  fsMod.writeFileSync(cold.file(LINES[1]), 'RIFF');
  const fresh = createLineCache({ dir, voiceKey: () => 'k', synth: async () => tone() });
  assert.deepEqual(fresh.missing(), [LINES[0], LINES[1]]);
  // Anything else wrong with a file shows when the line is said: no audio comes back, so it is made live.
  fsMod.writeFileSync(fresh.file(LINES[3]), Buffer.alloc(200, 1));
  assert.equal(fresh.get(LINES[3]), null);
  // Saying a line still reads its audio.
  assert.ok(fresh.get(LINES[2]).pcm.length > 0);
});

test('a reply cut off says no more of its lines; the next reply speaks', () => {
  const body = main.slice(main.indexOf('let speakMuteUntil ='), main.indexOf('// What the Companion knows'));
  const sent = [];
  const ctx = { hooks: {}, ptt: { held: false }, listener: null, win: { isDestroyed: () => false, webContents: { send: (c, p) => sent.push([c, p]) } }, Date, Map, String, IS_MAC: false };
  vm.runInNewContext(body, ctx);
  const say = (text, first, stream) => vm.runInNewContext('send("guide:say", ' + JSON.stringify({ text, first, stream, sessionId: null }) + ')', ctx);
  say('Paris is the capital.', true, 'answer:1');
  say('It sits on the Seine.', false, 'answer:1');
  vm.runInNewContext('hushSpeech("voice")', ctx);
  say('It has two million people.', false, 'answer:1');
  say('Opening Word.', true, 'hands');
  say('Done, a blank document is open.', false, 'hands');
  const said = sent.filter(([c]) => c === 'guide:say').map(([, p]) => p.text);
  assert.deepEqual(said, ['Paris is the capital.', 'It sits on the Seine.', 'Opening Word.', 'Done, a blank document is open.']);
  assert.ok(sent.some(([c]) => c === 'voice:hush'));
  // The streams that can be cut: plain answers, Hands, walkthrough steps.
  assert.match(main, /send\('guide:say', \{ text: ev\.text, first: said === 1, sessionId: null, stream \}\)/);
  assert.match(main, /stream: 'hands' \}\)/);
  assert.match(read('src', 'guide', 'session.js'), /stream: 'guide:' \+ s\.id/);
  // The key going down starts a new turn too.
  const start = main.slice(main.indexOf('function pttStart()'), main.indexOf('async function pttStop('));
  assert.match(start, /speechTurn\+\+;/);
  // A plain answer cut off shows no bubble afterwards.
  assert.match(main, /if \(speechStoppedAt > t0\) \{ outcome = 'stopped'; return; \}/);
});

test('the words so far show by the Knot while the key is held, and are masked from screenshots', () => {
  const heard = main.slice(main.indexOf('const HEARD_MAX'), main.indexOf('function guidePointing()'));
  const sent = [];
  const ctx = { ptt: { held: true, heard: '' }, send: (c, p) => sent.push([c, p]), String };
  vm.runInNewContext(heard, ctx);
  vm.runInNewContext('showHeard("search youtube for")', ctx);
  assert.deepEqual(JSON.parse(JSON.stringify(sent.at(-1))), ['guide:hint', { text: 'You: search youtube for', ms: 15000, live: true }]);
  vm.runInNewContext('heardSegment("Search YouTube for study music,"); showHeard("pick one")', ctx);
  assert.equal(sent.at(-1)[1].text, 'You: Search YouTube for study music, pick one');
  vm.runInNewContext('showHeard("' + 'and play it '.repeat(20) + '")', ctx);
  assert.ok(sent.at(-1)[1].text.length <= 150 && sent.at(-1)[1].text.startsWith('You: …'), 'a long sentence shows its end');
  ctx.ptt.held = false; const n = sent.length;
  vm.runInNewContext('showHeard("late")', ctx);
  assert.equal(sent.length, n, 'nothing after the key comes up, unless asked to linger');
  // Wired to the listener, cleared per press, lingers briefly after release.
  assert.match(main, /onPartial: \(text, meta\) => \{ showHeard\(text\);/);
  assert.match(main, /ptt\.heard = ''; ptt\.lastPartial = '';/);
  assert.match(main, /if \(ptt\.heard \|\| ptt\.lastPartial\) showHeard\(ptt\.lastPartial, 3000\);/);
  // The renderer swaps the text in place and re-measures the box, which main masks.
  assert.match(ui, /if \(p\.live && isShown\(knotHint\) && knotHint\.dataset\.live === '1'\)/);
  assert.match(ui, /requestAnimationFrame\(reportHintRect\)/);
  assert.match(main, /if \(hintRect\) masks\.push\(rect\(hintRect\.x, hintRect\.y, hintRect\.x \+ hintRect\.w, hintRect\.y \+ hintRect\.h\)\)/);
});

test('reply shape: the first sentence names the action in five words or fewer, no preamble', () => {
  const { SYSTEM: HANDS } = require('../src/hands/prompt');
  const { SYSTEM: GUIDE } = require('../src/guide/pointing');
  assert.match(HANDS, /first sentence of a reply is at most five words and names the action/);
  assert.match(HANDS, /never start with "Sure", "Okay"/);
  assert.match(HANDS, /The done line carries one concrete detail/);
  assert.match(GUIDE, /in the first five words \("Click Insert, top left\."\), with no preamble/);
  assert.match(main, /The first sentence is at most five words and is the answer itself, no preamble/);
  // The examples follow the rule.
  for (const m of HANDS.matchAll(/^'?"[^"]+":\s*"(?:\[GOAL:[^\]]*\]\s*)?([^[.?!]+[.?!])/gm)) assert.ok(m[1].trim().split(/\s+/).length <= 5, m[1]);
  for (const t of [HANDS, GUIDE]) assert.doesNotMatch(t, /—/);
});

test('"circle it" rings the control the walkthrough points at, and only then', () => {
  const m = /const CIRCLE_IT = (\/.+\/i);/.exec(main);
  const re = vm.runInNewContext(m[1]);
  for (const t of ['circle it', 'Circle that.', 'can you circle it for me', 'highlight that button please', 'draw a circle around it']) assert.ok(re.test(t), t);
  for (const t of ['circle the answer in my notes', 'highlight the second paragraph', 'circle back to this later']) assert.ok(!re.test(t), t);
  const route = main.slice(main.indexOf('async function routeUtterance('), main.indexOf('function routeUtteranceSlow('));
  assert.match(route, /if \(CIRCLE_IT\.test\(String\(text\)\.trim\(\)\) && guidePointing\(\)\) \{ routeLog\('-> circle the pointed control'\); sayAck\('sure', source, heardAt\); send\('guide:circle', \{\}\); return; \}/);
  assert.match(read('preload.js'), /'guide:circle'/);
  assert.match(ui, /nus\.on\('guide:circle', \(\) => \{ if \(!drawCircle\(\)\) showHint/);
  // A new step, or the end of the walkthrough, takes the ring away.
  assert.match(ui, /clearCircle\(\); lastTargetRect = rect;/);
  assert.match(ui, /setGuideState\(null\);\n    clearCircle\(\); lastTargetRect = null;/);
  assert.match(read('renderer', 'styles.css'), /\.guide-circle \{ position: fixed; z-index: 2; pointer-events: none;/);
});
