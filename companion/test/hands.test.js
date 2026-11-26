'use strict';
// Hands with every dependency faked: the consent rules, the reply parser, the
// actions against a fake sidecar, and the agent loop end to end.
const test = require('node:test');
const assert = require('node:assert/strict');
const consent = require('../src/hands/consent');
const { parseTags, AgentStream } = require('../src/hands/reply');
const { createActions, parseKeys, findElement } = require('../src/hands/actions');
const { HandsAgent } = require('../src/hands/agent');

test('consent: risky labels, keys and message typing ask first; safe ones do not; money is firm', () => {
  assert.ok(consent.riskyLabel('Submit Assignment'));
  assert.ok(consent.riskyLabel('Buy now'));
  assert.ok(consent.riskyLabel('Delete'));
  assert.ok(!consent.riskyLabel('Apply filters'));
  assert.ok(!consent.riskyLabel('Search'));
  assert.ok(!consent.riskyLabel('Insert'));
  assert.equal(consent.preview({ name: 'click', args: { id: 1 } }, { targetName: 'Insert' }), null);
  const submit = consent.preview({ name: 'click', args: { id: 2 } }, { targetName: 'Submit Assignment' });
  assert.match(submit.title, /Submit Assignment/); assert.equal(submit.firm, false);
  const buy = consent.preview({ name: 'click', args: { text: 'Place order' } }, {});
  assert.equal(buy.firm, true, 'money needs the button, not a spoken yes');
  assert.ok(consent.preview({ name: 'press', args: { keys: 'alt+f4' } }, {}));
  assert.equal(consent.preview({ name: 'press', args: { keys: 'ctrl+s' } }, {}), null);
  assert.ok(consent.preview({ name: 'type', args: { text: 'hi', submit: true } }, { fieldName: 'Message', windowTitle: 'Discord' }));
  assert.equal(consent.preview({ name: 'type', args: { text: 'lab 3', submit: true } }, { fieldName: 'Search', windowTitle: 'Canvas' }), null);
  assert.ok(consent.preview({ name: 'drag', args: {} }, { toName: 'Recycle Bin' }));
  assert.ok(consent.preview({ name: 'open_app', args: { name: 'setup.exe' } }, {}).firm);
});

test('the pending card: a spoken yes answers once, no cancels, other words cancel, firm cards need the button', async () => {
  const p = consent.createPending();
  const a = p.ask({ title: 'Submit?', firm: false }, { name: 'click' }, {});
  assert.equal(p.spoken('yeah go ahead'), 'yes');
  assert.deepEqual(await a, { answered: true, yes: true, how: 'voice' });
  const b = p.ask({ title: 'Delete?', firm: false }, {}, {});
  assert.equal(p.spoken('open notepad instead'), 'cancelled');
  assert.equal((await b).yes, false);
  const c = p.ask({ title: 'Buy?', firm: true }, {}, {});
  assert.equal(p.spoken('yes'), 'needs-button');
  assert.equal(p.answer(true), true);
  assert.equal((await c).yes, true);
  assert.equal(p.answer(true), false, 'nothing pending');
});

test('the reply parser takes goal, several actions with JSON, done, and drops what is broken', () => {
  const t = parseTags('[GOAL: open lab 3 on canvas] Heading there. [DO:open_url {"url": "https://canvas.test"}] [DO:click {"text": "Lab 3 [draft]", "near": "Week 4"}] [DO:nope {bad json] [DONE]');
  assert.equal(t.goal, 'open lab 3 on canvas');
  assert.equal(t.done, true);
  assert.deepEqual(t.actions.map((a) => a.name), ['open_url', 'click']);
  assert.equal(t.actions[1].args.text, 'Lab 3 [draft]');
  const leak = parseTags('Click File. <function_calls><invoke name="Read"> [DO:click {"id": 1}]');
  assert.equal(leak.muted, true); assert.equal(leak.actions.length, 0);
  const s = new AgentStream();
  const said = [];
  for (const piece of ['Opening Notepad for you. Then I', ' will type it. [DO:open_app {"name": "Notepad"}]']) said.push(...s.feed(piece));
  said.push(...s.end());
  assert.deepEqual(said, ['Opening Notepad for you.', 'Then I will type it.']);
  assert.equal(s.tags().actions[0].name, 'open_app');
  assert.equal(parseKeys('ctrl+s').length, 2); assert.equal(parseKeys('win'), null); assert.equal(parseKeys('ctrl+shift+enter').length, 3);
});

const ELEMENTS = [
  { id: 1, name: 'Insert', type: 'TabItem', rect: { x: 100, y: 40, w: 60, h: 24 } },
  { id: 2, name: 'Submit Assignment', type: 'Button', rect: { x: 500, y: 600, w: 160, h: 40 } },
  { id: 3, name: 'Password', type: 'Edit', rect: { x: 100, y: 240, w: 200, h: 24 }, isPassword: true },
  { id: 4, name: 'Add to cart', type: 'Button', rect: { x: 700, y: 100, w: 90, h: 30 } },
  { id: 5, name: 'Add to cart', type: 'Button', rect: { x: 700, y: 300, w: 90, h: 30 } },
  { id: 6, name: 'Soundcore Q30', type: 'Text', rect: { x: 100, y: 300, w: 300, h: 30 } },
  { id: 7, name: 'Comment', type: 'Edit', rect: { x: 100, y: 500, w: 400, h: 60 } },
];
const CAP = { dataUrl: 'data:image/jpeg;base64,AAAA', width: 1280, height: 720, pxWidth: 1920, pxHeight: 1080, display: { bounds: { x: 0, y: 0, width: 1920, height: 1080 } } };
function fakeHands() {
  const calls = [];
  return { calls, async request(op, params) { calls.push({ op, params }); if (op === 'mouse.click' && params.x === 200 && params.y === 252) return { ok: false, refused: 'password' }; if (op === 'win.activate') return { ok: false, found: false }; return { ok: true }; } };
}
function rig() {
  const hands = fakeHands();
  const pointed = [], opened = [], launched = [], browsed = [];
  // The front window the fake probe reports: Notepad once it has been launched.
  const front = { fg: null };
  const actions = createActions({
    probe: { async request(op) { if (op === 'uia.frompoint') return { element: { name: 'Canvas', type: 'Document', rect: { x: 0, y: 0, w: 1920, h: 1080 } } }; if (op === 'fg') return front.fg || {}; return {}; } },
    hands, shell: { async openExternal(u) { opened.push(u); front.fg = { hwnd: 77, title: 'Mozilla Firefox', process: 'firefox' }; } },
    pointAt: (rect, o) => pointed.push({ rect, o }), settleThread: 0,
    launchApp: (id) => { launched.push(id); front.fg = { hwnd: 501, title: 'Untitled - Notepad', process: 'Notepad' }; },
    launchBrowser: async (b, url) => { browsed.push([b.key, url]); front.fg = { hwnd: 78, title: 'New Tab - Google Chrome', process: 'chrome' }; },
    defaultBrowser: async () => ({ key: 'firefox', label: 'Firefox', process: 'firefox' }),
    apps: () => [{ key: 'notepad', name: 'Notepad', appId: 'np', describe: 'Notepad (notepad, notes)' }, { key: 'chrome', name: 'Google Chrome', appId: 'gc', describe: 'Google Chrome (browser)' }],
    searchFiles: async (q) => (q === 'lab 3' ? [{ path: 'C:\\Users\\x\\Documents\\lab 3.pdf', name: 'lab 3.pdf', folder: 'Documents', when: '2026-10-01' }] : []),
    openPath: async () => '', sleep: async () => {},
  });
  const ctx = { elements: ELEMENTS, cap: CAP, originPhys: { x: 0, y: 0 }, fg: { title: 'Canvas - Chrome', process: 'chrome', rect: { x: 0, y: 0, w: 1920, h: 1080 } } };
  return { actions, hands, pointed, opened, launched, browsed, front, ctx };
}

