// Drawing on the screen (0.1.38): an answer about the screen marks what it
// talks about. The tags, the placing of each mark on something Windows
// reports, the timing with the spoken sentence, and the overlay's strokes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { parseMarkTag, parseTarget, parseOcrWords, findWords, resolveMark, sameMark, DRAW_RULES, MAX_MARKS } = require('../src/guide/marks');
const { ReplyStream, parseReply } = require('../src/guide/reply-stream');
const { buildScreenAnswer } = require('../src/guide/screen-answer');
const { GuideSession } = require('../src/guide/session');
const Marks = require('../renderer/marks');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');

// A 1920x1080 display captured at 1280x720 for the model, read by OCR at full size.
const CAP = { dataUrl: 'data:image/jpeg;base64,AAAA', width: 1280, height: 720, pxWidth: 1920, pxHeight: 1080, display: { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 } };
const ORIGIN = { x: 0, y: 0 };
const ELEMENTS = [
  { id: 1, name: 'Run', type: 'Button', rect: { x: 1700, y: 40, w: 70, h: 30 } },
  { id: 2, name: 'Save As', type: 'Button', rect: { x: 1500, y: 40, w: 90, h: 30 } },
  { id: 3, name: 'Save', type: 'Button', rect: { x: 1400, y: 40, w: 70, h: 30 } },
  { id: 4, name: 'Password', type: 'Edit', isPassword: true, rect: { x: 600, y: 500, w: 300, h: 36 } },
];
// One word per row "x y w h word"; a blank row between lines.
const line = (y, words, x0 = 100) => { let x = x0; return words.map((w) => { const row = `${x} ${y} ${w.length * 10} 18 ${w}`; x += w.length * 10 + 8; return row; }).join('\n'); };
const OCR = Object.assign({ width: 1920, height: 1080 }, parseOcrWords([
  line(200, ['Traceback', '(most', 'recent', 'call', 'last):']),
  line(230, ['File', '"app.py",', 'line', '12,', 'in', '<module>']),
  line(260, ['NameError:', 'name', "'total'", 'is', 'not', 'defined']),
  line(600, ['Total', 'is', 'shown', 'in', 'the', 'window']),
  line(640, ['Total', 'again', 'further', 'down'], 900),
].join('\n\n')));
const ctx = (over) => Object.assign({ elements: ELEMENTS, ocr: OCR, cap: CAP, originPhys: ORIGIN }, over);

test('a mark tag reads as a shape and a target: an id, quoted words, or a box with what it is', () => {
  assert.deepEqual(parseMarkTag('CIRCLE', '12'), { type: 'mark', shape: 'circle', target: { kind: 'element', id: 12 } });
  assert.deepEqual(parseMarkTag('underline', '"is not defined"'), { type: 'mark', shape: 'underline', target: { kind: 'words', text: 'is not defined' } });
  assert.deepEqual(parseMarkTag('UNDERLINE', '“is not defined”').target, { kind: 'words', text: 'is not defined' });
  // A box is left, top, right, bottom; one written as left, top, width, height (the last two not past the first two) is read as that.
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  const chart = parseMarkTag('BOX', '0.10,0.20,0.40,0.45:the bar chart').target;
  assert.ok(chart.kind === 'bbox' && near(chart.x, 0.1) && near(chart.y, 0.2) && near(chart.w, 0.3) && near(chart.h, 0.25) && chart.label === 'the bar chart');
  assert.deepEqual(parseMarkTag('BOX', '0.50,0.60,0.20,0.10:the logo').target, { kind: 'bbox', x: 0.5, y: 0.6, w: 0.2, h: 0.1, label: 'the logo' });
  // What the real brains wrote on 2026-11-23: pixels as corners, numbers in brackets, a bare number, a pattern copied out of the rules.
  assert.deepEqual(parseMarkTag('BOX', '403,169,863,407').target, { kind: 'bbox', x: 403, y: 169, w: 460, h: 238, label: '' });
  assert.deepEqual(parseMarkTag('BOX', '(340, 110, 1230, 380)').target, { kind: 'bbox', x: 340, y: 110, w: 890, h: 270, label: '' });
  assert.equal(parseMarkTag('BOX', '<target>'), null);
  assert.equal(parseMarkTag('ARROW', '<target> -> <target>'), null);
  // The quotes forgotten: still words.
  assert.deepEqual(parseTarget('Sign in'), { kind: 'words', text: 'Sign in' });
  const a = parseMarkTag('ARROW', '"Total" -> 3');
  assert.deepEqual([a.shape, a.target, a.to], ['arrow', { kind: 'words', text: 'Total' }, { kind: 'element', id: 3 }]);
  // An arrow sign inside the quoted words is words, not the arrow.
  assert.deepEqual(parseMarkTag('ARROW', '"a -> b" → 2').target, { kind: 'words', text: 'a -> b' });
  for (const [k, b] of [['CIRCLE', ''], ['ARROW', '"only one end"'], ['SQUIGGLE', '3'], ['BOX', '!!!']]) assert.equal(parseMarkTag(k, b), null, k + ' ' + b);
});

