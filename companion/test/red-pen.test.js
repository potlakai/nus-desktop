// The red pen (0.1.39): "check my work" marks each mistake on the screen in
// red, writes the fix beside it, and ticks what is right. The asks that mean
// it, the tags, the placing (never on a guess), the prompt, and the strokes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { parseMarkTag, parseOcrWords, resolveMark, sameMark, PEN_RULES, DRAW_RULES } = require('../src/guide/marks');
const { parseReply } = require('../src/guide/reply-stream');
const { buildScreenAnswer } = require('../src/guide/screen-answer');
const { screenAsk } = require('../src/guide/screen-ask');
const { findAsk } = require('../src/guide/find');
const { GuideSession } = require('../src/guide/session');
const Marks = require('../renderer/marks');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
const CAP = { dataUrl: 'data:image/jpeg;base64,AAAA', width: 1280, height: 720, pxWidth: 1920, pxHeight: 1080, display: { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 } };
const line = (y, words, x0 = 100) => { let x = x0; return words.map((w) => { const row = x + ' ' + y + ' ' + (w.length * 10) + ' 18 ' + w; x += w.length * 10 + 8; return row; }).join('\n'); };
// A worked problem with a slip in it, and a sentence with a wrong word.
const OCR = Object.assign({ width: 1920, height: 1080 }, parseOcrWords([
  line(200, ['3x', '+', '6', '=', '21']),
  line(240, ['3x', '=', '27']),
  line(280, ['x', '=', '9']),
  line(400, ['Their', 'going', 'to', 'the', 'library', 'after', 'the', 'lecture', 'ends', 'on', 'Friday']),
  line(600, ['Total', '149']),
].join('\n\n')));
const ctx = (over) => Object.assign({ elements: [], ocr: OCR, cap: CAP, originPhys: { x: 0, y: 0 }, ids: false }, over);

test('the asks that mean "check my work", and the ones that are something else', () => {
  for (const t of ['check my work', 'Check my math.', 'can you check my answer for me', 'grade this', 'check this', 'double check my calculations', 'proofread my essay', 'red pen this',
    'what did I get wrong', 'where did I go wrong', "where's my mistake", 'find my mistakes', 'any mistakes here', 'did I get this right', "what's wrong with my code", 'look over my essay for mistakes',
    'is this total right', 'is my answer correct']) assert.deepEqual(screenAsk(t), { mode: 'check', page: false }, t);
  // Checking something that is not their work on the screen is a task or a question for another path.
  for (const t of ['check my email', 'check the weather', 'mark this as done', 'review my calendar', 'check if the store is open', 'check out this video', 'correct me if I am wrong']) assert.notDeepEqual(screenAsk(t), { mode: 'check', page: false }, t);
  // "Where's my mistake" is not words to look up on the screen.
  for (const t of ["where's my mistake", 'find my mistakes', 'find the errors', 'where is my mistake']) assert.equal(findAsk(t), null, t);
  assert.ok(findAsk('find the error message'), 'a thing named error is still a thing');
});