test('actions: click by id, by text near an item, by fraction; the thread flies first; private fields are refused', async () => {
  const r = rig();
  const a = await r.actions.run('click', { id: 1 }, r.ctx);
  assert.equal(a.ok, true); assert.match(a.report, /Insert/);
  assert.deepEqual(r.hands.calls[0], { op: 'mouse.click', params: { x: 130, y: 52, button: 'left', double: false } });
  assert.deepEqual(r.pointed[0].rect, ELEMENTS[0].rect);
  const near = await r.actions.run('click', { text: 'Add to cart', near: 'Soundcore' }, r.ctx);
  assert.equal(near.ok, true);
  assert.equal(r.hands.calls[1].params.y, 315, 'the row next to the named item');
  const frac = await r.actions.run('click', { x: 0.5, y: 0.5 }, r.ctx);
  assert.equal(frac.ok, true); assert.deepEqual([r.hands.calls[2].params.x, r.hands.calls[2].params.y], [960, 540]);
  const pw = await r.actions.run('click', { id: 3 }, r.ctx);
  assert.equal(pw.ok, false); assert.equal(pw.refused, 'password');
  const missing = await r.actions.run('click', { id: 99 }, r.ctx);
  assert.equal(missing.ok, false); assert.match(missing.report, /could not find/);
});

test('actions: type clicks the field first and selects what is there; press checks keys; scroll, open, search, files', async () => {
  const r = rig();
  const t = await r.actions.run('type', { text: 'my name', id: 7, submit: true }, r.ctx);
  assert.equal(t.ok, true);
  const ops = r.hands.calls.map((c) => c.op);
  assert.deepEqual(ops, ['mouse.click', 'keys.press', 'keys.text']);
  assert.equal(r.hands.calls[2].params.enter, true);
  assert.equal((await r.actions.run('press', { keys: 'ctrl+s' }, r.ctx)).ok, true);
  assert.equal((await r.actions.run('press', { keys: 'hyper+x' }, r.ctx)).ok, false);
  const sc = await r.actions.run('scroll', { direction: 'down', amount: 2 }, r.ctx);
  assert.equal(sc.ok, true);
  assert.equal(r.hands.calls.at(-1).params.dy, -16);
  const app = await r.actions.run('open_app', { name: 'notepad' }, r.ctx);
  assert.equal(app.ok, true); assert.deepEqual(r.launched, ['np']);
  assert.equal((await r.actions.run('open_app', { name: 'Photoshop' }, r.ctx)).ok, false);
  assert.equal((await r.actions.run('open_url', { url: 'canvas.instructure.com/courses/1' }, r.ctx)).ok, true);
  assert.equal(r.opened[0], 'https://canvas.instructure.com/courses/1');
  assert.equal((await r.actions.run('open_url', { url: 'file:///C:/secret' }, r.ctx)).ok, false);
  assert.equal((await r.actions.run('web_search', { query: 'remote design jobs' }, r.ctx)).ok, true);
  assert.match(r.opened[1], /google\.com\/search\?q=remote(%20|\+)design(%20|\+)jobs/);
  const f = await r.actions.run('find_files', { query: 'lab 3' }, r.ctx);
  assert.match(f.report, /lab 3\.pdf/); assert.equal(f.noLook, true);
  assert.equal((await r.actions.run('open_file', { index: 1 }, r.ctx)).ok, true);
  assert.equal((await r.actions.run('open_file', { index: 2 }, r.ctx)).ok, false);
  assert.equal((await r.actions.run('nope', {}, r.ctx)).ok, false);
});

function agentRig(replies, opts = {}) {
  const active = [];
  const r = rig();
  const sent = [], spoken = [], logs = [];
  const pending = consent.createPending();
  const reads = [];
  const agent = new HandsAgent({
    read: async () => { reads.push(1); return { fg: r.ctx.fg, cap: CAP, elements: ELEMENTS, originPhys: { x: 0, y: 0 } }; },
    llm: () => ({ ready: true, provider: 'test', async complete(p) { const next = replies.shift(); if (p.onDelta && opts.stream !== false) p.onDelta(next); return next; } }),
    actions: r.actions, consent: { preview: consent.preview, pending },
    send: (ch, p) => sent.push([ch, p]), speak: (t, first) => spoken.push([t, first]),
    watcher: opts.watcher === null ? null : { async waitForChange() { return { changed: opts.changed !== false, settled: true }; } },
    fingerprint: () => new Uint8Array(4), retract: () => sent.push(['retract']), log: (m) => logs.push(m), sleep: async () => {}, now: () => (opts.clock ? opts.clock.t : 1000),
    onActive: (on) => active.push(on), maxSteps: opts.maxSteps,
  });
  return { agent, sent, spoken, logs, pending, r, reads, active };
}
const last = (sent, ch) => { const m = sent.filter(([c]) => c === ch); return m.length ? m[m.length - 1][1] : null; };

test('the agent: goal, a chain of actions, a fresh look between steps, done when the screen confirms it', async () => {
  const g = agentRig([
    '[GOAL: open lab 3 on canvas] Heading to Canvas. [DO:open_url {"url": "https://canvas.test"}]',
    'Opening the assignment. [DO:click {"id": 1}] [DONE]',
  ]);
  await g.agent.run('go to canvas and open lab 3', 'voice');
  assert.equal(g.agent.status().state, 'idle');
  assert.equal(g.reads.length, 2, 'one look per step');
  assert.deepEqual(g.spoken[0], ['Heading to Canvas.', true]);
  assert.equal(g.r.opened[0], 'https://canvas.test/');
  assert.equal(g.r.hands.calls[0].op, 'mouse.click');
  const done = last(g.sent, 'guide:bubble');
  assert.equal(done.kicker, 'done'); assert.match(done.text, /Opening the assignment/);
  assert.ok(g.spoken.some(([t]) => t === 'Opening the assignment.'), 'spoken by voice as it streamed');
  assert.equal(done.speak, undefined, 'and not a second time by the closing bubble');
});

test('a risky click shows a card; Not now stops the task; a spoken yes lets it through', async () => {
  const no = agentRig(['Submitting it. [DO:click {"id": 2}] [DONE]']);
  const run = no.agent.run('submit lab 3', 'typed');
  await new Promise((r) => setImmediate(r));
  const card = last(no.sent, 'guide:bubble');
  assert.equal(card.kicker, 'ask first'); assert.match(card.text, /Submit Assignment/);
  assert.deepEqual(card.actions.map((a) => a.id), ['hands-yes', 'hands-no']);
  assert.equal(no.agent.asking(), true);
  no.agent.answer(false);
  await run;
  assert.equal(no.r.hands.calls.length, 0, 'nothing clicked');
  assert.match(last(no.sent, 'guide:bubble').text, /not doing that/);

  const yes = agentRig(['Submitting it. [DO:click {"id": 2}] [DONE]']);
  const run2 = yes.agent.run('submit lab 3', 'voice');
  await new Promise((r) => setImmediate(r));
  assert.equal(yes.agent.spoken('yes go ahead'), 'yes');
  await run2;
  assert.equal(yes.r.hands.calls[0].op, 'mouse.click');
  assert.equal(last(yes.sent, 'guide:bubble').kicker, 'done');
});

test('done after a click that changed nothing is sent back; the same action three times stops the chain; a stop mid-run ends it', async () => {
  const g = agentRig([
    'Clicking it. [DO:click {"id": 1}] [DONE]',
    'Clicking it again. [DO:click {"id": 1}] [DONE]',
    'And again. [DO:click {"id": 1}] [DONE]',
    'It is not working. [DO:click {"id": 1}]',
  ], { changed: false });
  await g.agent.run('open insert', 'typed');
  assert.ok(g.logs.some((m) => /third time/.test(m)) || g.logs.some((m) => /finish/.test(m)));
  const s = agentRig(['[GOAL: x] Working. [DO:wait {"seconds": 1}]', 'Still going. [DO:wait {"seconds": 1}]']);
  const run = s.agent.run('do a long thing', 'typed');
  await new Promise((r) => setImmediate(r));
  s.agent.stop('esc');
  await run;
  assert.equal(s.agent.active(), false);
});

test('no actions and no done means the model stopped to ask: the task ends with its words', async () => {
  const g = agentRig(['I need your login first: the page is asking for a password.']);
  await g.agent.run('log in to canvas', 'typed');
  const b = last(g.sent, 'guide:bubble');
  assert.match(b.text, /login first/);
  assert.equal(g.agent.active(), false);
});

test('findElement resolves ids and text, and prefers the row near the named item', () => {
  assert.equal(findElement({ id: 2 }, ELEMENTS).name, 'Submit Assignment');
  assert.equal(findElement({ text: 'insert tab' }, ELEMENTS).id, 1);
  assert.equal(findElement({ text: 'add to cart', near: 'soundcore' }, ELEMENTS).id, 5);
  assert.equal(findElement({ text: 'zzz' }, ELEMENTS), null);
});