test('a mark comes out after the sentence it belongs to, numbered with it, and never splits that sentence', () => {
  const rs = new ReplyStream({ marks: true });
  const ev = [];
  for (const ch of 'The name was never made. [UNDERLINE:"is not defined"] Look at line twelve where [CIRCLE:"line 12"] it is first used, then fix it. [ARROW:"total" -> 1]') ev.push(...rs.feed(ch));
  ev.push(...rs.end());
  assert.deepEqual(ev.map((e) => e.type), ['speech', 'mark', 'speech', 'mark', 'mark']);
  assert.deepEqual(rs.spoken, ['The name was never made.', 'Look at line twelve where it is first used, then fix it.']);
  assert.deepEqual(ev.filter((e) => e.type === 'mark').map((e) => [e.shape, e.sentence]), [['underline', 0], ['circle', 1], ['arrow', 1]]);
  // Nothing of a tag is ever spoken, read or unread.
  assert.ok(!rs.spoken.join(' ').includes('['));
  const bad = parseReply('That is it. [CIRCLE:] [UNDERLINE:"half', { marks: true });
  assert.deepEqual(bad.spoken, ['That is it.']);
  assert.equal(bad.events.length, 0);
});

test('without marks asked for, the reply stream is exactly what it was', () => {
  const old = parseReply('Click Insert, top left. [POINT:12] [CONF:0.9]');
  assert.deepEqual(old.events, [{ type: 'point', target: { kind: 'element', id: 12 } }, { type: 'conf', value: 0.9 }]);
  const rs = new ReplyStream();
  assert.deepEqual(rs.feed('Paris is the capital. '), [{ type: 'speech', text: 'Paris is the capital.' }]);
});

test('words are found among the boxes Windows read, whatever it did with spaces and small misreads', () => {
  const hit = findWords('is not defined', OCR);
  assert.equal(hit.rects.length, 1);
  assert.deepEqual(hit.rects[0], { x: 334, y: 260, w: 136, h: 18 });
  // Punctuation and case do not matter; OCR joined or split words still match.
  assert.ok(findWords("NameError name 'total'", OCR));
  assert.ok(findWords('Name Error', OCR), 'split where OCR joined');
  // A misread letter in a long word.
  assert.ok(findWords('Tracebock most recent', OCR));
  // A short ask is whole words: "in" is not the middle of "window", "tot" is not "Total".
  assert.equal(findWords('tot', OCR), null);
  assert.deepEqual(findWords('in', OCR).rects[0].y, 230);
  assert.equal(findWords('nothing like this here', OCR), null);
  // The same word in several places: written as asked beats other capitals, then reading order, or the one nearest a hint.
  assert.equal(findWords('Total', OCR).count, 3, 'two Total and one total');
  assert.equal(findWords('Total', OCR).rects[0].x, 100);
  assert.equal(findWords('Total', OCR, { near: { x: 950, y: 650 } }).rects[0].x, 900);
  // Words that run over two lines: one rectangle per line.
  assert.equal(findWords('last): File "app.py"', OCR).rects.length, 2);
});

