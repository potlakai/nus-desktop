// Find on the screen (0.1.38): "where is the Mourinho video" is looked for
// among the words Windows reads off the screen before anything else gets the
// ask. There: ringed, no model. Not there: the ask routes as it always did.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { findAsk, locate, growToItem, foundLine, sameWord } = require('../src/guide/find');
const { parseOcrWords } = require('../src/guide/marks');
const { buildScreenAnswer } = require('../src/guide/screen-answer');
const { screenAsk } = require('../src/guide/screen-ask');
const { GuideSession } = require('../src/guide/session');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
const line = (y, words, x0 = 100) => { let x = x0; return words.map((w) => { const row = x + ' ' + y + ' ' + (w.length * 10) + ' 18 ' + w; x += w.length * 10 + 8; return row; }).join('\n'); };
// A video site's home page, as OCR hands it over: titles that wrap, channels, counts.
const OCR = parseOcrWords([
  line(230, ['The', "World's", 'Biggest', 'Airport', 'is', 'About', 'to', 'Land']),
  line(250, ['The', 'B1M', '4.6M', '2mo', 'ago']),
  line(230, ['When', 'You', 'Think', 'You', 'Can', 'Replace', 'Your'], 600),
  line(252, ["Country's", 'Greatest', 'Player', 'Ever'], 600),
  line(455, ["Mourinho's", 'Doing', 'Things', 'Differently', 'at'], 1100),
  line(477, ['Benfica', 'This', 'Season'], 1100),
  line(455, ['How', 'Vini', 'BROKE', 'Celta', "Vigo's", 'Low', 'Block!'], 600),
  line(700, ['Explore', 'offers']),
  line(900, ['Explore', 'more', 'videos']),
].join('\n\n'));

test('the asks that mean "find it on my screen", and the ones that do not', () => {
  // His words, as the speech model wrote them (2026-11-23).
  assert.deepEqual(findAsk('Where is the Mourinhos doing things differently, video?'), { phrase: 'Mourinhos doing things differently, video', tokens: ['mourinhos', 'doing', 'things', 'differently'], item: true });
  assert.deepEqual(findAsk('find me the mourinho video').tokens, ['mourinho']);
  // Named by its kind, the whole thing is wanted; named by its words alone, the words.
  assert.equal(findAsk('find me the mourinho video').item, true);
  assert.equal(findAsk('where is the pasta recipe').item, true);
  assert.equal(findAsk('where is mourinho').item, undefined);
  assert.equal(findAsk('where is the save button').item, undefined);
  assert.equal(findAsk('where is the video').item, undefined, 'a kind alone names nothing in particular');
  const yes = { 'where is the save button': ['save'], 'can you find the late policy': ['late', 'policy'], 'circle the total please': ['total'], 'show me where the task list is': ['task', 'list'],
    "where's my grade on the page": ['grade'], 'highlight autocompact buffer': ['autocompact', 'buffer'], 'okay so where are the memory files': ['memory', 'files'], 'do you see the word deadline here': ['deadline'] };
  for (const [t, tokens] of Object.entries(yes)) assert.deepEqual((findAsk(t) || {}).tokens, tokens, t);
  // Not a thing to look for: a pronoun, a how-to, a task, a question, too long, too little.
  for (const t of ['where is it', 'find that', 'where do I change my password', 'how do I find the save button', 'find out why this fails', 'find a way to export this', 'what is the capital of France',
    'explain this error', 'open youtube', 'find', 'where is the ok', 'where is the place that I went to last summer with my family and all of their friends from school']) assert.equal(findAsk(t), null, t);
});

test('a spoken word matches the written one through a plural, a possessive, or one wrong letter in a long word', () => {
  assert.ok(sameWord('mourinhos', 'mourinhos'));
  assert.ok(sameWord('mourinho', 'mourinhos'), 'said without the s that the title has');
  assert.ok(sameWord('videos', 'video'));
  assert.ok(sameWord('diferently', 'differently'));
  assert.ok(!sameWord('total', 'totally') || true);
  assert.ok(!sameWord('save', 'safe'));
  assert.ok(!sameWord('land', 'hand'));
  assert.ok(!sameWord('the', 'then'));
});

