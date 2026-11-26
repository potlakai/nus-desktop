// Questions about the screen get an answer; only "where" and "how do I" get
// pointed at (live 2026-11-11: "summarize the output here" was walked through
// clicks, the Knot circled Claude's text box and said to type "summarize").
// The test set and its scorer live in test/ask-routing/.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { screenAsk, answerish, vagueAsk, handsAskBack, noClickLine, normalize } = require('../src/guide/screen-ask');
const { buildScreenAnswer, answerMs } = require('../src/guide/screen-answer');
const { SYSTEM: POINT_SYSTEM, parsePointReply, validatePoint } = require('../src/guide/pointing');
const { parseReply } = require('../src/guide/reply-stream');
const { needsScreen, isTask } = require('../src/reflex/rules');
const { GuideSession } = require('../src/guide/session');
const { load, simulate, behaviourOf } = require('./ask-routing/simulate');

const root = path.join(__dirname, '..');
const readSet = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, 'ask-routing', f), 'utf8')).asks;
// The held-out set scored 20 of 24 on its first run (score-heldout-after-first.json);
// its four misses were fixed after, so it is a regression set now, not a held-out one.
const SET = readSet('asks.json').concat(readSet('asks-heldout.json'));

// ---- the whole local route, on every ask in the set --------------------------
test('every ask in the test set takes the right local route, Hands off and on', async () => {
  const m = load(root);
  const wrong = [];
  for (const hands of [false, true]) {
    for (const a of SET) {
      if (a.needsHands && !hands) continue;
      const r = await simulate(m, a.text, { hands });
      if (behaviourOf(r.route) !== a.want) wrong.push((hands ? 'hands on: ' : 'hands off: ') + '"' + a.text + '" want ' + a.want + ', got ' + r.route + (r.why ? ' (' + r.why + ')' : ''));
    }
  }
  assert.deepEqual(wrong, []);
});

test('his own words from 2026-11-11 all reach an answer, typed and spoken', async () => {
  const m = load(root);
  for (const a of SET.filter((x) => x.real)) {
    const r = await simulate(m, a.text, { hands: false });
    assert.ok(['page', 'screen-answer'].includes(r.route), a.text + ' -> ' + r.route);
  }
});

// ---- the rule itself ---------------------------------------------------------
test('screen questions: summarize, read, explain, describe, check, ask', () => {
  const cases = {
    'summarize what is going on here': 'summarize',
    'sumamrize waht was going on here': 'summarize',
    'Sutterize this text box.': 'summarize',
    'I want you to summarize it for me.': 'summarize',
    'summarize': 'summarize',
    'give me the gist of this': 'summarize',
    'read it to me': 'read',
    'Can you read what this says?': 'read',
    'explain this error': 'explain',
    'can u explain whats on the screen rn': 'explain',
    'describe what\'s on my screen': 'describe',
    'tell me about this': 'describe',
    'is this right': 'check',
    'is my answer correct': 'check',
    'did i do this right': 'check',
    'What do you see here?': 'ask',
    'what am I looking at': 'ask',
    'why is this red': 'ask',
    'what\'s going on here': 'ask',
  };
  for (const [t, mode] of Object.entries(cases)) assert.equal((screenAsk(t) || {}).mode, mode, t);
  // Page text first only for summaries and read-outs.
  assert.equal(screenAsk('summarize what you see').page, true);
  assert.equal(screenAsk('explain this error').page, false);
});

test('not screen questions: where, how do I, show me, a second action, general knowledge', () => {
  for (const t of [
    'how do I summarize this in Word', 'where is the submit button', 'show me where the settings are',
    'how can I change the font size here', 'click the blue button', 'walk me through this form',
    'summarize this and email it to my professor', 'read this then reply to Lee', 'open the pdf and summarize it',
    'summarize the french revolution', 'explain photosynthesis', 'what\'s the capital of australia',
    'what is going on with the economy', 'what is the answer to life', 'explain it like im twelve',
    'what time is sunrise', 'is it true that cats cannot taste sweet', 'is the earth round', 'open spotify',
  ]) assert.equal(screenAsk(t), null, t);
});

test('speech-to-text spellings of summarize are read as summarize, and nothing else is', () => {
  for (const w of ['sumamrize', 'summerize', 'summarise', 'Sutterize', 'somerize', 'summarized']) assert.match(normalize(w + ' this'), /^summarize/i, w);
  for (const w of ['sunrise', 'satirize', 'sterilize', 'summary']) assert.equal(normalize(w), w, w);
});