test('a reply that arrives whole (no streaming) is still spoken, parsed and acted on', async () => {
  const g = agentRig(['Opening it. [DO:click {"id": 1}] [DONE]'], { stream: false });
  await g.agent.run('open insert', 'voice');
  assert.equal(g.r.hands.calls[0].op, 'mouse.click');
  assert.deepEqual(g.spoken[0], ['Opening it.', true]);
  assert.equal(last(g.sent, 'guide:bubble').kicker, 'done');
});

test('out of steps, "keep going" resumes the same task with its history; Esc is armed only while it runs', async () => {
  const clock = { t: 1000 };
  const g = agentRig([
    '[GOAL: tidy the folder] Step one. [DO:wait {"seconds": 1}]',
    'Step two. [DO:wait {"seconds": 1}]',
    'Step three. [DO:wait {"seconds": 1}] [DONE]',
  ], { maxSteps: 2, clock });
  await g.agent.run('tidy my downloads folder', 'typed');
  assert.match(last(g.sent, 'guide:bubble').text, /keep going/);
  assert.deepEqual(g.active, [true, false]);
  assert.equal(g.agent.canResume(), true);
  await g.agent.resume('voice');
  assert.equal(last(g.sent, 'guide:bubble').kicker, 'done');
  assert.equal(g.agent.last.goal, 'tidy the folder', 'the goal carries over');
  assert.equal(g.agent.canResume(), false);
  assert.deepEqual(g.active, [true, false, true, false]);

  const late = agentRig(['One. [DO:wait {"seconds": 1}]'], { maxSteps: 1, clock });
  await late.agent.run('a long thing', 'typed');
  clock.t += 6 * 60 * 1000;
  assert.equal(late.agent.canResume(), false, 'too long ago');
  assert.equal(await late.agent.resume('voice'), false);
});

test('routing: tasks go to Hands, how-to asks and questions do not', () => {
  const { isTask, multistep } = require('../src/reflex/rules');
  for (const s of ['open notepad and write my to-do list', 'find remote design jobs on indeed', 'go to canvas then open lab 3', 'please fill in the form with my name', 'tidy my downloads folder', "Email Professor Lee that I'm finishing lab 3 tonight", 'message Jev that I am late']) assert.equal(isTask(s), true, s);
  for (const s of ['how do I insert a table', 'where is the settings page', 'what is a pivot table', 'explain this error', 'thanks']) assert.equal(isTask(s), false, s);
  assert.equal(multistep('open notepad and write hello'), true);
  assert.equal(multistep('open notepad'), false);
});

test('keys carry the window Hands read and our pid; the result says where they landed; keys bound for Nus itself fail', async () => {
  const calls = [];
  let answer = { ok: true, chars: 5, window: 'Untitled - Notepad', focus: 'Text editor', focusType: 'document' };
  const hands = { async request(op, params) { calls.push({ op, params }); return op === 'keys.text' ? answer : { ok: true, window: 'Untitled - Notepad' }; } };
  const actions = createActions({ probe: null, hands, shell: {}, pointAt: null, settleThread: 0, launchApp: () => {}, apps: () => [], searchFiles: async () => [], openPath: async () => '', sleep: async () => {}, selfPid: 4242 });
  const ctx = { elements: [], cap: CAP, originPhys: { x: 0, y: 0 }, fg: { title: 'Untitled - Notepad', process: 'Notepad', hwnd: 777 } };
  const r = await actions.run('type', { text: 'hello' }, ctx);
  assert.equal(r.ok, true);
  assert.equal(calls[0].params.hwnd, 777); assert.equal(calls[0].params.selfPid, 4242);
  assert.match(r.report, /into "Text editor" in "Untitled - Notepad"/);
  const p = await actions.run('press', { keys: 'ctrl+n' }, ctx);
  assert.equal(calls[1].params.hwnd, 777); assert.match(p.report, /in "Untitled - Notepad"/);
  answer = { ok: false, error: 'the keys would have gone to Nus itself' };
  const bad = await actions.run('type', { text: 'hello' }, ctx);
  assert.equal(bad.ok, false); assert.match(bad.report, /Nus itself/);
});

test('the prompt asks for keyboard shortcuts, chained replies and a plain done line', () => {
  const { SYSTEM } = require('../src/hands/prompt');
  assert.match(SYSTEM, /ctrl\+n in Notepad/);
  assert.match(SYSTEM, /same reply with \[DONE\]/);
  assert.match(SYSTEM, /never a description of the screen/);
  assert.match(SYSTEM, /Never type into a tab/);
});

// ---- the four live bugs of 2026-10-11 ----

test('bug 1: a task that carries text later in the sentence is held open across a pause; with Hands on, any task is', () => {
  const { carriesText } = require('../src/reflex/rules');
  // Live: these arrived cut at the pause, with the list never heard.
  assert.equal(carriesText('Open a new pad on Notepad and type'), true);
  assert.equal(carriesText('Make a new notepad on notepad and type'), true);
  assert.equal(carriesText('open a new tab on notepad and write a new to-do list'), true);
  assert.equal(carriesText('send Jev a message saying'), true);
  assert.equal(carriesText('remember I take CS 2110 with Professor Lee'), true);
  // Hands off: a plain launch or a how-to is routed at the pause as before.
  assert.equal(carriesText('open notepad'), false);
  assert.equal(carriesText('how do I insert a table'), false);
  assert.equal(carriesText('thanks'), false);
  // Hands on: every task waits for the key to come up, so it arrives whole.
  assert.equal(carriesText('open notepad', { hands: true }), true);
  assert.equal(carriesText('open a new tab on notepad', { hands: true }), true);
  assert.equal(carriesText('how do I insert a table', { hands: true }), false);
  assert.equal(carriesText('what is a pivot table', { hands: true }), false);
});

test('bug 2: the prompt forbids invented content and empty typing, and treats odd phrases as mis-hearings', () => {
  const { SYSTEM } = require('../src/hands/prompt');
  assert.match(SYSTEM, /Never invent content/);
  assert.match(SYSTEM, /ARE the content, even when the transcript puts a full stop between them/, 'live: "write my to-do list. Email Professor Lee and install Nūs Companion" was asked back instead of typed');
  assert.match(SYSTEM, /Only when the user gave no content at all do you ask/);
  assert.match(SYSTEM, /Never send \[DO:type\] with empty text/);
  assert.match(SYSTEM, /mis-heard/);
  assert.match(SYSTEM, /"To-do:\\n- Email Professor Lee\\n- Install Nūs Companion"/, 'his exact ask is the example');
  assert.match(SYSTEM, /names a browser \(Chrome, Firefox, Edge\), every address in that task goes to it/);
  assert.match(SYSTEM, /The done line is for the user and is short/);
  const t = parseTags('New tab. [DO:press {"keys": "ctrl+n"}] [DO:type {"text": ""}] What should I type?');
  assert.deepEqual(t.actions.map((a) => a.name), ['press'], 'the empty type is dropped');
  assert.equal(t.emptyType, true);
  assert.equal(parseTags('[DO:type {"text": "   "}]').emptyType, true);
  assert.equal(parseTags('[DO:type {"text": "hi"}]').emptyType, false);
});

test('bug 2: after an empty type the model is told to ask, not guess; a reply with only a question ends the task', async () => {
  const prompts = [];
  const g = agentRig(['New tab. [DO:press {"keys": "ctrl+n"}] [DO:type {"text": ""}]', 'What should go on the list?']);
  const inner = g.agent.d.llm;
  g.agent.d.llm = () => { const l = inner(); return Object.assign({}, l, { complete(p) { prompts.push(p.turns[0].text); return l.complete(p); } }); };
  await g.agent.run('open a new tab on notepad and write my to-do list', 'voice');
  assert.equal(g.r.hands.calls.filter((c) => c.op === 'keys.text').length, 0, 'nothing typed');
  assert.match(prompts[1], /no text/);
  assert.ok(g.logs.some((m) => /empty type/.test(m)));
  const b = last(g.sent, 'guide:bubble');
  assert.match(b.text, /What should go on the list/);
  assert.equal(g.agent.active(), false);
});