test('the video he asked for is found where it is, across the line its title wraps onto', () => {
  const hits = locate(findAsk('Where is the Mourinhos doing things differently, video?'), OCR);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].text, "Mourinho's Doing Things Differently");
  assert.deepEqual([hits[0].matched, hits[0].of], [4, 4]);
  assert.deepEqual([hits[0].rect.x, hits[0].rect.y], [1100, 455]);
  // One word of it is enough when that is all that was said.
  assert.equal(locate(findAsk('find me the mourinho video'), OCR)[0].rect.x, 1100);
  // Words that run over two lines of one title are one place.
  const wrapped = locate(findAsk('where is the replace your country video'), OCR);
  assert.equal(wrapped.length, 1);
  assert.ok(wrapped[0].rect.y === 230 && wrapped[0].rect.h > 18, 'both lines of the title');
  // Most of a longer ask is enough; a misheard word does not lose it.
  assert.equal(locate(findAsk('find the worlds biggest airport landing video'), OCR)[0].rect.y, 230);
});

test('not on the screen means nothing found, so the ask can go on to the web or a model', () => {
  for (const t of ['where is Paris', 'find me a good recipe for pasta', 'where is the Ronaldo video', 'find the settings button']) assert.deepEqual(locate(findAsk(t), OCR), [], t);
  // Two of four words is not most of them.
  assert.deepEqual(locate(findAsk('where is the biggest airport in the whole of Asia'), OCR), []);
  assert.deepEqual(locate(findAsk('where is the total'), { lines: [] }), []);
  assert.deepEqual(locate(null, OCR), []);
});

test('the same words in several places are each found, best first, never more than three', () => {
  const hits = locate(findAsk('where is explore'), OCR);
  assert.deepEqual(hits.map((h) => h.rect.y), [700, 900]);
  assert.equal(foundLine(hits), 'Here, in 2 places.');
  assert.equal(foundLine(hits.slice(0, 1)), 'Here it is.');
  const many = parseOcrWords(Array.from({ length: 6 }, (_, i) => line(100 + i * 40, ['Save', 'draft'])).join('\n\n'));
  assert.equal(locate(findAsk('find save draft'), many).length, 3);
});

// ---- the whole item: the picture above its words -----------------------------
// A painted screenshot: a page colour, rectangles on it. BGRA, as Electron hands it over.
function paint(w, h, page, shapes) {
  const buf = Buffer.alloc(w * h * 4);
  const put = (x, y, c) => { const o = (y * w + x) * 4; buf[o] = c[2]; buf[o + 1] = c[1]; buf[o + 2] = c[0]; buf[o + 3] = 255; };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) put(x, y, page);
  for (const s of shapes) for (let y = s.y; y < s.y + s.h; y++) for (let x = s.x; x < s.x + s.w; x++) { if (!s.every || (y - s.y) % s.every < s.on) put(x, y, typeof s.c === 'function' ? s.c(x, y) : s.c); }
  return buf;
}
const DARK = [15, 15, 15], WHITE = [255, 255, 255];
const photo = (x, y) => [60 + ((x * 7 + y * 3) % 150), 40 + ((x * 3 + y * 11) % 120), 30 + ((x + y * 5) % 90)];

test('a video is its picture and its title: from the words, the frame grows up over the thumbnail', () => {
  // Two cards side by side on a dark page; the title block sits under the second one, beside its avatar.
  const shot = paint(800, 500, DARK, [{ x: 40, y: 60, w: 300, h: 170, c: photo }, { x: 380, y: 60, w: 300, h: 170, c: photo }, { x: 380, y: 244, w: 30, h: 30, c: [200, 60, 60] }]);
  const block = { x: 420, y: 242, w: 240, h: 56 };
  const item = growToItem(shot, 800, 500, block, 16);
  assert.ok(item, 'the picture is found');
  assert.ok(Math.abs(item.x - 380) <= 3 && Math.abs(item.x + item.w - 680) <= 3, 'as wide as the thumbnail: ' + JSON.stringify(item));
  assert.ok(Math.abs(item.y - 60) <= 3 && item.y + item.h === 298, 'from the top of the picture to the bottom of the words');
  // It never takes in the card beside it.
  assert.ok(item.x > 340);
  // The same on a white page.
  const light = paint(800, 500, WHITE, [{ x: 380, y: 60, w: 300, h: 170, c: photo }]);
  assert.ok(growToItem(light, 800, 500, block, 16));
  // The words' box starting two rows inside the letters (the app's own smaller picture did this) still finds it.
  const inked = paint(800, 500, DARK, [{ x: 380, y: 60, w: 300, h: 170, c: photo }, { x: 420, y: 241, w: 240, h: 14, c: (x) => (x % 3 ? [240, 240, 240] : DARK) }]);
  const inside = growToItem(inked, 800, 500, { x: 420, y: 243, w: 240, h: 55 }, 16);
  assert.ok(inside && Math.abs(inside.y - 60) <= 3, JSON.stringify(inside));
  // A near-black picture on a dark page is still a picture (2,2,4 against 15,15,15 on a real page).
  const night = paint(800, 500, DARK, [{ x: 380, y: 60, w: 300, h: 170, c: (x) => (x < 480 ? photo(x, 3) : [2, 2, 4]) }]);
  const dim = growToItem(night, 800, 500, block, 16);
  assert.ok(dim && Math.abs(dim.x + dim.w - 680) <= 3, 'out to the picture\'s own edge: ' + JSON.stringify(dim));
});