test('a mark lands on what Windows reports: a control by id, words by their boxes, a name by its control', () => {
  const ring = resolveMark(parseMarkTag('CIRCLE', '1'), ctx());
  assert.deepEqual([ring.shape, ring.rects, ring.verified, ring.source], ['circle', [ELEMENTS[0].rect], true, 'element']);
  const under = resolveMark(parseMarkTag('UNDERLINE', '"is not defined"'), ctx());
  assert.deepEqual([under.rects, under.verified, under.source], [[{ x: 334, y: 260, w: 136, h: 18 }], true, 'words']);
  // No OCR on this machine: the words still find the control that carries them, the closest name winning.
  const named = resolveMark(parseMarkTag('CIRCLE', '"Save"'), ctx({ ocr: null }));
  assert.deepEqual([named.rects[0], named.source], [ELEMENTS[2].rect, 'name']);
  // Words that are nowhere: nothing is drawn.
  assert.equal(resolveMark(parseMarkTag('UNDERLINE', '"completely absent words"'), ctx()), null);
  // A bare number that is no id is a number on the screen with its quotes forgotten.
  const twelve = resolveMark(parseMarkTag('CIRCLE', '12'), ctx());
  assert.deepEqual([twelve.source, twelve.rects[0].y], ['words', 230], 'the 12 in "line 12,"');
  // An id the model was never shown means nothing.
  assert.equal(resolveMark(parseMarkTag('CIRCLE', '1'), ctx({ ids: false })), null);
  assert.equal(resolveMark(parseMarkTag('CIRCLE', '99'), ctx()), null);
  // Never a password field, whatever was asked.
  assert.equal(resolveMark(parseMarkTag('CIRCLE', '4'), ctx()), null);
  assert.equal(resolveMark(parseMarkTag('BOX', '"Password"'), ctx({ ocr: null })), null);
});

test('a model box is moved onto the words or the control it names; an unconfirmed one is a guess, and never an underline', () => {
  // The box is a little off the error line it names: the line's own boxes win.
  const snapped = resolveMark(parseMarkTag('BOX', '0.05,0.23,0.25,0.03:NameError'), ctx());
  assert.deepEqual([snapped.source, snapped.verified, snapped.rects[0].y], ['box-words', true, 260]);
  // Pixels of the image the model saw, not fractions: converted, then snapped to the control under it.
  const px = resolveMark(parseMarkTag('CIRCLE', '1135,28,44,18'), ctx());
  assert.deepEqual([px.source, px.rects[0]], ['box-element', ELEMENTS[0].rect]);
  // A box round text with no label: the words inside it.
  const text = resolveMark(parseMarkTag('BOX', '0.04,0.17,0.3,0.1'), ctx());
  assert.deepEqual([text.source, text.verified, text.rects.length], ['box-text', true, 1]);
  // It holds the three lines of words, and reaches past them only toward the box that was asked for.
  const tr = text.rects[0];
  assert.ok(tr.y <= 200 && tr.y + tr.h >= 278 && tr.y >= 184 && tr.y + tr.h <= 292 && tr.x >= 77 && tr.x <= 100);
  // A picture: nothing Windows knows is there. A ring is drawn as a guess, an underline is not.
  const guess = resolveMark(parseMarkTag('CIRCLE', '0.6,0.7,0.1,0.1:the logo'), ctx());
  assert.deepEqual([guess.source, guess.verified], ['model', false]);
  assert.deepEqual(guess.rects[0], { x: 1152, y: 756, w: 192, h: 108 });
  assert.equal(resolveMark(parseMarkTag('UNDERLINE', '0.6,0.7,0.1,0.02:the logo'), ctx()), null);
  // Off the screen, or the whole screen: not a mark.
  assert.equal(resolveMark(parseMarkTag('CIRCLE', '1.2,0.5,0.1,0.1:x'), ctx()), null);
  assert.equal(resolveMark(parseMarkTag('CIRCLE', '0,0,1,1:everything'), ctx({ ocr: null, elements: [] })), null);
});