test('the pen\'s tags: a mistake with its fix, a mistake alone, a tick', () => {
  assert.deepEqual(parseMarkTag('WRONG', '"149" = 184'), { type: 'mark', shape: 'wrong', target: { kind: 'words', text: '149' }, fix: '184' });
  assert.deepEqual(parseMarkTag('wrong', '"their going"'), { type: 'mark', shape: 'wrong', target: { kind: 'words', text: 'their going' } });
  assert.deepEqual(parseMarkTag('WRONG', '"Their going" = "They\'re going"').fix, "They're going");
  assert.deepEqual(parseMarkTag('WRONG', '"3x = 27" = 3x = 15'), { type: 'mark', shape: 'wrong', target: { kind: 'words', text: '3x = 27' }, fix: '3x = 15' }, 'an equals sign inside the quotes is the work, not the divider');
  assert.deepEqual(parseMarkTag('WRONG', '"x = 9" -> x = 5').fix, 'x = 5');
  assert.deepEqual(parseMarkTag('RIGHT', '"3x + 6 = 21"'), { type: 'mark', shape: 'right', target: { kind: 'words', text: '3x + 6 = 21' } });
  // A fix is a number or a few words, never a paragraph.
  assert.ok(parseMarkTag('WRONG', '"149" = ' + 'far too long a correction to write beside a number on a screen').fix.length <= 28);
  assert.equal(parseMarkTag('WRONG', ''), null);
  // In a reply they come out after their sentence and are never spoken.
  const r = parseReply('No, the second line is wrong. [WRONG:"3x = 27" = 3x = 15] That makes x five, not nine as written. [WRONG:"x = 9" = x = 5] The first line is fine as it stands. [RIGHT:"3x + 6 = 21"]', { marks: true });
  assert.deepEqual(r.spoken, ['No, the second line is wrong.', 'That makes x five, not nine as written.', 'The first line is fine as it stands.']);
  assert.deepEqual(r.events.filter((e) => e.type === 'mark').map((e) => [e.shape, e.sentence, e.fix || '']), [['wrong', 0, '3x = 15'], ['wrong', 1, 'x = 5'], ['right', 2, '']]);
  assert.ok(!r.spoken.join(' ').includes('['));
  // Without marks asked for they are ordinary brackets, as before.
  assert.equal(parseReply('It is wrong. [WRONG:"149" = 184]').events.length, 0);
});

test('the pen lands on the words Windows read, with the fix, and never on a guess', () => {
  const m = resolveMark(parseMarkTag('WRONG', '"149" = 184'), ctx());
  assert.deepEqual([m.shape, m.rects, m.fix, m.verified, m.source], ['wrong', [{ x: 158, y: 600, w: 30, h: 18 }], '184', true, 'words']);
  const line2 = resolveMark(parseMarkTag('WRONG', '"3x = 27" = 3x = 15'), ctx());
  assert.deepEqual([line2.rects[0].y, line2.fix], [240, '3x = 15']);
  const tick = resolveMark(parseMarkTag('RIGHT', '"3x + 6 = 21"'), ctx());
  assert.deepEqual([tick.shape, tick.rects[0].y, tick.fix], ['right', 200, undefined]);
  // A mistake in the middle of a sentence: the fix is to go above it, not over the words that follow.
  const mid = resolveMark(parseMarkTag('WRONG', '"Their going" = They\'re going'), ctx());
  assert.deepEqual([mid.above, mid.fix], [true, "They're going"]);
  assert.equal(m.above, undefined, 'the end of a line has room beside it');
  // Words that are not on the screen: no mark (the spoken sentence still carries the fix).
  assert.equal(resolveMark(parseMarkTag('WRONG', '"x = 12" = x = 5'), ctx()), null);
  // A bare box with nothing Windows knows under it is a guess: the pen does not mark it.
  assert.equal(resolveMark(parseMarkTag('WRONG', '0.6,0.7,0.1,0.05:the answer = 5'), ctx()), null);
  // The same mistake marked twice is one mark; a tick and a cross on the same words are two.
  assert.ok(sameMark(m, resolveMark(parseMarkTag('WRONG', '"149" = 184'), ctx())));
  assert.ok(!sameMark(m, resolveMark(parseMarkTag('RIGHT', '"149"'), ctx())));
});