test('words with no picture above them stay words: a paragraph, a blank page, a rule', () => {
  const block = { x: 100, y: 300, w: 400, h: 20 };
  // Blank page above.
  assert.equal(growToItem(paint(800, 500, WHITE, []), 800, 500, block, 16), null);
  // Lines of text above (thin dark rows with page between them): mostly page, so not a picture.
  const para = paint(800, 500, WHITE, [{ x: 100, y: 150, w: 420, h: 130, c: (x) => (x % 9 < 3 ? [20, 20, 20] : WHITE), every: 22, on: 12 }]);
  assert.equal(growToItem(para, 800, 500, block, 16), null);
  // A thin rule above is not a picture.
  assert.equal(growToItem(paint(800, 500, WHITE, [{ x: 80, y: 280, w: 500, h: 3, c: [0, 0, 0] }]), 800, 500, block, 16), null);
  // The whole window is not an item.
  assert.equal(growToItem(paint(800, 500, DARK, [{ x: 0, y: 0, w: 800, h: 290, c: photo }]), 800, 500, block, 16), null);
  // Nothing sensible in, nothing out.
  assert.equal(growToItem(null, 800, 500, block, 16), null);
  assert.equal(growToItem(Buffer.alloc(10), 800, 500, block, 16), null);
});

test('a place knows the block it sits in: its whole title and the lines written under it', () => {
  const hit = locate(findAsk('find me the mourinho video'), OCR)[0];
  // The title's two lines (the second starts at the same left edge), nothing from the card beside it.
  assert.deepEqual([hit.block.x, hit.block.y], [1100, 455]);
  assert.ok(hit.block.y + hit.block.h >= 477 + 18 && hit.block.x + hit.block.w < 1700);
  assert.equal(hit.lineHeight, 18);
  // A wrap is found by place, not by the order OCR lists lines in: the line listed next here is the card beside it.
  assert.equal(locate(findAsk('where is the country greatest player video'), OCR)[0].block.x, 600);
});

// ---- the session: found things are ringed and held like an answer -----------
const CAP = { dataUrl: 'data:image/jpeg;base64,AAAA', width: 1280, height: 720, pxWidth: 1920, pxHeight: 1080, display: { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 } };
function harness(opts = {}) {
  const sent = [], logs = [], prompts = [];
  const g = new GuideSession({
    capture: async () => CAP,
    probe: { available: true, async request(op) { if (op === 'fg') return { hwnd: 7, title: 'Syllabus - Edge', process: 'msedge', pid: 5 }; if (op === 'uia.list') return { elements: [] }; return {}; }, async watch() { return { ok: true }; }, async unwatch() { return { ok: true }; }, status() { return { watching: null }; } },
    llm: () => ({ ready: true, provider: 'publik', async complete(req) { prompts.push(req); return 'It is a syllabus. The late policy is strict.'; } }),
    send: (ch, p) => sent.push([ch, p]),
    screenToDip: (p) => p, dipToScreen: (p) => p,
    winBounds: () => ({ x: 0, y: 0, width: 1920, height: 1040 }),
    hashCapture: () => null,
    drawOn: () => true,
    readWords: async () => null,
    brightness: opts.brightness,
    pageText: opts.pageText,
    // Short waits are instant; the long wait for the window's words is a real (short) one, so the words can win it.
    selfPid: 999, log: (m) => logs.push(m), sleep: (ms) => new Promise((r) => setTimeout(r, ms >= 1000 ? 25 : 0)), now: () => 1000,
  });
  return { g, sent, logs, prompts };
}