test('a general summary is answered in words and is never a Hands task', () => {
  assert.equal(needsScreen('summarize the french revolution'), false);
  assert.equal(isTask('summarize the french revolution'), false);
  assert.equal(isTask('explain photosynthesis'), false);
  // Still tasks: something of theirs to open, or a second action.
  assert.equal(isTask('summarize my emails'), true);
  assert.equal(isTask('summarize this and email it to my professor'), true);
});

test('too vague to act on: ask back', () => {
  for (const t of ['help', 'Help.', 'can you help me', 'help me out', 'do the thing', 'um so like', 'uh']) assert.ok(vagueAsk(t), t);
  for (const t of ['help me make a table', 'can you help me summarize this', 'do it', 'open notepad']) assert.ok(!vagueAsk(t), t);
});

test('a step that hands the ask back, or says there is nothing to click, is caught', () => {
  assert.ok(handsAskBack('Type "summarize for me" in the message box.', 'summarize what you see'));
  assert.ok(handsAskBack("Click the text box and type 'summarize this'.", 'summarize the output here'));
  assert.ok(handsAskBack('Ask Claude to summarize it for you.', 'I want you to summarize it for me'));
  assert.ok(handsAskBack('Type your question in the chat box.', 'what does this mean'));
  assert.ok(!handsAskBack('Click Insert, top left.', 'how do I make a table'));
  assert.ok(!handsAskBack('Type hello.', 'open notepad and type hello'), 'the ask itself is about typing');
  assert.ok(!handsAskBack('Click Submit. This sends it.', 'where is the submit button'));
  assert.ok(noClickLine('Nothing to click here.'));
  assert.ok(noClickLine("There's nothing to click for this."));
  assert.ok(!noClickLine('Click Save.'));
  assert.ok(answerish('what is this'));
  assert.ok(!answerish('where do I turn on dark mode'));
});

// ---- the prompts -------------------------------------------------------------
test('the pointing prompt sends questions back with [ANSWER] and forbids handing the ask back', () => {
  assert.match(POINT_SYSTEM, /question about the screen[^\n]*Reply with exactly \[ANSWER\]/);
  assert.match(POINT_SYSTEM, /Never tell the user to type their question or request into a text box/);
  const r = parseReply('[ANSWER]');
  assert.equal(r.reply.answer, true);
  assert.equal(r.spoken.length, 0, 'nothing spoken');
  const v = validatePoint(parsePointReply('[ANSWER]'), []);
  assert.equal(v.ok, true);
  assert.equal(v.reply.answer, true);
});

test('the screen answer prompt answers in words, short and plain', () => {
  const q = buildScreenAnswer({ ask: 'summarize the output here', mode: 'summarize', window: { title: 'Claude', process: 'claude' } });
  assert.match(q.system, /Answer the question yourself, in words/);
  assert.match(q.system, /Never tell them to type their question/);
  assert.match(q.system, /Summarize what is on the screen/);
  assert.match(q.system, /no em dashes/);
  assert.match(q.text, /Front window: Claude \(claude\)\nThey asked: "summarize the output here"/);
  assert.ok(answerMs('word '.repeat(60)) > answerMs('Yes.'));
  assert.ok(answerMs('word '.repeat(500)) <= 60000);
});

// ---- the guide session -------------------------------------------------------
const CAP = { dataUrl: 'data:image/png;base64,AAAA', width: 1280, height: 720, pxWidth: 1920, pxHeight: 1080, display: { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 } };
const ELEMENTS = [
  { id: 3, name: 'Write your prompt to Claude', type: 'Edit', rect: { x: 600, y: 900, w: 700, h: 60 } },
  { id: 4, name: 'Submit', type: 'Button', rect: { x: 1500, y: 900, w: 160, h: 40 } },
];
const FG = { hwnd: 77, title: 'Claude', process: 'claude', pid: 500 };
function harness(replies) {
  const sent = [], prompts = [], logs = [], timings = [];
  const probe = {
    available: true, watching: null,
    async request(op) { if (op === 'fg') return FG; if (op === 'uia.list') return { elements: ELEMENTS, ms: 50, visited: 20 }; return { element: null }; },
    async watch() { return { ok: true }; }, async unwatch() { return { ok: true }; }, status() { return { watching: null }; },
  };
  const g = new GuideSession({
    capture: async () => CAP, probe,
    llm: () => ({ ready: true, provider: 'publik', async complete(args) { const { onDelta, ...asked } = args; prompts.push(asked); const r = replies.shift(); if (onDelta && typeof r === 'string') onDelta(r); return r; } }),
    send: (ch, p) => sent.push([ch, p]), screenToDip: (p) => p, dipToScreen: (p) => p,
    winBounds: () => ({ x: 0, y: 0, width: 1920, height: 1040 }), hashCapture: () => ({ whole: new Uint8Array(32), crop: new Uint8Array(32) }),
    selfPid: 999, log: (m) => logs.push(m), sleep: async () => {}, now: () => 1000, onTiming: (r) => timings.push(r),
  });
  return { g, sent, prompts, logs, timings };
}
const of = (sent, ch) => sent.filter(([c]) => c === ch).map(([, p]) => p);
const spoken = (sent) => of(sent, 'guide:say').map((p) => p.text).concat(of(sent, 'guide:hint').map((p) => p.text));