test('a check gets the pen\'s rules; every other ask keeps the plain marks', () => {
  const check = buildScreenAnswer({ ask: 'check my math', mode: 'check', window: { title: 'Homework', process: 'chrome' }, draw: true });
  for (const rule of PEN_RULES) assert.ok(check.system.includes(rule));
  assert.ok(!check.system.includes(DRAW_RULES[1]), 'not the underline rule: one pen at a time');
  assert.equal(check.pen, true);
  assert.match(check.text, /Check it now, in words, with a mark after each sentence that names a mistake\./);
  const explain = buildScreenAnswer({ ask: 'explain this', mode: 'explain', draw: true });
  assert.ok(explain.system.includes(DRAW_RULES[1]) && !/WRONG/.test(explain.system) && explain.pen === false);
  assert.ok(check.maxTokens > explain.maxTokens);
  // Drawing off: a check is words only, exactly as before.
  const off = buildScreenAnswer({ ask: 'check my math', mode: 'check' });
  assert.ok(!/WRONG|UNDERLINE/.test(off.system) && off.pen === false && off.maxTokens === 400);
  // The rules never ask for an em dash, and show real examples, not patterns.
  assert.ok(!/—|<target>/.test(PEN_RULES.join(' ')));
});

test('a short mistake is ringed, a long one underlined, and the fix is written where there is room', () => {
  const number = { shape: 'wrong', rects: [{ x: 158, y: 600, w: 30, h: 18 }], fix: '184' };
  const ring = Marks.strokesFor(number, 3);
  assert.equal(ring.length, 1);
  const nums = (d) => d.match(/-?\d+(?:\.\d+)?/g).map(Number);
  const xs = nums(ring[0].d).filter((_, i) => i % 2 === 0), ys = nums(ring[0].d).filter((_, i) => i % 2 === 1);
  assert.ok(Math.min(...xs) < 158 && Math.max(...xs) > 188 && Math.min(...ys) < 600 && Math.max(...ys) > 618, 'the ring goes round it');
  const sentence = { shape: 'wrong', rects: [{ x: 100, y: 400, w: 620, h: 18 }], fix: "They're going" };
  const under = Marks.strokesFor(sentence, 3);
  const uy = nums(under[0].d).filter((_, i) => i % 2 === 1);
  assert.ok(Math.min(...uy) > 418, 'a line under it, not a ring round a whole sentence');
  // Two lines of a long mistake: a stroke under each.
  assert.equal(Marks.strokesFor({ shape: 'wrong', rects: [{ x: 100, y: 400, w: 620, h: 18 }, { x: 100, y: 426, w: 200, h: 18 }] }, 3).length, 2);
  // The fix: to the right, on the words' own line.
  const view = { w: 1920, h: 1040 };
  const beside = Marks.notePlace(number, view);
  assert.ok(beside.x > 188 + 16 && Math.abs(beside.y - 615) < 12 && beside.text === '184', JSON.stringify(beside));
  // No room on the right: under the mistake, still on the screen.
  const edge = Marks.notePlace({ shape: 'wrong', rects: [{ x: 1850, y: 300, w: 40, h: 18 }], fix: 'should be 184' }, view);
  assert.ok(edge.y > 318 && edge.x + 'should be 184'.length * edge.size * Marks.NOTE.letter <= view.w - 8 && edge.x >= 8, JSON.stringify(edge));
  // No fix, nothing written.
  assert.equal(Marks.notePlace({ shape: 'wrong', rects: [{ x: 1, y: 1, w: 40, h: 18 }] }, view), null);
  // The line carries on to the right: the fix goes above the mistake, starting where it starts.
  const over = Marks.notePlace({ shape: 'wrong', rects: [{ x: 700, y: 400, w: 110, h: 18 }], fix: "They're going", above: true }, view);
  assert.ok(over.y < 400 && over.x === 700 && over.size <= beside.size + 1, JSON.stringify(over));
  // At the very top of the screen there is no room above: under it instead.
  assert.ok(Marks.notePlace({ shape: 'wrong', rects: [{ x: 700, y: 6, w: 110, h: 18 }], fix: 'x', above: true }, view).y > 24);
  // A tick sits just after the words.
  const tick = Marks.strokesFor({ shape: 'right', rects: [{ x: 100, y: 200, w: 110, h: 18 }] }, 3);
  const tx = nums(tick[0].d).filter((_, i) => i % 2 === 0);
  assert.ok(tick.length === 1 && Math.min(...tx) >= 210 && Math.max(...tx) < 250);
});