test('bug 3: an ask that names its app goes to Hands whole when Hands is on; plain launches stay with the reflex layer', () => {
  const { namesTarget, handsTakes } = require('../src/reflex/rules');
  assert.equal(namesTarget('open a new tab on notepad'), true);
  assert.equal(namesTarget('Open a new tab on Notepad.'), true);
  assert.equal(namesTarget('search for lofi beats on youtube'), true);
  assert.equal(namesTarget('make a note in obsidian', [{ name: 'Obsidian' }]), true);
  assert.equal(namesTarget('make a note in obsidian'), false);
  assert.equal(namesTarget('open a new tab'), false);
  assert.equal(namesTarget('type hello in the box'), false);
  assert.equal(namesTarget('search youtube for lofi beats'), true, 'live: went to the plain web search in the default browser');
  assert.equal(namesTarget('go on chrome and search youtube'), true);
  const { bareLaunch } = require('../src/reflex/rules');
  assert.equal(bareLaunch('open notepad'), true); assert.equal(bareLaunch('Open up Chrome.'), true); assert.equal(bareLaunch('launch obsidian', [{ name: 'Obsidian' }]), true);
  assert.equal(bareLaunch('open a new tab on notepad'), false); assert.equal(bareLaunch('search youtube for lofi beats'), false); assert.equal(bareLaunch('open notepad and type hello'), false);
  assert.equal(handsTakes('open a new tab on notepad', { hands: false }), false, 'Hands off: nothing changes');
  assert.equal(handsTakes('open a new tab on notepad', { hands: true }), true, 'live: this went to the reflex new_tab rule and the wrong window');
  assert.equal(handsTakes('open notepad and type hello', { hands: true }), true);
  assert.equal(handsTakes('search youtube for lofi beats', { hands: true }), true);
  assert.equal(handsTakes('open notepad', { hands: true }), false, 'one word, one app: the reflex layer is faster');
  assert.equal(handsTakes('open chrome', { hands: true }), false);
  assert.equal(handsTakes('new tab', { hands: true }), false);
  assert.equal(handsTakes('how do I open a new tab in chrome', { hands: true }), false, 'a how-to is the guide');
  assert.equal(handsTakes('open word and teach me how to create a table', { hands: true }), false, 'a how-to after a launch is the guide');
  // Live 2026-10-13: polite forms of the reel line missed Hands.
  for (const s of ["Can you email Professor Lee that I'm finishing lab 3 tonight?", 'Hello Nūs, can you email my Professor Lee?', 'hey nus please message Jev that I am late', "Email Professor Lee that I'm finishing lab 3 tonight", 'send an email to my professor saying I am sick']) assert.equal(handsTakes(s, { hands: true }), true, s);
  assert.equal(handsTakes('how do I email a professor', { hands: true }), false);
  assert.equal(handsTakes('what is email', { hands: true }), false);
});

test('bug 4: typing is one burst with a 1500 character room; settle caps are short and give up early on a still screen', async () => {
  const { MAX_TEXT } = require('../src/hands/actions');
  assert.equal(MAX_TEXT, 1500);
  const r = rig();
  const long = 'x'.repeat(2000);
  await r.actions.run('type', { text: long }, r.ctx);
  assert.equal(r.hands.calls.at(-1).params.text.length, 1500);
  const c = await r.actions.run('click', { id: 1 }, r.ctx);
  assert.ok(c.settle <= 2500 && c.giveUp <= 1000, 'a click no longer waits 4 s on a screen that never moves');
  const u = await r.actions.run('open_url', { url: 'https://example.com' }, r.ctx);
  assert.ok(u.settle <= 3500 && u.giveUp <= 2000);
  const p = await r.actions.run('press', { keys: 'ctrl+n' }, r.ctx);
  assert.ok(p.settle <= 2000 && p.giveUp <= 1000);
  // The sidecar pastes the text (Ctrl+V) and puts the old clipboard back;
  // SendKeys is only the fallback. (A burst of Unicode key events typed fine
  // in a plain text box but came out as "To-do:nnnnnn" in Windows 11 Notepad.)
  const fs = require('fs');
  const ps1 = fs.readFileSync(require('path').join(__dirname, '..', 'src', 'reflex', 'hands.ps1'), 'utf8');
  const textOp = ps1.slice(ps1.indexOf("'keys.text'"), ps1.indexOf("default {"));
  assert.match(textOp, /\$CB::SetText\(\$t, \[System\.Windows\.Forms\.TextDataFormat\]::UnicodeText\)/);
  assert.match(textOp, /Chord\(\[int\[\]\]@\(0x11, 0x56\)\)/, 'Ctrl+V');
  assert.match(textOp, /\$CB::SetText\(\$oldText\)/, 'old clipboard text restored');
  assert.match(textOp, /SetImage\(\$oldImage\)/); assert.match(textOp, /SetFileDropList\(\$oldFiles\)/);
  assert.match(textOp, /if \(-not \$pasted\)[\s\S]*SendKeys\]::SendWait/, 'fallback only');
  assert.ok(!/SendWait\('\{ENTER\}'\)/.test(textOp), 'Enter is a real key press');
});

test('bug 4: the watcher gives up on a screen that has not moved by giveUpMs instead of sitting out the cap', async () => {
  const { ScreenWatcher } = require('../src/guide/settle');
  let t = 0;
  const still = new Uint8Array(64 * 40).fill(100);
  const w = new ScreenWatcher({ grab: async () => still, interval: 150, now: () => t, sleep: async (ms) => { t += ms; } });
  const out = await w.waitForChange(4000, still, () => false, { giveUpMs: 1000 });
  assert.equal(out.changed, false); assert.equal(out.gaveUp, true);
  assert.ok(out.ms <= 1200, 'back in about a second, not four: ' + out.ms);
  // Without the option nothing changes for the guide.
  t = 0;
  const slow = await w.waitForChange(1000, still, () => false);
  assert.equal(slow.gaveUp, undefined); assert.ok(slow.ms >= 1000);
  // A screen that moves and then holds still is still reported as changed.
  t = 0;
  let n = 0;
  const moving = new ScreenWatcher({ grab: async () => (n++ < 1 ? still : new Uint8Array(64 * 40).fill(200)), interval: 150, now: () => t, sleep: async (ms) => { t += ms; } });
  const moved = await moving.waitForChange(4000, still, () => false, { giveUpMs: 1000 });
  assert.equal(moved.changed, true);
});

test('bug 4: the agent hands each action\'s give-up to the watcher and records whether the model process was warm', async () => {
  const waits = [];
  const rows = [];
  const g = agentRig(['Clicking it. [DO:click {"id": 1}] [DONE]']);
  g.agent.d.watcher = { async waitForChange(ms, baseline, stale, opts) { waits.push({ ms, opts }); return { changed: true, settled: true }; } };
  g.agent.d.ledger = { record: (row) => rows.push(row) };
  const inner = g.agent.d.llm;
  g.agent.d.llm = () => Object.assign({}, inner(), { warmHint: () => true });
  await g.agent.run('open insert', 'typed');
  assert.equal(waits[0].ms, 1500); assert.equal(waits[0].opts.giveUpMs, 600);
  assert.equal(rows[0].feature, 'hands'); assert.equal(rows[0].warm, true);
});

test('minor: the Alt+Tab "Task Switching" window is never the front app', () => {
  const { isSwitcher } = require('../src/hands/agent');
  assert.equal(isSwitcher({ title: 'Task Switching', process: 'explorer' }), true);
  assert.equal(isSwitcher({ title: 'Task Switching', process: '' }), true);
  assert.equal(isSwitcher({ title: 'Task Switching', process: 'Notepad' }), false, 'a document someone named that');
  assert.equal(isSwitcher({ title: 'Untitled - Notepad', process: 'Notepad' }), false);
  assert.equal(isSwitcher(null), false);
});

test('open_app waits until the app is in front and makes it the window the next keys go to', async () => {
  const { frontIs, APP_FRONT_MS } = require('../src/hands/actions');
  assert.ok(frontIs({ process: 'WINWORD', title: 'Document1 - Word' }, { name: 'Word' }));
  assert.ok(frontIs({ process: 'chrome', title: 'New Tab - Google Chrome' }, { name: 'Google Chrome' }));
  assert.ok(frontIs({ process: 'Notepad', title: '*To-do - Notepad' }, { name: 'Notepad' }));
  assert.ok(!frontIs({ process: 'claude', title: 'Claude' }, { name: 'Notepad' }), 'live: Ctrl+Enter for Notepad landed in the chat window');
  assert.ok(APP_FRONT_MS >= 5000, 'Word takes seconds to its start screen');
  const r = rig();
  const a = await r.actions.run('open_app', { name: 'notepad' }, r.ctx);
  assert.equal(a.ok, true); assert.match(a.report, /Notepad is in front/);
  assert.equal(r.ctx.fg.hwnd, 501, 'chained keys now target Notepad, not the window read before');
  const p = await r.actions.run('press', { keys: 'ctrl+enter' }, r.ctx);
  assert.equal(p.ok, true);
  assert.equal(r.hands.calls.at(-1).params.hwnd, 501);
});