test('an arrow runs between two placed things, and says nothing from a thing to itself', () => {
  const a = resolveMark(parseMarkTag('ARROW', '"is not defined" -> 1'), ctx());
  assert.deepEqual([a.shape, a.from, a.to, a.verified], ['arrow', { x: 334, y: 260, w: 136, h: 18 }, ELEMENTS[0].rect, true]);
  assert.equal(resolveMark(parseMarkTag('ARROW', '1 -> 1'), ctx()), null);
  assert.equal(resolveMark(parseMarkTag('ARROW', '1 -> "nowhere to be found"'), ctx()), null);
  // It bows to the side with fewer words under its line. Two rows of words: an
  // arrow along the gap between them bends away from whichever row is in its way.
  const row = (y) => Array.from({ length: 12 }, (_, i) => `${200 + i * 60} ${y} 50 18 word${i}`).join('\n');
  const between = (blockY) => Object.assign({ width: 1920, height: 1080 }, parseOcrWords(['150 400 40 18 from', '960 400 40 18 to', row(blockY)].join('\n\n')));
  const over = resolveMark(parseMarkTag('ARROW', '"from" -> "to"'), ctx({ ocr: between(372), elements: [] }));
  const under = resolveMark(parseMarkTag('ARROW', '"from" -> "to"'), ctx({ ocr: between(428), elements: [] }));
  assert.ok(over.bow && under.bow && over.bow === -under.bow, 'the bow flips with the side the words are on');
  const midY = (m) => { const s = Marks.arrowPoints(m.from, m.to, 1, m.bow).shaft; return s[Math.floor(s.length / 2)].y; };
  assert.ok(midY(over) > 409 && midY(under) < 409, 'each bends away from its row of words');
  // Nothing in the way either side: no side is forced.
  assert.equal(resolveMark(parseMarkTag('ARROW', '"from" -> "to"'), ctx({ ocr: between(900), elements: [] })).bow, undefined);
  // The same place marked twice is one mark.
  const one = resolveMark(parseMarkTag('CIRCLE', '1'), ctx()), two = resolveMark(parseMarkTag('CIRCLE', '"Run"'), ctx({ ocr: null }));
  assert.ok(sameMark(one, two));
  assert.ok(!sameMark(one, resolveMark(parseMarkTag('BOX', '1'), ctx())));
});

test('the answer prompt teaches the marks and carries the control list only when drawing is on', () => {
  const off = buildScreenAnswer({ ask: 'explain this error', mode: 'explain', window: { title: 'Code', process: 'Code' } });
  assert.ok(!/UNDERLINE|CIRCLE/.test(off.system));
  assert.equal(off.draw, false);
  assert.equal(off.maxTokens, 400);
  const on = buildScreenAnswer({ ask: 'explain this error', mode: 'explain', window: { title: 'Code', process: 'Code' }, draw: true, elements: [{ id: 7, name: 'Run', type: 'Button', box: [0.88, 0.03, 0.04, 0.03] }] });
  for (const rule of DRAW_RULES) assert.ok(on.system.includes(rule));
  assert.match(on.text, /7 \| Button \| "Run" \| 0\.880,0\.030,0\.040,0\.030/);
  assert.ok(on.maxTokens > off.maxTokens && on.draw === true);
  // The words-only rules are all still there, in the same order.
  assert.ok(on.system.startsWith(off.system));
  // Reading a page out is listening: nothing is drawn for it.
  assert.equal(buildScreenAnswer({ ask: 'read this', mode: 'read', draw: true }).draw, false);
  // No em dashes in anything the model is told.
  assert.ok(!/—/.test(on.system + on.text));
});

// ---- the session, with everything faked -------------------------------------
function harness(reply, opts = {}) {
  const sent = [], logs = [], counted = [];
  const probe = {
    available: true,
    async request(op) { if (op === 'fg') return { hwnd: 7, title: 'app.py - Code', process: 'Code', pid: 5 }; if (op === 'uia.list') return { elements: ELEMENTS }; return {}; },
    async watch() { return { ok: true }; }, async unwatch() { return { ok: true }; }, status() { return { watching: null }; },
  };
  const prompts = [];
  const g = new GuideSession({
    capture: async () => CAP,
    probe,
    llm: () => ({ ready: true, provider: 'publik', async complete(req) { prompts.push(req); if (opts.stream && req.onDelta) { for (const piece of reply.match(/.{1,7}/gs)) req.onDelta(piece); } return reply; } }),
    send: (ch, p) => sent.push([ch, p]),
    screenToDip: (p) => ({ x: p.x / 2, y: p.y / 2 }),          // a 200% display: DIPs are half the pixels
    dipToScreen: (p) => ({ x: p.x * 2, y: p.y * 2 }),
    winBounds: () => ({ x: 0, y: 0, width: 960, height: 520 }),
    hashCapture: () => null,
    drawOn: () => opts.draw !== false,
    readWords: opts.readWords || (async () => OCR),
    onMarks: (rec) => counted.push(rec),
    ...(opts.brightness ? { brightness: opts.brightness } : {}),
    selfPid: 999, log: (m) => logs.push(m), sleep: async () => {}, now: () => 1000,
  });
  return { g, sent, logs, counted, prompts };
}
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
const REPLY = 'The name total was never made. [UNDERLINE:"is not defined"] Run it again once you add it. [CIRCLE:1] [UNDERLINE:"words that are not there"]';