function harness(reply) {
  const sent = [], prompts = [];
  const g = new GuideSession({
    capture: async () => CAP,
    probe: { available: true, async request(op) { if (op === 'fg') return { hwnd: 7, title: 'Homework 4 - Chrome', process: 'chrome', pid: 5 }; if (op === 'uia.list') return { elements: [] }; return {}; }, async watch() { return { ok: true }; }, async unwatch() { return { ok: true }; }, status() { return { watching: null }; } },
    llm: () => ({ ready: true, provider: 'publik', async complete(req) { prompts.push(req); return reply; } }),
    send: (ch, p) => sent.push([ch, p]),
    screenToDip: (p) => p, dipToScreen: (p) => p,
    winBounds: () => ({ x: 0, y: 0, width: 1920, height: 1040 }),
    hashCapture: () => null, drawOn: () => true, readWords: async () => OCR,
    selfPid: 999, log: () => {}, sleep: async () => {}, now: () => 1000,
  });
  return { g, sent, prompts };
}
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

test('a checked page: the mistakes go to the overlay with their fixes, the bubble has the words', async () => {
  const h = harness('No, the second line is wrong. [WRONG:"3x = 27" = 3x = 15] So x is five, not nine. [WRONG:"x = 9" = x = 5] The first line is right. [RIGHT:"3x + 6 = 21"] [WRONG:"a line that is not there" = 7]');
  await h.g.start('check my math', 'typed', { answer: 'check' });
  await flush();
  assert.match(h.prompts[0].system, /red pen/);
  const marks = h.sent.filter(([c]) => c === 'guide:marks').map(([, p]) => p.marks[0]);
  assert.deepEqual(marks.map((m) => [m.shape, m.fix || '', m.rects[0].y]), [['wrong', '3x = 15', 240], ['wrong', 'x = 5', 280], ['right', '', 200]]);
  assert.equal(h.sent.filter(([c]) => c === 'guide:bubble').pop()[1].text, 'No, the second line is wrong. So x is five, not nine. The first line is right.');
});

// ---- after the first real try (2026-11-23): every check opened with "Not sure." and half the marks were missing ----
test('a check opens with what it found, on the careful brain, with no control list and a line to say it is working', async () => {
  const h = harness('I found one mistake. The total should be 184. [WRONG:"149" = 184]');
  let walked = 0;
  const request = h.g.d.probe.request;
  h.g.d.probe.request = async (op, ...rest) => { if (op === 'uia.list') walked += 1; return request(op, ...rest); };
  await h.g.start('check my work', 'voice', { answer: 'check' });
  await flush();
  const req = h.prompts[0];
  assert.match(req.system, /The first sentence says what you found, like "I found three mistakes\." or "This all checks out\.", never "not sure"\./);
  assert.ok(!/First say whether it looks right: yes, no, or not sure/.test(req.system), 'the verdict word is gone from a pen check');
  assert.match(req.system, /Redo each calculation yourself, step by step/);
  assert.equal(req.model, 'publik-smart', 'publik answers a check on its careful tier');
  assert.equal(walked, 0, 'no control walk: the pen marks words');
  assert.ok(!/Controls in the front window/.test(req.turns[0].text));
  const hints = h.sent.filter(([c]) => c === 'guide:hint').map(([, p]) => p.text);
  assert.equal(hints[0], 'Checking it line by line.', 'said on the screen at once, before the brain answers');
  // Asked by voice, the wait is spoken too, ahead of the brain's own first sentence (about 8 s on the careful tier).
  const says = h.sent.filter(([c]) => c === 'guide:say').map(([, p]) => p.text);
  assert.equal(says[0], 'Checking it line by line.');
  assert.ok(says.includes('I found one mistake.'), JSON.stringify(says));
  // Room to finish: the careful brain's thinking counts against the limit.
  assert.equal(req.maxTokens, 1500);
  // Another brain (an own key) is never sent publik's model name.
  const own = harness('This all checks out.');
  own.g.d.llm = () => ({ ready: true, provider: 'gemini', async complete(r) { own.prompts.push(r); return 'This all checks out.'; } });
  await own.g.start('check my work', 'typed', { answer: 'check' });
  await flush();
  assert.equal(own.prompts[0].model, undefined);
  // An ask that is not a check keeps the quick brain and the control list.
  const plain = harness('It is an error.');
  await plain.g.start('explain this error', 'typed', { answer: 'explain' });
  await flush();
  assert.equal(plain.prompts[0].model, undefined);
  // With drawing off, a check is the old words-only check, verdict word and all.
  const off = buildScreenAnswer({ ask: 'check my math', mode: 'check' });
  assert.match(off.system, /First say whether it looks right: yes, no, or not sure/);
});