test('an app that starts behind or minimized is brought to the front by name; the launch clause names it', async () => {
  const { launchClause } = require('../src/reflex/rules');
  assert.deepEqual(launchClause('Open Word and teach me how to create a table.'), { app: 'Word' });
  assert.deepEqual(launchClause('open up the notes app and make a new note'), { app: 'notes' });
  assert.equal(launchClause('open word'), null);
  assert.equal(launchClause('how do I open word and make a table'), null);
  // Live 2026-10-11: Word launched in the background; the front window stayed the chat.
  const r = rig();
  const activations = [];
  const inner = r.hands.request.bind(r.hands);
  r.hands.request = async (op, params) => { if (op === 'win.activate') { activations.push(params.name); if (activations.length >= 2) r.front.fg = { hwnd: 9, title: 'Document1 - Word', process: 'WINWORD' }; return { ok: activations.length >= 2 }; } return inner(op, params); };
  r.front.fg = { hwnd: 1, title: 'Claude', process: 'claude' };
  // The launch itself does not change the front window in this case.
  const actions = createActions({
    probe: { async request(op) { return op === 'fg' ? r.front.fg : {}; } }, hands: r.hands, shell: {}, pointAt: null, settleThread: 0,
    launchApp: () => {}, apps: () => [{ key: 'word', name: 'Word', appId: 'w', describe: 'Word (microsoft word)' }], searchFiles: async () => [], openPath: async () => '', sleep: async () => {},
  });
  const t0 = Date.now();
  const a = await actions.run('open_app', { name: 'Word' }, { elements: [], cap: CAP, originPhys: { x: 0, y: 0 }, fg: r.front.fg });
  assert.equal(a.ok, true); assert.match(a.report, /Word is in front/);
  assert.ok(activations.length >= 2, 'brought forward by name after the first second: ' + activations.length);
  assert.ok(Date.now() - t0 < 6000);
});

test('open_url goes to the browser the user named, or the one Hands opened in this task; else the default browser', async () => {
  const r = rig();
  const u = await r.actions.run('open_url', { url: 'youtube.com/results?search_query=lofi', in: 'Chrome' }, r.ctx);
  assert.equal(u.ok, true); assert.match(u.report, /in Chrome/);
  assert.deepEqual(r.browsed[0], ['chrome', 'https://youtube.com/results?search_query=lofi']);
  assert.equal(r.opened.length, 0, 'not the default browser as well (live: Chrome opened, YouTube landed in Firefox)');
  // A browser opened earlier in the task is remembered for the addresses after it.
  r.front.fg = { hwnd: 7, title: 'New Tab - Google Chrome', process: 'chrome' };
  const o = await r.actions.run('open_app', { name: 'Chrome' }, r.ctx);
  assert.equal(o.ok, true); assert.equal(r.ctx.browser.key, 'chrome');
  await r.actions.run('open_url', { url: 'https://example.com' }, r.ctx);
  assert.equal(r.browsed.at(-1)[1], 'https://example.com/');
  // No browser named or opened: the default one.
  const d = await r.actions.run('open_url', { url: 'https://example.org' }, { elements: [], cap: CAP, originPhys: { x: 0, y: 0 } });
  assert.match(d.report, /default browser/); assert.equal(r.opened.at(-1), 'https://example.org/');
  const { SYSTEM } = require('../src/hands/prompt');
  assert.match(SYSTEM, /"in": "Chrome"/);
  // Keys always go to the window Hands meant: the sidecar brings it to the front first.
  const ps1 = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'reflex', 'hands.ps1'), 'utf8');
  const ensure = ps1.slice(ps1.indexOf('function Ensure-Target'), ps1.indexOf('function Handle'));
  assert.match(ensure, /GetForegroundWindow\(\) -ne \$h/);
  assert.match(ensure, /Activate\(\$h\)/);
});