test('a spoken answer sends each mark with its sentence number, placed in the overlay\'s own coordinates', async () => {
  const { g, sent, counted, prompts } = harness(REPLY, { stream: true });
  await g.start('explain this error', 'voice', { answer: 'explain' });
  await flush();
  assert.match(prompts[0].system, /UNDERLINE/);
  assert.match(prompts[0].turns[0].text, /1 \| Button \| "Run"/);
  const says = sent.filter(([c]) => c === 'guide:say').map(([, p]) => [p.text, p.sid, p.first]);
  assert.deepEqual(says, [['The name total was never made.', 0, true], ['Run it again once you add it.', 1, false]]);
  const marks = sent.filter(([c]) => c === 'guide:marks').map(([, p]) => p);
  assert.equal(marks.length, 2, 'the third could not be placed, so it is not drawn');
  assert.deepEqual([marks[0].sid, marks[0].marks[0]], [0, { shape: 'underline', rects: [{ x: 167, y: 130, w: 68, h: 9 }], verified: true }]);
  assert.deepEqual([marks[1].sid, marks[1].marks[0]], [1, { shape: 'circle', rects: [{ x: 850, y: 20, w: 35, h: 15 }], verified: true }]);
  // Every mark follows the sentence it belongs to.
  const order = sent.map(([c, p]) => (c === 'guide:say' ? 'say' + p.sid : c === 'guide:marks' ? 'mark' + p.sid : null)).filter(Boolean);
  assert.ok(order.indexOf('say0') < order.indexOf('mark0') && order.indexOf('say1') < order.indexOf('mark1'));
  // The bubble has the words and none of the tags.
  const bubble = sent.filter(([c]) => c === 'guide:bubble').pop()[1];
  assert.equal(bubble.text, 'The name total was never made. Run it again once you add it.');
  assert.deepEqual([counted[0].asked, counted[0].drawn, counted[0].dropped, counted[0].sources], [3, 2, 1, ['words', 'element']]);
});

test('a typed answer draws its marks as they come, with no sentence to wait for', async () => {
  const { g, sent } = harness(REPLY);
  await g.start('explain this error', 'typed', { answer: 'explain' });
  await flush();
  assert.equal(sent.filter(([c]) => c === 'guide:say').length, 0);
  assert.deepEqual(sent.filter(([c]) => c === 'guide:marks').map(([, p]) => p.sid), [null, null]);
});

test('with drawing off, or no way to read the words, an answer is still an answer', async () => {
  const off = harness(REPLY, { draw: false });
  await off.g.start('explain this error', 'typed', { answer: 'explain' });
  await flush();
  assert.ok(!/UNDERLINE/.test(off.prompts[0].system));
  assert.equal(off.sent.filter(([c]) => c === 'guide:marks').length, 0);
  // The tags are plain bracketed text then, as before this feature.
  const blind = harness(REPLY, { readWords: async () => { throw new Error('no OCR language installed'); } });
  await blind.g.start('explain this error', 'typed', { answer: 'explain' });
  await flush();
  const drawn = blind.sent.filter(([c]) => c === 'guide:marks').map(([, p]) => p.marks[0].shape);
  assert.deepEqual(drawn, ['circle'], 'the control list alone still places the ring');
  assert.equal(blind.sent.filter(([c]) => c === 'guide:bubble').pop()[1].text, 'The name total was never made. Run it again once you add it.');
});