test('answer mode: one screenshot, the answer prompt, an answer bubble, no pointer', async () => {
  const { g, sent, prompts, timings } = harness(['It is a chat about the Rust switch. The last reply lists three costs.']);
  await g.start('summarize the output here', 'voice', { askedAt: 900, answer: 'summarize' });
  assert.equal(prompts.length, 1);
  assert.match(prompts[0].system, /Answer the question yourself, in words/);
  assert.equal(prompts[0].imageDataUrl, CAP.dataUrl);
  assert.equal(of(sent, 'guide:target').length, 0, 'never a pointer');
  const bubble = of(sent, 'guide:bubble').pop();
  assert.equal(bubble.text, 'It is a chat about the Rust switch. The last reply lists three costs.');
  assert.equal(bubble.kicker, 'answer');
  assert.equal(g.status().state, 'explaining');
  assert.equal(timings.pop().end, 'answer', 'a ledger row that is not an "explain"');
});

test('a pointing step with nothing to click, for a question, becomes the answer and is never heard', async () => {
  const { g, sent, prompts } = harness(['Nothing to click here.\n[POINT:none]\n[CONF:0.2]', 'It shows a terminal with three passing tests.']);
  await g.start('what is on this screen right now', 'voice', { askedAt: 900 });
  assert.equal(prompts.length, 2, 'pointing, then the answer');
  assert.match(prompts[1].system, /Answer the question yourself/);
  assert.equal(of(sent, 'guide:bubble').pop().text, 'It shows a terminal with three passing tests.');
  assert.ok(!spoken(sent).some((t) => /nothing to click/i.test(t)), 'the no-click line is never said');
});

test('a pointing step that says to type the ask into the text box is blocked and answered instead', async () => {
  const { g, sent, prompts } = harness(['Type "summarize for me" in the message box.\n[POINT:3]\n[CONF:0.9]', 'The chat is about pricing; the last message asks for a cap.']);
  await g.start('could you give a quick overview of what this shows', 'typed', { askedAt: 900 });
  assert.equal(prompts.length, 2);
  assert.equal(of(sent, 'guide:target').length, 0, 'the text box is never circled');
  assert.ok(!spoken(sent).some((t) => /type/i.test(t)));
  assert.equal(of(sent, 'guide:bubble').pop().text, 'The chat is about pricing; the last message asks for a cap.');
});

test('the model saying [ANSWER] hands over to the answer from the same screenshot', async () => {
  const { g, sent, prompts } = harness(['[ANSWER]', 'Yes, the sum is right: 12 plus 30 is 42.']);
  await g.start('does the total add up', 'voice', { askedAt: 900 });
  assert.equal(prompts.length, 2);
  assert.equal(prompts[1].imageDataUrl, CAP.dataUrl);
  assert.equal(of(sent, 'guide:bubble').pop().text, 'Yes, the sum is right: 12 plus 30 is 42.');
});

test('a real "where is" ask still points, as before', async () => {
  const { g, sent, prompts } = harness(['Click Submit. This sends it.\n[POINT:4]\n[CONF:0.9]']);
  await g.start('where is the submit button', 'voice', { askedAt: 900 });
  assert.equal(prompts.length, 1);
  const t = of(sent, 'guide:target').pop();
  assert.ok(t, 'pointed');
  assert.equal(t.instruction, 'Click Submit. This sends it.');
});

// ---- the wiring in index.js ---------------------------------------------------
test('index.js: screen questions skip the reflex layer and Hands, vague asks are asked back', () => {
  const main = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
  assert.match(main, /function ownPath\(text\) \{[^}]*screenAsk\(text\)/);
  const answer = main.slice(main.indexOf('function routeAnswer('), main.indexOf('const ANSWER_SYSTEM'));
  assert.ok(answer.indexOf('vagueAsk(kind.text)') > 0 && answer.indexOf('vagueAsk(kind.text)') < answer.indexOf('needsScreen(kind.text)'), 'ask back before any screen read');
  assert.match(answer, /sayShort\(CLARIFY_LINE, source, heardAt, 'ask back'\)/);
});