test('reel-take bugs: bubbles carry the run id so an old OK cannot stop a new task; a tab label is never typed into; the prompt trusts a landed paste', async () => {
  const g = agentRig(['Done. [DO:wait {"seconds": 1}] [DONE]', 'Done again. [DO:wait {"seconds": 1}] [DONE]']);
  await g.agent.run('first task', 'typed');
  const first = last(g.sent, 'guide:bubble');
  assert.equal(first.sessionId, 'hands:1');
  await g.agent.run('second task', 'typed');
  assert.equal(last(g.sent, 'guide:bubble').sessionId, 'hands:2');
  assert.equal(g.agent.bubbleId(), 'hands:2', 'main compares a dismiss against this and ignores hands:1');
  const r = rig();
  const t = await r.actions.run('type', { text: 'my list', id: 1 }, r.ctx);
  assert.equal(t.ok, false); assert.match(t.report, /tabitem, not a text field/i);
  assert.equal(r.hands.calls.filter((c) => c.op === 'keys.text').length, 0);
  const ok = await r.actions.run('type', { text: 'my list', id: 7 }, r.ctx);
  assert.equal(ok.ok, true); assert.ok(ok.lookAfter >= 300 && ok.settle >= 1000, 'a moment to repaint before the next look');
  const { SYSTEM } = require('../src/hands/prompt');
  assert.match(SYSTEM, /do not retype it/);
  assert.match(SYSTEM, /Nūs's own bubbles/);
  const fs = require('fs'), path = require('path');
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  assert.match(renderer, /nus\.guideDismiss\(reason, bubble\.dataset\.sessionId \|\| ''\)/);
  assert.match(renderer, /function reportHintRect/);
  const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  assert.match(preload, /guideDismiss: \(reason, sessionId\)/);
});

test('keys only go to the app the task opened: a web address waits for the browser, and typing into any other window is refused', async () => {
  // Live 2026-10-12: Gmail opened in Firefox behind a full-screen window; the next
  // look landed on the chat app in front and the email body was pasted into it.
  const r = rig();
  const ctx = { elements: [], cap: CAP, originPhys: { x: 0, y: 0 }, fg: { hwnd: 1, title: 'Claude', process: 'claude' } };
  const u = await r.actions.run('open_url', { url: 'https://mail.google.com/mail/?view=cm' }, ctx);
  assert.equal(u.ok, true); assert.match(u.report, /Firefox.*in front|in front/);
  assert.deepEqual(ctx.target, { name: 'Firefox', process: 'firefox' });
  assert.equal(ctx.fg.process, 'firefox', 'the browser window is now the key target');
  // Another window takes the front before the next step: nothing is typed there.
  ctx.fg = { hwnd: 1, title: 'Claude', process: 'claude' };
  const t = await r.actions.run('type', { text: 'Hi Professor Lee, I am finishing lab 3 tonight.' }, ctx);
  assert.equal(t.ok, false); assert.equal(t.refused, 'window'); assert.match(t.report, /"Claude" is in front, not Firefox/);
  assert.equal(r.hands.calls.filter((c) => c.op === 'keys.text').length, 0, 'nothing pasted anywhere');
  const p = await r.actions.run('press', { keys: 'ctrl+enter' }, ctx);
  assert.equal(p.ok, false); assert.equal(p.refused, 'window');
  // Back in the browser: typing is allowed again.
  ctx.fg = { hwnd: 77, title: 'Compose - Firefox', process: 'firefox' };
  assert.equal((await r.actions.run('type', { text: 'hello' }, ctx)).ok, true);
  // No target (the user asked to type into whatever is in front): no guard.
  assert.equal((await r.actions.run('type', { text: 'hello' }, { elements: [], cap: CAP, originPhys: { x: 0, y: 0 }, fg: { title: 'Claude', process: 'claude' } })).ok, true);
  // The default browser is read from Windows' https association.
  const { createDefaultBrowser } = require('../src/hands/actions');
  const db = createDefaultBrowser({ execFile: (exe, args, o, cb) => cb(null, '    ProgId    REG_SZ    FirefoxURL-308046B0AF4A39CB\r\n') });
  assert.equal((await db()).key, 'firefox');
  // A Store browser: the ProgId is opaque, its open command names the exe (this PC, 2026-10-12).
  const store = createDefaultBrowser({ execFile: (exe, args, o, cb) => cb(null, /UserChoice/.test(args[1]) ? '    ProgId    REG_SZ    AppXycpy9mb5aa9x31qd69xmfqbdxkq7ra6z\r\n' : '    (Default)    REG_SZ    "C:\\Program Files\\WindowsApps\\Mozilla.Firefox_157\\VFS\\ProgramFiles\\Firefox Package Root\\firefox.exe" -osint -url "%1"\r\n') });
  assert.equal((await store()).key, 'firefox');
  const none = createDefaultBrowser({ execFile: (exe, args, o, cb) => cb(new Error('no key'), '') });
  assert.equal(await none(), null);
  const { SYSTEM } = require('../src/hands/prompt');
  assert.match(SYSTEM, /Keys only go to the app this task opened/);
});

test('a browser is started directly with the whole address (no shell, so "&" survives); "Recipients" finds "To recipients"', async () => {
  const { createBrowserLaunch } = require('../src/hands/actions');
  const spawned = [];
  const launch = createBrowserLaunch({
    execFile: (exe, args, o, cb) => cb(null, /HKCU/.test(args[1]) ? '' : '\r\nHKEY_LOCAL_MACHINE\\...\\chrome.exe\r\n    (Default)    REG_SZ    C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe\r\n'),
    spawn: (exe, args, opts) => { spawned.push({ exe, args, opts }); return { on() {}, unref() {} }; },
  });
  const url = 'https://mail.google.com/mail/?view=cm&fs=1&to=lee@uni.edu&su=Lab%203';
  await launch({ key: 'chrome', label: 'Chrome', exe: 'chrome.exe' }, url);
  assert.equal(spawned[0].exe, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
  assert.deepEqual(spawned[0].args, [url], 'one argument, every & included');
  assert.ok(!/cmd/i.test(spawned[0].exe));
  const missing = createBrowserLaunch({ execFile: (exe, args, o, cb) => cb(null, ''), spawn: () => { throw new Error('never'); } });
  await assert.rejects(() => missing({ key: 'brave', label: 'Brave', exe: 'brave.exe' }, url), /not installed/);
  const els = [{ id: 16, name: 'Search Field', type: 'Edit', rect: { x: 0, y: 0, w: 10, h: 10 } }, { id: 40, name: 'To recipients', type: 'ComboBox', rect: { x: 0, y: 50, w: 10, h: 10 } }, { id: 41, name: 'Subject', type: 'Edit', rect: { x: 0, y: 80, w: 10, h: 10 } }];
  assert.equal(findElement({ text: 'Recipients' }, els).id, 40);
  assert.equal(findElement({ text: 'To' }, els).id, 40);
  assert.equal(findElement({ text: 'cc' }, els), null);
});

test('"hello Nūs" is a greeting on its own; in front of an ask it is dropped and the ask routes as usual', () => {
  const { greeting, handsTakes } = require('../src/reflex/rules');
  for (const s of ['Hello Nūs', 'hey nus', 'Hi, NuS!', "hello nu's", 'Hello News.', 'Nūs, hi', 'good morning nus']) assert.deepEqual(greeting(s), { rest: '' }, s);
  assert.deepEqual(greeting("Hello Nūs, can you email Professor Lee that I'm finishing lab 3 tonight?"), { rest: "can you email Professor Lee that I'm finishing lab 3 tonight?" });
  assert.equal(handsTakes(greeting('Hey Nus, email Professor Lee that I am late').rest, { hands: true }), true);
  assert.equal(greeting('open notepad'), null);
  assert.equal(greeting('hello world'), null, 'not a greeting to Nūs');
  assert.equal(greeting('news about the election'), null);
});

test('a paste the field cannot confirm is never called done: the result says so, Enter is held, and the agent looks again', async () => {
  // Live 2026-10-13: YouTube's search box got an empty paste, Enter searched for nothing, the model said done.
  const r = rig();
  let answer = { ok: true, chars: 11, how: 'paste', verified: false, submitted: false, window: 'YouTube - Google Chrome', focus: 'Search', focusType: 'edit' };
  const inner = r.hands.request.bind(r.hands);
  r.hands.request = async (op, params) => (op === 'keys.text' ? answer : inner(op, params));
  const ctx = { elements: [], cap: CAP, originPhys: { x: 0, y: 0 }, fg: { hwnd: 7, title: 'YouTube - Google Chrome', process: 'chrome' } };
  const t = await r.actions.run('type', { text: 'study music', submit: true }, ctx);
  assert.equal(t.ok, true); assert.equal(t.unverified, true);
  assert.match(t.report, /the box does not show it, so Enter was not pressed/);
  assert.ok(!/pressed Enter/.test(t.report));
  answer = Object.assign({}, answer, { verified: true, submitted: true });
  const good = await r.actions.run('type', { text: 'study music', submit: true }, ctx);
  assert.equal(good.unverified, false); assert.match(good.report, /pressed Enter; the box shows it/);
  answer = Object.assign({}, answer, { verified: null, submitted: true });
  const unknown = await r.actions.run('type', { text: 'study music', submit: true }, ctx);
  assert.equal(unknown.unverified, true); assert.match(unknown.report, /could not read the box back/);
  // The agent: done right after an unconfirmed type is sent back once.
  const g = agentRig(['Searching. [DO:type {"text": "study music", "submit": true}] [DONE]', 'Looking again. [DO:look {}]', 'Done, results are up. [DONE]']);
  const hands = g.r.hands; const inner2 = hands.request.bind(hands);
  hands.request = async (op, params) => (op === 'keys.text' ? { ok: true, how: 'paste', verified: false, submitted: false } : inner2(op, params));
  const prompts = [];
  const llm = g.agent.d.llm; g.agent.d.llm = () => { const l = llm(); return Object.assign({}, l, { complete(p) { prompts.push(p.turns[0].text); return l.complete(p); } }); };
  await g.agent.run('search youtube for study music', 'voice');
  assert.match(prompts[1], /could not be confirmed in the box/);
  const { SYSTEM } = require('../src/hands/prompt');
  assert.match(SYSTEM, /youtube\.com\/results\?search_query=/);
  assert.match(SYSTEM, /never say done on that alone/);
  // The sidecar checks the field after the paste and holds Enter when the words are not there.
  const ps1 = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'reflex', 'hands.ps1'), 'utf8');
  assert.match(ps1, /function Read-FocusedText/);
  assert.match(ps1, /if \(\$req\.enter -and \$verified -ne \$false\)/);
  const probe = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'win', 'probe.ps1'), 'utf8');
  assert.match(probe, /'uia\.focused' \{/);
});

test('the Knot flies to every target: the focused field before typing or a key press, and a window that just came up', async () => {
  const r = rig();
  r.front.fg = { hwnd: 501, title: 'Untitled - Notepad', process: 'Notepad', rect: { x: 100, y: 100, w: 800, h: 600 } };
  const probeInner = r.actions; void probeInner;
  const actions = createActions({
    probe: { async request(op) { if (op === 'fg') return r.front.fg; if (op === 'uia.focused') return { element: { name: 'Text editor', type: 'Document', rect: { x: 120, y: 160, w: 700, h: 500 }, isPassword: false } }; return {}; } },
    hands: r.hands, shell: {}, pointAt: (rect, o) => r.pointed.push({ rect, o }), settleThread: 0,
    launchApp: () => {}, apps: () => [{ key: 'notepad', name: 'Notepad', appId: 'np', describe: 'Notepad' }], searchFiles: async () => [], openPath: async () => '', sleep: async () => {},
  });
  const ctx = { elements: [], cap: CAP, originPhys: { x: 0, y: 0 }, fg: { hwnd: 1, title: 'Claude', process: 'claude' } };
  await actions.run('open_app', { name: 'Notepad' }, ctx);
  assert.deepEqual(r.pointed.at(-1).rect, { x: 100, y: 100, w: 800, h: 600 }, 'the new window');
  await actions.run('type', { text: 'hello' }, ctx);
  assert.deepEqual(r.pointed.at(-1).rect, { x: 120, y: 160, w: 700, h: 500 }, 'the focused field');
  assert.match(r.pointed.at(-1).o.instruction, /Typing into "Text editor"/);
  await actions.run('press', { keys: 'ctrl+n' }, ctx);
  assert.match(r.pointed.at(-1).o.instruction, /Pressing ctrl\+n/);
  // A focused password field is refused before any key goes out.
  const pw = createActions({ probe: { async request(op) { return op === 'uia.focused' ? { element: { name: 'Password', type: 'Edit', rect: { x: 0, y: 0, w: 1, h: 1 }, isPassword: true } } : {}; } }, hands: r.hands, shell: {}, pointAt: null, settleThread: 0, launchApp: () => {}, apps: () => [], searchFiles: async () => [], openPath: async () => '', sleep: async () => {} });
  const refused = await pw.run('type', { text: 'hunter2' }, { elements: [], cap: CAP, originPhys: { x: 0, y: 0 }, fg: { title: 'Login' } });
  assert.equal(refused.refused, 'password');
});