test('a mark on a bright page is sent as light, so the overlay draws a dark line there', async () => {
  // Bright where the error line is, dark where the Run button is; unknown counts as dark.
  const h = harness(REPLY, { brightness: (cap, r) => (r.y > 200 ? 0.93 : 0.08) });
  await h.g.start('explain this error', 'typed', { answer: 'explain' });
  await flush();
  const marks = h.sent.filter(([c]) => c === 'guide:marks').map(([, p]) => p.marks[0]);
  assert.deepEqual(marks.map((m) => [m.shape, m.light === true]), [['underline', true], ['circle', false]]);
  const dark = harness(REPLY, { brightness: () => null });
  await dark.g.start('explain this error', 'typed', { answer: 'explain' });
  await flush();
  assert.ok(dark.sent.filter(([c]) => c === 'guide:marks').every(([, p]) => !p.marks[0].light));
  // The overlay turns the thread over for it.
  assert.ok(read('renderer/styles.css').includes('.mark-on-light .mark-core { stroke: rgb(13,15,25); }'));
  assert.ok(read('renderer/marks.js').includes("mark.light ? ' mark-on-light' : ''"));
});

test('no more than the cap is drawn, and a dismissed answer draws nothing more', async () => {
  const many = 'Here they are. ' + Array.from({ length: 9 }, (_, i) => `[CIRCLE:${(i % 3) + 1}]`).join(' ');
  const h = harness(many);
  await h.g.start('what are these', 'typed', { answer: 'ask' });
  await flush();
  assert.ok(h.sent.filter(([c]) => c === 'guide:marks').length <= MAX_MARKS);
  assert.equal(h.sent.filter(([c]) => c === 'guide:marks').length, 3, 'the same place twice is one mark');
  h.g.dismiss('esc');
  assert.equal(h.sent.filter(([c]) => c === 'guide:done').length, 1);
});

test('marks come off when the screen under them moves', async () => {
  const frames = [new Uint8Array(64 * 40).fill(100), new Uint8Array(64 * 40).fill(100), new Uint8Array(64 * 40).fill(160)];
  const h = harness('It is here. [CIRCLE:1]');
  h.g.d.watcher = { grab: async () => frames.shift() || new Uint8Array(64 * 40).fill(160) };
  await h.g.start('what is this', 'typed', { answer: 'ask' });
  await flush(); await flush();
  const clear = h.sent.filter(([c]) => c === 'guide:marks:clear');
  assert.equal(clear.length, 1);
  assert.equal(clear[0][1].why, 'moved');
  assert.ok(h.logs.some((m) => /the screen moved/.test(m)));
});

// ---- the overlay's strokes -----------------------------------------------------
const nums = (d) => d.match(/-?\d+(?:\.\d+)?/g).map(Number);
const bounds = (d) => { const n = nums(d); const xs = n.filter((_, i) => i % 2 === 0), ys = n.filter((_, i) => i % 2 === 1); return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) }; };

test('an underline sits just under its words, one stroke per line', () => {
  const s = Marks.strokesFor({ shape: 'underline', rects: [{ x: 100, y: 50, w: 200, h: 18 }, { x: 100, y: 80, w: 90, h: 18 }] }, 5);
  assert.equal(s.length, 2);
  const b = bounds(s[0].d);
  assert.ok(b.x0 >= 96 && b.x0 <= 100 && b.x1 >= 300 && b.x1 <= 304);
  assert.ok(b.y0 >= 67 && b.y1 <= 76, 'under the text, not through it');
  assert.ok(s[1].delay > s[0].delay, 'the second line is drawn after the first');
});

test('a ring and a frame go round their rect with room to spare, wider when it is a guess', () => {
  const rect = { x: 400, y: 300, w: 120, h: 40 };
  for (const shape of ['circle', 'box']) {
    const sure = bounds(Marks.strokesFor({ shape, rects: [rect], verified: true }, 3)[0].d);
    const guess = bounds(Marks.strokesFor({ shape, rects: [rect], verified: false }, 3)[0].d);
    assert.ok(sure.x0 < rect.x && sure.x1 > rect.x + rect.w && sure.y0 < rect.y && sure.y1 > rect.y + rect.h, shape + ' clears the rect');
    assert.ok(guess.x1 - guess.x0 > sure.x1 - sure.x0, shape + ' is wider as a guess');
    assert.ok(sure.x1 - sure.x0 < rect.w + 90 && sure.y1 - sure.y0 < rect.h + 90, shape + ' stays close');
  }
  // The same mark draws the same way every time; the next mark wobbles its own way.
  assert.equal(Marks.strokesFor({ shape: 'circle', rects: [rect] }, 3)[0].d, Marks.strokesFor({ shape: 'circle', rects: [rect] }, 3)[0].d);
  assert.notEqual(Marks.strokesFor({ shape: 'circle', rects: [rect] }, 3)[0].d, Marks.strokesFor({ shape: 'circle', rects: [rect] }, 4)[0].d);
});