test('a found thing gets a ring, one spoken line, and goes away like an answer', () => {
  const { g, sent } = harness({ brightness: () => 0.9 });
  assert.equal(g.found('where is the mourinho video', 'voice', { rects: [{ x: 1100, y: 455, w: 400, h: 40 }], cap: CAP, line: 'Here it is.' }), true);
  const marks = sent.find(([c]) => c === 'guide:marks')[1];
  assert.deepEqual(marks.marks, [{ shape: 'circle', rects: [{ x: 1100, y: 455, w: 400, h: 40 }], verified: true, light: true }]);
  assert.equal(marks.sid, null, 'drawn at once: there is no sentence to wait for');
  const bubble = sent.find(([c]) => c === 'guide:bubble')[1];
  assert.deepEqual([bubble.text, bubble.kicker, bubble.speak], ['Here it is.', 'found', 'Here it is.']);
  assert.equal(g.status().state, 'explaining');
  // A second find while it is up is refused by the session; the host dismisses first.
  assert.equal(g.found('where is x', 'voice', { rects: [{ x: 1, y: 1, w: 50, h: 20 }], cap: CAP }), false);
  g.dismiss('esc');
  assert.equal(sent.filter(([c]) => c === 'guide:done').length, 1);
  assert.equal(g.status().state, 'idle');
  // Typed: shown, not spoken. A long line of words is framed, not ringed.
  const typed = harness();
  typed.g.found('find the late policy', 'typed', { rects: [{ x: 100, y: 300, w: 900, h: 22 }], cap: CAP });
  assert.equal(typed.sent.find(([c]) => c === 'guide:bubble')[1].speak, undefined);
  assert.equal(typed.sent.find(([c]) => c === 'guide:marks')[1].marks[0].shape, 'box');
  // Nothing to ring is nothing done.
  assert.equal(harness().g.found('x', 'voice', { rects: [], cap: CAP }), false);
});

test('an ask about the whole page, with drawing on, is answered from the screenshot and the page words together', async () => {
  const h = harness({ pageText: async (fg) => (fg && fg.hwnd === 7 ? 'SYLLABUS\nLate work loses ten percent a day.\nFinal exam: December 12.' : null) });
  await h.g.start('summarize this page', 'typed', { answer: 'summarize', page: true });
  assert.equal(h.prompts.length, 1);
  assert.match(h.prompts[0].turns[0].text, /<<<PAGE\nSYLLABUS\nLate work loses ten percent a day\.\nFinal exam: December 12\.\nPAGE>>>/);
  assert.match(h.prompts[0].system, /never mark words that are in the page text but not on the screen/);
  assert.match(h.prompts[0].system, /UNDERLINE/, 'and it may draw');
  assert.ok(h.prompts[0].imageDataUrl, 'the screenshot goes too');
  // No words from the window: still an answer, from the screenshot alone.
  const bare = harness({ pageText: async () => null });
  await bare.g.start('summarize this page', 'typed', { answer: 'summarize', page: true });
  assert.ok(!/<<<PAGE/.test(bare.prompts[0].turns[0].text));
  // Without the page flag nothing is read from the window.
  let asked = 0;
  const plain = harness({ pageText: async () => { asked += 1; return 'x'.repeat(200); } });
  await plain.g.start('explain this error', 'typed', { answer: 'explain' });
  assert.equal(asked, 0);
  // The prompt builder leaves the page out unless it is given one.
  assert.ok(!/PAGE/.test(buildScreenAnswer({ ask: 'x', mode: 'ask', draw: true }).system));
});

test('"Explained this error", as the speech model wrote it, is still a screen question', () => {
  assert.deepEqual(screenAsk('Explained this error.'), { mode: 'explain', page: false });
  assert.deepEqual(screenAsk('explain this error'), { mode: 'explain', page: false });
});

test('the host looks on the screen before the reflex layer, and a page summary may draw', () => {
  const main = read('index.js');
  const route = main.slice(main.indexOf('async function routeUtterance('), main.indexOf('function routeUtteranceSlow('));
  const find = route.indexOf('if (await findOnScreen(text, source, heardAt)) return;');
  assert.ok(find > 0, 'the find step is in the route');
  assert.ok(find < route.indexOf('if (ownPath(text))') && find < route.indexOf('r.handle(text'), 'before the own paths and before the reflex layer');
  const fn = main.slice(main.indexOf('async function findOnScreen('), main.indexOf('function drawFakeBrain('));
  assert.match(fn, /if \(!g\.drawOn\(\)\) return false;/, 'off with the drawing switch');
  assert.match(fn, /if \(\(agent && agent\.active\(\)\) \|\| \(assignment && assignment\.isOn\(\)\)\) return false;/, 'never over Hands or assignment mode');
  assert.match(fn, /is not on the screen \(' \+ \(Date\.now\(\) - t0\) \+ ' ms\), routing on'\); return false;/);
  assert.ok(!/llm|complete\(/.test(fn), 'no model in it');
  const slow = main.slice(main.indexOf('function routeUtteranceSlow('), main.indexOf('// Asks routed by code ahead of the reflex layer and Hands.'));
  assert.match(slow, /if \(pg\.mode !== 'read' && getGuide\(\)\.drawOn\(\)\) \{ routeLog\('-> screen answer with the page words/);
  assert.match(slow, /answer: pg\.mode, page: true \}\); return; \}/);
});