test('whisper gets a short vocabulary prompt: the product first, then names from memory, no repeats, capped', () => {
  const { vocabularyPrompt } = require('../src/reflex/listen');
  const p = vocabularyPrompt(['Professor Lee', 'CS 2110', 'professor lee', '', 'x'.repeat(60)]);
  assert.match(p, /^Nūs Companion, Professor Lee, CS 2110\.$/);
  const many = vocabularyPrompt(Array.from({ length: 40 }, (_, i) => 'Name' + i));
  assert.ok(many.split(', ').length <= 14);
  assert.equal(vocabularyPrompt(null), 'Nūs Companion.');
  assert.doesNotMatch(vocabularyPrompt(null), /^Nūs,|the Knot/, 'these turned "Open Notepad" into "Open Nupad"');
});

test('a window Hands did not open coming to the front stops the task; one it opened does not', async () => {
  // Live 2026-10-22: Word, then the Claude app, came to the front mid-task and got clicked.
  const g = agentRig([
    'Clicking the first video. [DO:click {"id": 1}]',
    'Clicking it again. [DO:click {"id": 1}] [DONE]',
  ]);
  const firefox = { title: 'study music - YouTube - Mozilla Firefox', process: 'firefox', rect: { x: 0, y: 0, w: 1920, h: 1080 } };
  g.r.ctx.fg = firefox;
  const run = g.agent.run('select the first one', 'voice');
  // After the first step, Word takes the front.
  const origRead = g.agent.d.read;
  let n = 0;
  g.agent.d.read = async () => { const s = await origRead(); n++; if (n >= 1) s.fg = { title: 'Document1 - Word', process: 'WINWORD', rect: firefox.rect }; return s; };
  await run;
  assert.equal(g.r.hands.calls.filter((c) => c.op === 'mouse.click').length, 1, 'only the click in Firefox happened');
  const bubble = last(g.sent, 'guide:bubble');
  assert.equal(bubble.kicker, 'stopped');
  assert.match(bubble.text, /Document1 - Word came to the front, and I did not open it/);
  assert.ok(g.logs.some((m) => /^away: /.test(m)));
  assert.equal(g.agent.canResume(), true, '"keep going" carries on there');

  // An app Hands opened itself is fair game.
  const o = agentRig([
    'Opening Notepad. [DO:open_app {"name": "notepad"}]',
    'Typing. [DO:click {"id": 1}] [DONE]',
  ]);
  o.r.ctx.fg = { title: 'Settings', process: 'SystemSettings', rect: { x: 0, y: 0, w: 1920, h: 1080 } };
  const orig2 = o.agent.d.read;
  let m = 0;
  o.agent.d.read = async () => { const s = await orig2(); m++; if (m >= 1) s.fg = { title: 'Untitled - Notepad', process: 'Notepad', rect: { x: 0, y: 0, w: 1920, h: 1080 } }; return s; };
  await o.agent.run('open notepad and click in it', 'typed');
  assert.equal(last(o.sent, 'guide:bubble').kicker, 'done');
  assert.ok(!o.logs.some((x) => /^away: /.test(x)));
});

test('the phantom front window and the bare desktop neither claim a task nor stop it', async () => {
  const g = agentRig([
    'Opening the page. [DO:open_url {"url": "https://www.youtube.com/results?search_query=study+music"}]',
    'Clicking it. [DO:click {"id": 1}] [DONE]',
  ]);
  const real = g.agent.d.read;
  let n = 0;
  g.agent.d.read = async () => {
    const s = await real(); n++;
    if (n === 1) return Object.assign(s, { fg: { title: 'Settings', process: 'SystemSettings' }, elements: [] });
    return s; // Chrome, which it opened
  };
  await g.agent.run('search youtube for study music and click the first', 'voice');
  assert.equal(last(g.sent, 'guide:bubble').kicker, 'done');

  const d = agentRig(['Clicking. [DO:click {"id": 1}]', 'Clicking again. [DO:click {"id": 1}] [DONE]']);
  const r2 = d.agent.d.read;
  let m = 0;
  d.agent.d.read = async () => { const s = await r2(); m++; if (m === 2) s.fg = { title: 'Program Manager', process: 'explorer' }; return s; };
  await d.agent.run('click it twice', 'typed');
  assert.equal(last(d.sent, 'guide:bubble').kicker, 'done', 'a flash of the desktop is not another app');
});

test('2026-10-29: a click by text that is not in the list says to use x,y, and the same failed action is never tried twice', async () => {
  const g = agentRig([
    'Clicking it. [DO:click {"text": "Nope Not Listed"}]',
    'Clicking it. [DO:click {"text": "Nope Not Listed"}]',
    'Clicking here. [DO:click {"x": 0.5, "y": 0.5}] [DONE]',
  ]);
  await g.agent.run('open the first video', 'typed');
  const failed = g.logs.filter((m) => m.startsWith('do click') && m.includes('FAILED'));
  assert.equal(failed.length, 1, 'the second identical click was not run: ' + JSON.stringify(g.logs));
  assert.ok(failed[0].includes('could not find a control called "Nope Not Listed"'), failed[0]);
  assert.ok(failed[0].includes('click by x and y'), failed[0]);
  assert.equal(g.r.hands.calls.filter((c) => c.op === 'mouse.click').length, 1, 'only the x,y click reached the mouse');
  assert.equal(last(g.sent, 'guide:bubble').kicker, 'done');
});

test('2026-10-31: Esc aborts the model request in flight instead of letting the reply run on', async () => {
  const g = agentRig([]);
  let seen = null;
  g.agent.d.llm = () => ({ ready: true, provider: 'test', complete(p) { seen = p.signal; return new Promise((_, reject) => { p.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); }); }); } });
  const run = g.agent.run('open the first video', 'typed');
  for (let i = 0; i < 40 && !seen; i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(seen && !seen.aborted, 'an abort signal reaches the model call');
  g.agent.stop('esc');
  assert.equal(seen.aborted, true, 'stop aborts it');
  await run;
  assert.equal(g.agent.status().state, 'idle');
});

test('2026-11-01 security: the file-search query never reaches the command line, and only paths inside the roots are reported', async () => {
  const { createFileSearch, cleanFileQuery, FILE_SEARCH_SCRIPT } = require('../src/hands/actions');
  const calls = [];
  const home = require('node:path').join('C:', 'Users', 'x');
  const inside = require('node:path').join(home, 'Documents', 'lab 3.pdf');
  const outside = require('node:path').join('C:', 'Windows', 'System32', 'evil.txt');
  const execFile = (file, args, opts, cb) => { calls.push({ file, args, opts }); cb(null, inside + '|2026-10-01' + String.fromCharCode(10) + outside + '|2026-10-02' + String.fromCharCode(10)); };
  const search = createFileSearch({ homedir: home, execFile, env: {} });
  const nasty = 'x; Write-Output MARK; #';
  const hits = await search(nasty, { kind: 'document', max: 8 });
  assert.equal(calls.length, 1);
  const argv = calls[0].args;
  assert.equal(argv[argv.indexOf('-Command') + 1], FILE_SEARCH_SCRIPT, 'the command text is the constant script');
  assert.equal(argv.length, argv.indexOf('-Command') + 2, 'nothing follows the script on the command line');
  assert.ok(argv.every((a) => !a.includes('MARK')), 'the query is not in argv');
  assert.equal(calls[0].opts.env.NUS_FS_QUERY, nasty, 'the query rides in the environment');
  assert.ok(FILE_SEARCH_SCRIPT.includes('WildcardPattern]::Escape'), 'wildcards in the query are escaped');
  assert.ok(FILE_SEARCH_SCRIPT.includes('-LiteralPath'), 'roots are literal paths');
  assert.deepEqual(hits.map((h) => h.name), ['lab 3.pdf'], 'a path outside the home folders is dropped');
  assert.equal(cleanFileQuery('a' + String.fromCharCode(0) + 'b' + String.fromCharCode(7) + 'c'), 'a b c');
  assert.equal(cleanFileQuery('x'.repeat(500)).length, 120);
  assert.deepEqual(await search('   ', {}), [], 'an empty query runs nothing');
  assert.equal(calls.length, 1);
});