test('an arrow leaves the first thing, reaches the second, and ends in a head', () => {
  const from = { x: 100, y: 100, w: 80, h: 20 }, to = { x: 600, y: 400, w: 100, h: 30 };
  const s = Marks.strokesFor({ shape: 'arrow', from, to }, 9);
  assert.equal(s.length, 3, 'a shaft and two head strokes');
  const shaft = nums(s[0].d);
  const start = { x: shaft[0], y: shaft[1] }, end = { x: shaft[shaft.length - 2], y: shaft[shaft.length - 1] };
  const outside = (p, r) => p.x < r.x || p.x > r.x + r.w || p.y < r.y || p.y > r.y + r.h;
  assert.ok(outside(start, from) && outside(end, to), 'neither end is drawn over the thing it joins');
  assert.ok(Math.hypot(end.x - 650, end.y - 415) < Math.hypot(start.x - 650, start.y - 415), 'it runs toward the second thing');
  assert.ok(s[1].delay >= s[0].ms - 60, 'the head comes after the shaft');
  // Two things that touch have no room for an arrow.
  assert.deepEqual(Marks.strokesFor({ shape: 'arrow', from, to: { x: 150, y: 105, w: 80, h: 20 } }, 9), []);
  // Nothing sensible in, nothing out.
  assert.deepEqual(Marks.strokesFor({ shape: 'circle', rects: [{ x: 0, y: 0, w: 0, h: 10 }] }, 1), []);
  assert.deepEqual(Marks.strokesFor(null, 1), []);
});

test('the overlay is wired for marks: the channels, the script, the layer that never takes the mouse, the switch', () => {
  const preload = read('preload.js');
  assert.match(preload, /'guide:marks', 'guide:marks:clear'/);
  const html = read('renderer/index.html');
  assert.ok(html.indexOf('marks.js') > 0 && html.indexOf('marks.js') < html.indexOf('renderer.js?'), 'marks.js loads before the renderer');
  const css = read('renderer/styles.css');
  assert.match(css, /#marks-layer \{[^}]*pointer-events: none/);
  assert.match(css, /prefers-reduced-motion: reduce\) \{ #marks-layer path \{ animation: none/);
  const renderer = read('renderer/renderer.js');
  assert.match(renderer, /nus\.on\('guide:marks', /);
  assert.match(renderer, /function onGuideDone\(p\) \{\n\s+clearMarks\(false\);/);
  assert.match(renderer, /if \(pttHeld\) clearMarks\(true\);\n\s+if \(pttHeld\) \{ stopSpeaking\(\); startMic\(\); \}/, 'the talk key clears the screen for the next read');
  assert.match(renderer, /function playPcm\(audio, gen, sid\) \{\n\s+sentenceStarted\(sid\);/, 'a mark is drawn as its sentence starts');
  // The switch: on by default, in Settings, and in the dashboard's whitelist.
  assert.match(read('src/store.js'), /drawOnScreen: true,/);
  assert.match(read('home/index.html'), /id="draw-on-screen"/);
  assert.match(read('home/home.js'), /'draw-on-screen':\['drawOnScreen',e=>e\.checked\]/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main-companion.js'), 'utf8'), /if \(typeof patch\.drawOnScreen === 'boolean'\) clean\.drawOnScreen = patch\.drawOnScreen;/);
  const main = read('index.js');
  assert.match(main, /drawOn: \(\) => process\.platform === 'win32' && process\.env\.NUS_DRAW !== '0' && store\.getSettings\(\)\.drawOnScreen !== false,/);
  // The scripted brain for a live check exists only in a dev run.
  assert.match(main, /function drawFakeBrain\(\) \{\n\s+if \(app\.isPackaged \|\| !process\.env\.NUS_DRAW_FAKE_REPLY\) return null;/);
  // The probe and the script both hand back where each word is.
  assert.match(read('src/win/probe.ps1'), /Read-Words \(\[string\]\$req\.path\) \(\[bool\]\$req\.words\)/);
  assert.match(read('src/win/ocr.ps1'), /\[switch\]\$Words/);
});