test('the pen asks for the smallest wrong piece, and still lands when OCR lost part of what was quoted', () => {
  assert.ok(PEN_RULES.some((r) => r.includes('[WRONG:"27" = 15]') && r.includes('the smallest wrong piece')));
  assert.ok(PEN_RULES.some((r) => r.includes('Mark every real mistake, up to five')));
  // OCR read "3x = 27" as "3x 27" on one line and lost the x of "x = 9" altogether.
  const lossy = Object.assign({ width: 1920, height: 1080 }, parseOcrWords([line(200, ['3x', '6', '21']), line(240, ['3x', '27']), line(280, ['9']), line(600, ['Total', '149'])].join('\n\n')));
  const c = ctx({ ocr: lossy });
  const got = resolveMark(parseMarkTag('WRONG', '"3x = 27" = 3x = 15'), c);
  assert.deepEqual([got.rects[0].y, got.fix], [240, '3x = 15'], 'the line that holds its words');
  // One lone digit is not enough to say where a thing is.
  assert.equal(resolveMark(parseMarkTag('WRONG', '"x = 9" = x = 5'), c), null);
  // Two lines hold the words equally well: not marked rather than marked on the wrong one.
  const twice = Object.assign({ width: 1920, height: 1080 }, parseOcrWords([line(200, ['3x', 'is', '27']), line(240, ['3x', 'was', '27'])].join('\n\n')));
  assert.equal(resolveMark(parseMarkTag('WRONG', '"3x = 27" = 15'), ctx({ ocr: twice })), null);
  // The plain marks never place by part of what was quoted.
  assert.equal(resolveMark(parseMarkTag('UNDERLINE', '"3x = 27"'), c) && resolveMark(parseMarkTag('UNDERLINE', '"3x = 27"'), c).source, 'words', 'the letters in a row still match');
  assert.equal(resolveMark(parseMarkTag('UNDERLINE', '"3x plus six is 27"'), c), null);
});

test('"Great this." is "Grade this."', () => {
  assert.deepEqual(screenAsk('Great this.'), { mode: 'check', page: false });
  assert.deepEqual(screenAsk('okay great this'), { mode: 'check', page: false });
  assert.notDeepEqual(screenAsk('great job on this'), { mode: 'check', page: false });
});

test('the overlay knows the pen: red for a mistake, green for a tick, the fix in a hand, and the fix reaches it', () => {
  const css = read('renderer/styles.css');
  assert.ok(css.includes('#marks-layer .mark-wrong .mark-core { stroke: #ff4d4f; }'));
  assert.ok(css.includes('#marks-layer .mark-right .mark-core { stroke: #34c77b; }'));
  assert.match(css, /#marks-layer \.mark-note \{ font-family: 'Ink Free'/);
  assert.ok(css.includes('#marks-layer .mark-on-light .mark-note { fill: #d92d20; stroke: #fff; }'), 'readable on a white page');
  assert.ok(read('renderer/renderer.js').includes('light: !!m.light, fix: m.fix, above: !!m.above });'));
  assert.ok(read('renderer/marks.js').includes("t.setAttribute('class', 'mark-note'"));
});