test('2026-11-01 security: a yes from the open mic, or heard before the card, needs the button; the talk key still approves', async () => {
  const consent = require('../src/hands/consent');
  let t = 1000;
  const p = consent.createPending({ now: () => t });
  const a = p.ask({ title: 'Send?', firm: false }, { name: 'click' }, {});
  assert.equal(p.spoken('yeah', { roomMic: true }), 'needs-button', 'room audio is not the user');
  assert.equal(p.spoken('yeah', { heardAt: 999 }), 'needs-button', 'words from before the card');
  assert.equal(p.spoken('yeah', { roomMic: false, heardAt: 1001 }), 'yes', 'push to talk after the card still approves');
  assert.deepEqual(await a, { answered: true, yes: true, how: 'voice' });
});

test('2026-11-01 security L1: open_file on a program and Enter in a message window ask first; documents and search boxes do not', () => {
  const run = consent.preview({ name: 'open_file', args: { index: 1 } }, { fileName: 'setup tool.exe' });
  assert.ok(run && run.firm, 'a program through open_file gets the same firm card as open_app');
  assert.ok(consent.preview({ name: 'open_file', args: { index: 1 } }, { fileName: 'notes.lnk' }).firm, 'a shortcut runs whatever it points at');
  assert.equal(consent.preview({ name: 'open_file', args: { index: 1 } }, { fileName: 'lab 3.pdf' }), null, 'documents open without a card');
  assert.equal(consent.preview({ name: 'open_file', args: { index: 1 } }, {}), null, 'no name, no card');
  const enter = consent.preview({ name: 'press', args: { keys: 'enter' } }, { windowTitle: 'general - Discord' });
  assert.ok(enter && !enter.firm, 'Enter on its own in a chat window sends what a type step put there');
  assert.ok(consent.preview({ name: 'press', args: { keys: 'Return' } }, { fieldName: 'Message', windowTitle: '' }), 'by the field name too');
  assert.equal(consent.preview({ name: 'press', args: { keys: 'enter' } }, { windowTitle: 'Lab 3 - Canvas' }), null, 'Enter in a search or a form is not carded');
  assert.equal(consent.preview({ name: 'press', args: { keys: 'ctrl+a' } }, { windowTitle: 'Discord' }), null);
  // cardFor hands the card the names it needs: the type box by text_target
  // (its text is the words), the file by its index in the last search.
  const g = agentRig([]);
  const elements = ELEMENTS.concat([{ id: 8, name: 'Message #general', type: 'Edit', rect: { x: 100, y: 700, w: 400, h: 30 } }]);
  const typed = g.agent.cardFor({ name: 'type', args: { text: 'hello everyone', text_target: 'Message #general', submit: true } }, { elements, fg: { title: 'Discord' } });
  assert.ok(typed, 'the message box is found by text_target, so the send card shows');
  assert.equal(g.agent.cardFor({ name: 'type', args: { text: 'hello everyone', text_target: 'Comment', submit: false } }, { elements, fg: { title: 'Canvas' } }), null);
  const files = [{ name: 'lab 3.pdf' }, { name: 'installer.exe' }];
  const opened = g.agent.cardFor({ name: 'open_file', args: { index: 2 } }, { elements, fg: { title: 'Explorer' }, files });
  assert.ok(opened && opened.firm && /installer\.exe/.test(opened.title));
  assert.equal(g.agent.cardFor({ name: 'open_file', args: { index: 1 } }, { elements, fg: { title: 'Explorer' }, files }), null);
});

test('2026-11-01 security L4: the paste fallback never retypes text with a line break (SendKeys would press Enter)', () => {
  const ps = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'reflex', 'hands.ps1'), 'utf8');
  const guard = '$t -match "[' + String.fromCharCode(92) + 'r' + String.fromCharCode(92) + 'n]"';
  const body = ps.slice(ps.indexOf("'keys.text' {"), ps.indexOf('return @{ ok=$true; chars=$t.Length'));
  assert.equal(body.split('SendKeys]::SendWait(').length - 1, 2, 'two retype branches: unconfirmed paste and failed clipboard');
  assert.ok(body.includes('if ($verified -eq $false -and ' + guard + ')'), 'the unconfirmed paste branch is gated');
  assert.ok(body.includes('if (-not $pasted -and ' + guard + ')'), 'the failed clipboard branch is gated');
  assert.ok(body.indexOf(guard) < body.indexOf('SendKeys]::SendWait('), 'the guard comes before the first retype');
  assert.ok(body.includes('$before = Read-FocusedText') && body.includes('$v -ne $before'), 'a box that changed is not retyped either');
});

test('a follow-up within two minutes of a finished run is the same task; later, or after a stop, it is not', async () => {
  const { fieldFollowUp } = require('../src/reflex/rules');
  for (const said of ['Enter the recipient as pranav@gmail.com', 'put the subject as Demo Update', 'add Lee to cc', 'Change the body to the demo is Friday.', 'Set the subject line to Hello', 'the subject should be Hello', 'cc my professor', 'please add a subject', 'Can you put Hello in the subject?', 'address it to Lee', 'enter pranav@gmail.com as the recipient', 'Recipient is Lee.']) assert.equal(fieldFollowUp(said), true, said);
  for (const said of ['type hello', 'enter my name', 'where is the subject field', 'how do I add someone to cc', 'open notepad', 'make this shorter', 'add milk to the list', 'the demo is Thursday', 'put it on the left', 'change the volume', 'write my to-do list', '']) assert.equal(fieldFollowUp(said), false, said);

  const clock = { t: 1000 };
  const g = agentRig(['Opened the draft. [DONE]', 'Filled it in. [DONE]'], { clock });
  const turns = [], base = g.agent.d.llm;
  g.agent.d.llm = () => { const l = base(); return Object.assign({}, l, { complete(p) { turns.push(p.turns[p.turns.length - 1].text); return l.complete(p); } }); };
  await g.agent.run('draft an email saying the demo is Thursday', 'voice');
  assert.equal(g.agent.canFollowUp(), true);
  assert.equal(g.agent.canResume(), false, '"keep going" is for a run that ran out of steps');
  await g.agent.followUp('enter the recipient as lee@nus.edu', 'voice');
  const turn = turns[turns.length - 1];
  assert.match(turn, /Goal: draft an email saying the demo is Thursday\. Now also: enter the recipient as lee@nus\.edu/);
  assert.match(turn, /The user said: enter the recipient as lee@nus\.edu/);
  assert.match(turn, /So far/, 'it knows what was done');

  clock.t += 121000;
  assert.equal(g.agent.canFollowUp(), false, 'two minutes on, the words are about something else');
  assert.equal(await g.agent.followUp('add Lee to cc', 'voice'), false);
});

test('a field follow-up is routed before the reflex layer, the open mic never takes it, and partials do not fire it', () => {
  const main = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.js'), 'utf8');
  const route = main.slice(main.indexOf('async function routeUtterance('), main.indexOf('function routeUtteranceSlow('));
  assert.ok(route.indexOf('if (handsFollowUp(text))') > 0 && route.indexOf('if (handsFollowUp(text))') < route.indexOf('getReflex()'), 'ahead of the reflex layer');
  assert.ok(route.indexOf('if (handsFollowUp(text))') < route.indexOf('if (handsClaims(text))'), 'ahead of a new Hands task');
  assert.match(main, /agent\.followUp\(text, source === 'typed' \? 'typed' : 'voice', \{ askedAt: heardAt \}\)/);
  assert.match(main, /function handsFollowUp\(text\) \{ return Boolean\(handsOn\(\) && agent && !agent\.active\(\) && !OPEN_MIC && agent\.canFollowUp\(\) && fieldFollowUp\(text\)\); \}/);
  assert.match(main, /!handsClaims\(text\) && !handsFollowUp\(text\) && !\(agent && agent\.active\(\)\)\) getReflex\(\)\.handle\(text, \{ final: false/);
});
