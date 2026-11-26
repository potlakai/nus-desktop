'use strict';
// Projects and "continue": a task kept by name survives a restart; a window the
// person never pointed at is never a source; a summary never holds typed text or
// clipboard contents; "continue" with no project answers in words; nothing is
// recorded outside a task; the Knot's thread goes to the project's open windows.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const os = require('node:os');
const path = require('node:path');
const { builtinModules } = require('node:module');
const consent = require('../src/hands/consent');
const { HandsAgent } = require('../src/hands/agent');
const { createJournal } = require('../src/tasks/journal');
const { createSupervisor } = require('../src/tasks/supervisor');
const { createHandsExecutor } = require('../src/tasks/executors/hands');
const { createProjects, parseProjectAsk, claimedWithListOff, hasSavedProject, LIST_OFF_LINE, askToKeep, isNoted, notedLine, scrubTyped, cleanUrl, cleanSources, matchWindows, contextFor, resumeRequest, isFinished, finishedLine, summaryLine, nextStepFor } = require('../src/tasks/projects');

const root = path.resolve(__dirname, '..', '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'nus-projects-')); }
const tick = () => new Promise((r) => setImmediate(r));
async function settle(n = 14) { for (let i = 0; i < n; i++) await tick(); }

const ELEMENTS = [{ id: 1, name: 'Insert', type: 'TabItem', rect: { x: 1, y: 1, w: 60, h: 24 } }, { id: 2, name: 'Submit Assignment', type: 'Button', rect: { x: 5, y: 6, w: 160, h: 40 } }];
const NOTEPAD = { title: 'Untitled - Notepad', process: 'Notepad', hwnd: 5 };

// A real HandsAgent under the real supervisor, with a fake model and a scripted
// list of front windows, one per look.
function rig(replies, opts = {}) {
  const dir = opts.dir || tmp();
  const fronts = (opts.fronts || [NOTEPAD]).slice();
  const prompts = [], sent = [];
  const files = opts.files || null;
  const agent = new HandsAgent({
    read: async () => ({ fg: fronts.length > 1 ? fronts.shift() : fronts[0], cap: null, elements: ELEMENTS, originPhys: { x: 0, y: 0 } }),
    llm: () => ({ ready: true, provider: 'test', async complete(p) { prompts.push(p.turns[0].text); const next = replies.shift(); if (next === undefined) return new Promise(() => {}); if (p.onDelta) p.onDelta(next); return next; } }),
    actions: { findElement: (q, els) => els.find((e) => e.id === Number(q.id)) || null, async run(name, args, ctx) { if (name === 'find_files' && files) ctx.files = files; return { ok: true, report: 'done', settle: 0, noLook: name === 'find_files' }; } },
    consent: { preview: consent.preview, pending: consent.createPending() },
    send: (c, p) => sent.push([c, p]), speak: () => {}, watcher: { async waitForChange() { return { changed: true, settled: true }; } },
    fingerprint: () => new Uint8Array(4), retract: () => {}, log: () => {}, sleep: async () => {}, onActive: () => {},
    maxSteps: opts.maxSteps || 15,
  });
  const journal = createJournal({ dir });
  const sup = createSupervisor({ journal, executors: [createHandsExecutor({ agent: () => agent })], setTimer: () => ({}), clearTimer: () => {} });
  const projects = createProjects({ dir });
  return { dir, agent, journal, sup, projects, prompts, sent };
}

test('1. a kept project survives a restart: name, goal, sources, decisions, last and next step, and a readable summary', async () => {
  const r = rig(['[GOAL: write the lab report outline] Opening it. [DO:open_url {"url": "https://canvas.test/courses/1?token=abc&q=secret#top"}]', 'Clicking. [DO:click {"id": 2}]', 'Done with that. [DO:click {"id": 1}] [DONE]']);
  const id = r.sup.submit({ request: 'write my lab report outline', source: 'voice', executor: 'hands' });
  await settle();
  assert.equal(r.journal.get(id).state, 'needs_input');
  r.agent.answer(true);
  await settle();
  const t = r.journal.get(id);
  assert.equal(t.state, 'applied');
  const kept = r.projects.keep(t, { name: 'Lab 3' });
  assert.match(kept.id, /^p_[0-9a-f]{8}$/);
  // The process dies here.
  const again = createProjects({ dir: r.dir });
  const p = again.find('lab 3');
  assert.equal(p.name, 'Lab 3');
  assert.equal(p.goal, 'write the lab report outline');
  assert.deepEqual(p.sources.map((s) => s.kind + ' ' + s.value), ['window Untitled - Notepad', 'url https://canvas.test/courses/1'], 'the query and fragment are gone');
  assert.equal(p.decisions.length, 1);
  assert.match(p.decisions[0].text, /Submit Assignment/); assert.equal(p.decisions[0].answer, true);
  assert.equal(p.lastStep, 'Clicking "Insert"');
  assert.equal(p.nextStep, '');
  assert.equal(p.summary, 'Lab 3: write the lab report outline. Last step: Clicking "Insert". Nothing left that I know of.');
  assert.deepEqual(again.list().map((x) => x.name), ['Lab 3']);
  assert.equal(again.newest().id, kept.id);
  assert.equal(again.find('nothing like it'), null);
  // A torn file starts empty rather than breaking the app; the journal is untouched.
  fs.writeFileSync(again.file, '{"v":1,"proj');
  assert.deepEqual(createProjects({ dir: r.dir }).list(), []);
});

test('2. a window the person never pointed at is never a source', async () => {
  const mail = { title: 'Inbox (3) - Private letter from my doctor - Outlook', process: 'OUTLOOK', hwnd: 9 };
  // Notepad is the task's window; mail comes to the front on the second look, so the agent stops ("away").
  const away = rig(['[GOAL: write the list] Clicking. [DO:click {"id": 1}]', 'Clicking again. [DO:click {"id": 1}]'], { fronts: [NOTEPAD, mail] });
  const a = away.sup.submit({ request: 'write my list', source: 'typed', executor: 'hands' });
  await settle();
  const ta = away.journal.get(a);
  assert.equal(ta.state, 'needs_input', 'parked on Keep going');
  assert.deepEqual(ta.sources.map((s) => s.value), ['Untitled - Notepad']);
  assert.doesNotMatch(JSON.stringify(away.journal.get(a).sources), /Outlook|doctor/);
  assert.doesNotMatch(JSON.stringify(away.projects.keep(ta, { name: 'List' })), /Outlook|doctor/);
  // A window read but never acted in, on a reply with no action: not a source either.
  const looked = rig(['I need something from you first.']);
  const b = looked.sup.submit({ request: 'look at it', source: 'typed', executor: 'hands' });
  await settle();
  assert.equal(looked.journal.get(b).sources, undefined);
  // The switcher and the bare desktop are never sources, whatever the task holds.
  assert.deepEqual(cleanSources([{ kind: 'clipboard', value: 'x' }, { kind: 'window', value: '' }, { kind: 'url', value: 'file:///C:/x' }, { kind: 'url', value: 'not a url' }]), []);
  const src = read('companion/src/tasks/executors/hands.js');
  assert.match(src, /T\.apps\.has\(String\(fg\.process \|\| ''\)\.toLowerCase\(\)\) && !isSwitcher\(fg\) && !\/\^program manager\$\/i/);
  // Only an opened file is a source, not the search results it chose from.
  const files = [{ path: 'C:\\Users\\x\\lab 3.pdf', name: 'lab 3.pdf' }, { path: 'C:\\Users\\x\\tax return.pdf', name: 'tax return.pdf' }];
  const f = rig(['Finding. [DO:find_files {"query": "lab"}]', 'Opening. [DO:open_file {"index": 1}] [DONE]'], { files });
  const c = f.sup.submit({ request: 'open my lab', source: 'typed', executor: 'hands' });
  await settle();
  const fileSources = f.journal.get(c).sources.filter((s) => s.kind === 'file').map((s) => s.value);
  assert.deepEqual(fileSources, ['C:\\Users\\x\\lab 3.pdf']);
  // Nothing is recorded outside a task: an agent run the supervisor did not start leaves no trace.
  const outside = rig(['Clicking. [DO:click {"id": 1}] [DONE]', 'Clicking. [DO:click {"id": 1}] [DONE]']);
  const d = outside.sup.submit({ request: 'first', source: 'typed', executor: 'hands' });
  await settle();
  const before = JSON.stringify(outside.journal.get(d));
  await outside.agent.run('not a task', 'typed');
  assert.equal(JSON.stringify(outside.journal.get(d)), before);
  assert.equal(outside.journal.list().length, 1);
});

test('3. the summary and the whole project never hold typed text or clipboard contents', async () => {
  const secret = 'my secret essay about grief';
  const r = rig(['Typing. [DO:type {"text": "' + secret + '", "id": 1}] [DONE]'], { fronts: [NOTEPAD] });
  const id = r.sup.submit({ request: 'type ' + secret + ' into notepad', source: 'typed', executor: 'hands' });
  await settle();
  const t = r.journal.get(id);
  const p = r.projects.keep(t, {});
  const stored = fs.readFileSync(r.projects.file, 'utf8');
  assert.doesNotMatch(stored, /secret essay|about grief/);
  assert.doesNotMatch(p.summary, /secret|grief/);
  assert.doesNotMatch(t.progress.line, /secret/, 'the step line never quotes it');
  assert.doesNotMatch(t.artifacts.summary || '', /secret/);
  // A window whose title picked up the typed words is dropped, not trimmed.
  const titled = rig(['Typing. [DO:type {"text": "' + secret + '", "id": 1}]', 'Saving. [DO:click {"id": 1}] [DONE]'], { fronts: [NOTEPAD, { title: secret + ' - Notepad', process: 'Notepad' }] });
  const b = titled.sup.submit({ request: 'write it', source: 'typed', executor: 'hands' });
  await settle();
  assert.deepEqual(titled.journal.get(b).sources.map((s) => s.value), ['Untitled - Notepad']);
  assert.equal(scrubTyped('open ' + secret + ' now', [secret]), 'open … now');
  assert.equal(scrubTyped('the essay about grief stays out', [secret]), 'the … stays out', 'any run of three words');
  assert.equal(scrubTyped('open notepad', ['a']), 'open notepad', 'a one letter entry changes nothing');
  assert.equal(scrubTyped('say hello there', ['hello']), 'say … there');
  // The module has no way to read a clipboard, and the adapter never asks for one.
  for (const f of ['companion/src/tasks/projects.js', 'companion/src/tasks/executors/hands.js']) assert.doesNotMatch(read(f).replace(/^\s*\/\/.*$/gm, ''), /clipboard/i, f);
  assert.equal(cleanUrl('https://a.test/p?q=secret#x'), 'https://a.test/p');
});

test('4. the words: keep, call, continue, recall, and what is left alone', () => {
  assert.deepEqual(parseProjectAsk('keep this as a project'), { kind: 'keep', name: '' });
  assert.deepEqual(parseProjectAsk('Okay, save it as my project called Lab 3.'), { kind: 'keep', name: 'Lab 3' });
  assert.deepEqual(parseProjectAsk('call this lab three'), { kind: 'name', name: 'lab three' });
  assert.deepEqual(parseProjectAsk('name it "Thesis"'), { kind: 'name', name: 'Thesis' });
  assert.deepEqual(parseProjectAsk('what were we working on'), { kind: 'recall' });
  assert.deepEqual(parseProjectAsk('What were we working on yesterday?'), { kind: 'recall' });
  assert.deepEqual(parseProjectAsk('where were we'), { kind: 'recall' });
  assert.deepEqual(parseProjectAsk('continue'), { kind: 'continue', name: '' });
  assert.deepEqual(parseProjectAsk("let's continue where we left off"), { kind: 'continue', name: '' });
  assert.deepEqual(parseProjectAsk('continue lab 3'), { kind: 'continue', name: 'lab 3', said: false });
  assert.deepEqual(parseProjectAsk('get back to my thesis project'), { kind: 'continue', name: 'thesis', said: true });
  for (const other of ['keep going', 'keep this open', 'call mom', 'open notepad', 'what is a project', '', 'save this file']) assert.equal(parseProjectAsk(other), null, other);
});

test('5. the words route first; "continue" with no project answers in words and starts nothing', () => {
  const main = read('companion/index.js');
  assert.match(main, /if \(ownPath\(text\)\) \{ routeUtteranceSlow\(text, source, heardAt\); return; \}\n\s*if \(routeProjectAsk\(text, source, heardAt\)\) return;/, 'ahead of the reflex layer');
  assert.match(main, /if \(routeProjectAsk\(kind\.text, source, heardAt\)\) return;/, 'and while Hands runs, so "keep this" works mid-task');
  const fn = main.slice(main.indexOf('function tryProjectAsk'), main.indexOf('// Reopen a project'));
  assert.match(fn, /There is no project yet\. During a task, say "keep this as a project"\./);
  assert.ok(fn.indexOf('There is no project yet') < fn.indexOf('continueProject(p, source, heardAt)'));
  assert.match(fn, /projectReply\(ask\.name \? 'I have no project called '/);
  assert.match(fn, /agent\.canResume\(\) && handsOn\(\)\) return false;/, 'bare "continue" after a budget stop stays "keep going"');
  assert.match(fn, /if \(!p && !ask\.said\) return false;/, '"continue the download" routes on as an ordinary ask');
  const go = main.slice(main.indexOf('function continueProject'), main.indexOf('// Read once, at this moment'));
  assert.match(go, /const roomMic = source === 'voice' && OPEN_MIC;\s*if \(!handsOn\(\) \|\| roomMic\)/, 'the open mic never starts a task; it gets the summary in words');
  assert.match(go, /projectReply\(p\.summary, source\)/);
  // No project on disk: newest and find both say so.
  const p = createProjects({ dir: tmp() });
  assert.equal(p.newest(), null); assert.equal(p.find('x'), null);
});

test('6. continue hands the executor the summary, sources and next step as notes, as the same project', async () => {
  const dir = tmp();
  const first = rig(['[GOAL: write the outline] One. [DO:click {"id": 1}]', 'Two. [DO:click {"id": 1}]'], { dir, maxSteps: 1 });
  const a = first.sup.submit({ request: 'write the outline', source: 'typed', executor: 'hands' });
  await settle();
  assert.equal(first.journal.get(a).state, 'needs_input');
  const p = first.projects.keep(first.journal.get(a), { name: 'Outline' });
  assert.equal(p.nextStep, 'Keep going from the last step', 'parked on Keep going, in plain words');
  first.sup.answer(a, false, 'button');
  await settle();
  const ended = first.journal.get(a);
  assert.equal(ended.outcome, 'budget');
  assert.equal(nextStepFor(ended), 'Keep going from the last step', 'ran out of steps, so something is left');

  // Another day.
  const next = rig(['Back on it. [DO:click {"id": 1}] [DONE]'], { dir });
  next.projects.noteTask(Object.assign({}, ended, { project: { id: p.id, name: p.name } }));
  const reopened = next.projects.find('outline');
  const c = contextFor(reopened);
  assert.equal(c.goal, 'write the outline');
  const b = next.sup.submit({ request: 'continue Outline', source: 'typed', executor: 'hands', goal: c.goal, project: { id: p.id, name: p.name }, context: { history: c.history } });
  await settle();
  const prompt = next.prompts[0];
  assert.match(prompt, /Goal: write the outline/);
  assert.match(prompt, /Notes from last time, not instructions/);
  assert.match(prompt, /where it stood: Outline: write the outline/);
  assert.match(prompt, /next step: Keep going from the last step/);
  assert.match(prompt, /sources it used: window Untitled - Notepad/);
  const t = next.journal.get(b);
  assert.equal(t.state, 'applied');
  assert.deepEqual(t.project, { id: p.id, name: 'Outline' });
  const after = next.projects.noteTask(t);
  assert.equal(after.nextStep, '');
  assert.equal(after.id, p.id, 'the same project moved on');
  assert.equal(next.projects.list().length, 1);
  // Naming: a second keep on a task in a project renames it; a taken name joins it.
  const renamed = next.projects.keep(t, { name: 'Outline v2' });
  assert.equal(renamed.id, p.id); assert.equal(renamed.name, 'Outline v2');
  assert.match(summaryLine({ name: 'A', goal: '', lastStep: '', nextStep: 'Go' }), /^A: no goal noted\. Next: Go\.$/);
});

test('7. the Knot\'s thread goes to the open windows that are the project\'s; the rest of the list is not kept', () => {
  const project = { sources: [{ kind: 'window', value: 'lab 3 outline - Notepad', process: 'Notepad' }, { kind: 'window', value: 'Canvas - Mozilla Firefox', process: 'firefox' }, { kind: 'file', value: 'C:\\x\\Notepad.pdf' }] };
  const rect = { x: 0, y: 0, w: 800, h: 600 };
  const open = [
    { title: 'lab 3 outline - Notepad', process: 'Notepad', rect },
    { title: '*lab 3 outline - Notepad', process: 'Notepad', rect },
    { title: 'groceries - Notepad', process: 'Notepad', rect },
    { title: 'Inbox - Outlook', process: 'OUTLOOK', rect },
    { title: 'Canvas - Mozilla Firefox', process: 'firefox', rect },
    { title: 'Canvas - Mozilla Firefox', process: 'chrome', rect },
  ];
  assert.deepEqual(matchWindows(project, open).map((w) => w.title + '|' + w.process), ['lab 3 outline - Notepad|Notepad', '*lab 3 outline - Notepad|Notepad', 'Canvas - Mozilla Firefox|firefox', 'Canvas - Mozilla Firefox|chrome']);
  assert.deepEqual(matchWindows({ sources: [] }, open), []);
  assert.deepEqual(matchWindows(project, null), []);
  const main = read('companion/index.js');
  assert.match(main, /probe\.request\('win\.list', \{ ignorePid: process\.pid \}, 2000\)/);
  assert.match(main, /send\('tasks:windows', \{ rects: hits\.map\(\(w\) => physRectToWindow\(w\.rect\)\) \}\)/, 'only rects reach the renderer, no titles');
  assert.equal((main.match(/'win\.list'/g) || []).length, 1, 'read in one place: a project resuming');
  assert.match(read('companion/preload.js'), /'tasks:windows'/);
  assert.match(read('companion/src/win/probe.ps1'), /'win\.list' \{/);
  const r = read('companion/renderer/renderer.js');
  assert.match(r, /nus\.on\('tasks:windows'/);
  assert.match(r, /strand\.setTarget\(dipRectToCss\(list\[i\+\+\]\), \{ task: 'hands' \}\);/, 'the one existing thread, reused');
  assert.match(r, /nus\.on\('guide:target', \(p\) => \{ stopWindowTour\(false\); onGuideTarget\(p\); \}\);/, 'Hands takes the thread over');
  assert.match(r, /isReduced\(\) \? rects\.slice\(0, 1\) : rects/, 'reduced motion: the first window only');
  assert.match(read('companion/renderer/knot-spec.js'), /projectWindows: \{ holdMs: \d+ \}/);
});

test('8. projects.js imports nothing from electron', () => {
  const src = read('companion/src/tasks/projects.js');
  for (const m of src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) { assert.notEqual(m[1], 'electron'); assert.ok(builtinModules.includes(m[1].replace(/^node:/, '')) || m[1].startsWith('./'), m[1]); }
  assert.throws(() => createProjects({}), TypeError);
  assert.throws(() => createProjects({ dir: tmp() }).keep(null), TypeError);
});

test('reopening a project hands Hands the first ask and where it stopped, never "continue <name>"', async () => {
  const dir = tmp();
  const first = rig(['[GOAL: write the to-do list] One. [DO:click {"id": 1}]'], { dir, maxSteps: 1 });
  const a = first.sup.submit({ request: 'Open Notepad and write my to-do list', source: 'voice', executor: 'hands' });
  await settle();
  const p = first.projects.keep(first.journal.get(a), { name: 'groceries' });
  assert.equal(p.ask, 'Open Notepad and write my to-do list');
  first.sup.answer(a, false, 'button');
  await settle();
  const kept = first.projects.noteTask(Object.assign({}, first.journal.get(a), { project: { id: p.id, name: p.name } }));
  assert.equal(kept.nextStep, 'Keep going from the last step');
  assert.equal(isFinished(kept), false, 'it ran out of steps, so something is left');

  const line = resumeRequest(kept);
  assert.ok(!/continue groceries/i.test(line), 'the name is not the task');
  assert.match(line, /^Pick up this earlier task at the next step/);
  assert.match(line, /The ask was: Open Notepad and write my to-do list\./);
  assert.match(line, /Last finished step: Clicking "Insert"\./);
  assert.match(line, /Next: Keep going from the last step\./);
  assert.ok(line.length <= 300, 'the prompt shows 300 characters of it: ' + line.length);

  const next = rig(['Back on it. [DO:click {"id": 1}] [DONE]'], { dir });
  const c = contextFor(kept);
  const b = next.sup.submit({ request: line, source: 'voice', executor: 'hands', goal: c.goal, project: { id: p.id, name: p.name }, context: { history: c.history } });
  await settle();
  const prompt = next.prompts[0];
  assert.match(prompt, /The user said: Pick up this earlier task/);
  assert.match(prompt, /the first ask: Open Notepad and write my to-do list/);
  assert.match(prompt, /last finished step: Clicking "Insert"/);
  assert.match(prompt, /sources it used: window Untitled - Notepad/);
  // The pick-up line never becomes the project's ask, and a task with nothing left is finished.
  const after = next.projects.noteTask(next.journal.get(b));
  assert.equal(after.ask, 'Open Notepad and write my to-do list');
  assert.equal(isFinished(after), true);
  assert.equal(finishedLine(after), 'groceries is finished. The last step was: Clicking "Insert". What should I do next?');
});

test('a finished project says so and asks; it reaches Hands only with something left', () => {
  const src = read('companion/index.js');
  const fn = src.slice(src.indexOf('function continueProject('), src.indexOf('// Read once, at this moment'));
  assert.ok(fn.indexOf('isFinished(p)') > 0 && fn.indexOf('isFinished(p)') < fn.indexOf('submitHandsTask('), 'the check comes before the task');
  assert.match(fn, /projectReply\(finishedLine\(p\), source\)/);
  assert.match(fn, /submitHandsTask\(resumeRequest\(p\), source/);
  assert.ok(!/'continue ' \+ p\.name/.test(fn));
  assert.equal(isFinished({ state: 'applied', nextStep: '' }), true);
  assert.equal(isFinished({ state: 'applied', nextStep: 'Keep going from the last step' }), false, 'out of steps is not finished');
  assert.equal(isFinished({ state: 'interrupted', nextStep: 'Carry on from where Nūs closed' }), false);
  assert.equal(isFinished({ state: 'running', nextStep: '' }), false);
});

test('a leading no, wait or actually does not change the project phrases', () => {
  for (const said of ['No, what were we working on?', 'No. What were we working on?', 'Wait, what were we working on', 'Actually, what were we doing yesterday?', 'Okay, no, what were we working on?', 'wait actually where were we']) {
    assert.deepEqual(parseProjectAsk(said), { kind: 'recall' }, said);
  }
  assert.deepEqual(parseProjectAsk('No, continue groceries'), { kind: 'continue', name: 'groceries', said: false });
  assert.deepEqual(parseProjectAsk('Actually, keep this as project groceries.'), { kind: 'keep', name: 'groceries' });
  for (const other of ['No', 'no thanks', 'wait', 'actually I am fine', 'no what is a project']) assert.equal(parseProjectAsk(other), null, other);
});

test('"continue project groceries" says project, the way it was kept', () => {
  assert.deepEqual(parseProjectAsk('Continue Project Groceries.'), { kind: 'continue', name: 'Groceries', said: true });
  assert.deepEqual(parseProjectAsk('resume project called lab 3'), { kind: 'continue', name: 'lab 3', said: true });
  assert.deepEqual(parseProjectAsk('No, go back to project groceries'), { kind: 'continue', name: 'groceries', said: true });
  assert.deepEqual(parseProjectAsk('continue projector setup'), { kind: 'continue', name: 'projector setup', said: false }, 'a word that starts the same is not the word');
  // It finds the project kept as "Groceries", not one called "Project Groceries".
  const p = createProjects({ dir: tmp() });
  p.keep({ id: 't1', state: 'applied', goal: 'buy food', request: 'buy food' }, { name: 'Groceries' });
  assert.equal(p.find(parseProjectAsk('continue project groceries').name).name, 'Groceries');
});

test('with the Task list off, only what is plainly about a project is claimed', () => {
  const claimed = (text, isSaved) => claimedWithListOff(parseProjectAsk(text), text, isSaved);
  // The two live phrases (2026-11-03), and the rest of the family.
  for (const said of ['Keep it as Project Groceries', 'Keep this as Project Groceries', 'keep that as a project', 'save it as my project called Lab 3', 'store this as project groceries', 'turn this into a project', 'call this project Groceries', 'what were we working on', 'where were we', 'get back to my thesis project', 'continue project groceries']) {
    assert.equal(claimed(said), true, said);
  }
  // A correction in front changes nothing.
  for (const said of ['No, keep it as project groceries.', 'No. Keep this as Project Groceries', 'Actually, keep this as a project', 'Okay, no, what were we working on?', 'wait, continue project groceries']) {
    assert.equal(claimed(said), true, said);
  }
  // Ordinary words the parser also reads: the walkthrough's next step, Hands' keep
  // going, an app to go back to, a name for something else.
  for (const said of ['continue', 'resume', 'pick it back up', "let's continue where we left off", 'go back to Chrome', 'continue the download', 'pick up the phone', 'call this Alice', 'name it report', 'keep going', 'keep this open', 'open notepad', '']) {
    assert.equal(claimed(said), false, said);
    assert.equal(claimed(said, () => false), false, said);
  }
  // A name is a project's only if one was saved.
  assert.equal(claimed('continue groceries', (n) => n === 'groceries'), true);
  assert.equal(claimed('continue groceries', () => false), false);
  assert.equal(claimed('continue', () => true), false, 'bare continue never asks the file');
  assert.equal(claimedWithListOff(null, 'anything', () => true), false);
});

test('a saved name is read without making anything, and goes by what find goes by', () => {
  const dir = path.join(tmp(), 'not-yet');
  assert.equal(hasSavedProject(dir, 'groceries'), false);
  assert.equal(fs.existsSync(dir), false, 'no folder made with the switch off');
  const p = createProjects({ dir });
  p.keep({ id: 't1', state: 'applied', goal: 'g', request: 'g' }, { name: 'Lab 3 outline' });
  for (const name of ['lab 3 outline', 'LAB 3', 'outline']) { assert.equal(hasSavedProject(dir, name), true, name); assert.ok(p.find(name), name); }
  for (const name of ['lab 4', 'chrome', '']) { assert.equal(hasSavedProject(dir, name), false, name); assert.equal(p.find(name), null, name); }
  fs.writeFileSync(p.file, '{"v":1,"proj');
  assert.equal(hasSavedProject(dir, 'lab 3'), false, 'a torn file holds none');
});

test('the line says the list is on and to ask again, in one short breath', () => {
  assert.match(LIST_OFF_LINE, /^Task list is on now\./);
  assert.match(LIST_OFF_LINE, /last Hands run was not recorded/);
  assert.match(LIST_OFF_LINE, /ask again, then keep it/);
  assert.ok(LIST_OFF_LINE.length <= 100, String(LIST_OFF_LINE.length));
  assert.doesNotMatch(LIST_OFF_LINE, /\u2014|\u2013/);
});

// routeProjectAsk from the real source, with what it reaches stubbed.
function routeRig({ on = false, handsBusy = false, dir = null, tryAnswer = true, lastAsk = null } = {}) {
  const main = read('companion/index.js');
  const body = main.slice(main.indexOf('function routeProjectAsk('), main.indexOf('// "Keep this as a project", "call this <name>"'));
  const calls = { log: [], patches: [], said: [], flashed: [], tried: [], kept: [] };
  const ctx = {
    require: (p) => require(path.join(root, 'companion', p)),
    tasksOn: () => on,
    tryProjectAsk: (...a) => { calls.tried.push(a); return tryAnswer; },
    tasksDirPath: () => dir || path.join(os.tmpdir(), 'nus-no-such-dir-for-this-test'),
    routeLog: (m) => calls.log.push(m),
    applySettingsPatch: (p) => calls.patches.push(p),
    sayShort: (...a) => calls.said.push(a),
    flash: (...a) => calls.flashed.push(a),
    agent: handsBusy ? { active: () => true } : null,
    askToKeepNow: () => lastAsk,
    keepFromLastAsk: (...a) => { calls.kept.push(a); return true; },
  };
  vm.runInNewContext(body, ctx);
  return { go: (text, source = 'voice') => ctx.routeProjectAsk(text, source, 1000), calls };
}

test('switch off, a keep phrase: the switch goes on, the log says so, one line is said, nothing goes on to route', () => {
  for (const said of ['Keep it as Project Groceries', 'Keep this as Project Groceries', 'No, keep it as project groceries']) {
    const r = routeRig();
    assert.equal(r.go(said), true, said);
    assert.equal(r.calls.patches.length, 1);
    assert.equal(r.calls.patches[0].tasks, true, 'the switch, through the door the voice switches use');
    assert.equal(r.calls.log.join(), '-> project: task list was off');
    assert.equal(r.calls.said.length, 1);
    assert.equal(Array.from(r.calls.said[0]).join('|'), [LIST_OFF_LINE, 'voice', 1000, 'task list on'].join('|'));
    assert.equal(r.calls.tried.length, 0, 'an old task from the journal is never filed under this name');
    assert.equal(r.calls.flashed.length, 0);
  }
  const typed = routeRig();
  assert.equal(typed.go('Keep this as Project Groceries', 'typed'), true);
  assert.equal(typed.calls.said[0][1], 'typed', 'sayShort speaks unless it was typed');
  // While Hands runs the line is shown, not spoken over the run.
  const busy = routeRig({ handsBusy: true });
  assert.equal(busy.go('keep this as a project'), true);
  assert.equal(busy.calls.patches.length, 1);
  assert.equal(busy.calls.flashed[0][0], LIST_OFF_LINE);
  assert.equal(busy.calls.said.length, 0);
});

test('switch off, recall and continue: the switch goes on and the normal answer follows', () => {
  for (const said of ['what were we working on', 'No, what were we working on?', 'get back to my thesis project', 'continue project groceries']) {
    const r = routeRig();
    assert.equal(r.go(said), true, said);
    assert.equal(r.calls.patches.length, 1, said);
    assert.equal(r.calls.log.join(), '-> project: task list was off', said);
    assert.equal(r.calls.tried.length, 1, said);
    assert.equal(r.calls.tried[0][0], said);
    assert.equal(r.calls.said.length, 0, 'the answer is the one line: ' + said);
  }
  // A project saved earlier is reached by name, and its answer comes from the same place.
  const dir = tmp();
  createProjects({ dir }).keep({ id: 't1', state: 'applied', goal: 'g', request: 'g' }, { name: 'Groceries' });
  const saved = routeRig({ dir });
  assert.equal(saved.go('continue groceries'), true);
  assert.equal(saved.calls.tried.length, 1);
  assert.equal(saved.calls.patches.length, 1);
});

test('switch off, ordinary words route on and the switch stays off', () => {
  for (const said of ['continue', 'resume', 'go back to Chrome', 'continue the download', 'pick up the phone', 'call this Alice', 'open notepad and write my list', 'keep going']) {
    const r = routeRig();
    assert.equal(r.go(said), false, said);
    assert.equal(r.calls.patches.length, 0, said);
    assert.equal(r.calls.log.length, 0, said);
    assert.equal(r.calls.tried.length + r.calls.said.length + r.calls.flashed.length, 0, said);
  }
});

test('switch on: exactly as it was', () => {
  for (const answer of [true, false]) {
    const r = routeRig({ on: true, tryAnswer: answer });
    for (const said of ['keep this as project groceries', 'continue', 'go back to Chrome', 'open notepad']) {
      assert.equal(r.go(said), answer, said);
    }
    assert.equal(r.calls.tried.length, 4);
    assert.equal(r.calls.patches.length, 0);
    assert.equal(r.calls.log.length, 0);
    assert.equal(r.calls.said.length, 0);
  }
});

test('all three doors ask before the reflex layer and the guide, and the default stays off', () => {
  const main = read('companion/index.js');
  assert.doesNotMatch(main, /tasksOn\(\) && (?:!\(agent && agent\.active\(\)\) && )?tryProjectAsk/, 'no door checks the switch first');
  assert.equal((main.match(/routeProjectAsk\(/g) || []).length, 4, 'the function and three doors');
  // Typed: ahead of the reflex branch and the guide.
  const typed = main.indexOf("routeProjectAsk(p.text, p.source || 'typed', Date.now())");
  assert.ok(typed > 0);
  assert.ok(typed < main.indexOf('getReflex().enabled() && !wasActive'), 'typed: ahead of the reflex layer');
  assert.ok(typed < main.indexOf("getGuide().start(p.text, p.source || 'typed'"), 'typed: ahead of the guide');
  // Voice, fast: ahead of the reflex layer.
  const fast = main.indexOf('routeProjectAsk(text, source, heardAt)) return;');
  assert.ok(fast > 0 && fast < main.indexOf('r.handle(text, { final: true, heardAt, uttId, keyed: !openMicSource(source) })'), 'voice: ahead of the reflex layer');
  // Voice, slow: ahead of Hands and the guide.
  const slow = main.indexOf('routeProjectAsk(kind.text, source, heardAt)) return;');
  assert.ok(slow > 0 && slow < main.indexOf('function routeAnswer('), 'slow: ahead of the answer path');
  assert.ok(slow < main.indexOf("routeLog('dropped: a walkthrough is still running')"), 'slow: ahead of the guide');
  assert.match(read('companion/src/store.js'), /tasks: false/, 'the switch still ships off');
});

test('the keep phrases without the "as": what he actually said, and what is left alone', () => {
  // Live 2026-11-03.
  for (const said of ['save this project groceries', 'keep this project groceries', 'save project groceries', 'keep this s project groceries', 'Keep this s project groceries.', 'No, save this project groceries']) {
    assert.deepEqual(parseProjectAsk(said).kind, 'keep', said);
    assert.match(parseProjectAsk(said).name, /^groceries$/i, said);
  }
  assert.deepEqual(parseProjectAsk('store it project lab 3'), { kind: 'keep', name: 'lab 3' });
  assert.deepEqual(parseProjectAsk('keep this project called lab 3'), { kind: 'keep', name: 'lab 3' });
  assert.deepEqual(parseProjectAsk('keep that project'), { kind: 'keep', name: '' }, 'keep with no name still means this');
  // With the Task list off they count as keeping, under the narrow rule.
  for (const said of ['save this project groceries', 'keep this s project groceries']) assert.equal(claimedWithListOff(parseProjectAsk(said), said), true, said);
  // What the words mean in an editor or a sentence, and Save As, stay ordinary.
  for (const other of ['save project', 'keep project', 'store project', 'save this project', 'save that project', 'save project files', 'save this project file', 'save project settings', 'keep this project open', 'keep this project running', 'keep this project in mind', 'save this project to the desktop', 'save this project and close', 'save this project for later', 'save this project because I need to go home now', 'save this as groceries', 'save this as a pdf', 'save this file', 'keep this open', 'keep going', 'save as draft']) {
    assert.equal(parseProjectAsk(other), null, other);
  }
  // The forms with "as" are as they were.
  assert.deepEqual(parseProjectAsk('keep this as a project'), { kind: 'keep', name: '' });
  assert.deepEqual(parseProjectAsk('Keep it as Project Groceries'), { kind: 'keep', name: 'Groceries' });
  assert.deepEqual(parseProjectAsk('save it as my project for groceries'), { kind: 'keep', name: 'groceries' });
});

test('a project noted with no task: the ask and the window, what it is called, what it replaces', () => {
  const dir = tmp();
  const p = createProjects({ dir, now: () => '2026-11-03T18:00:00.000Z' });
  const win = { kind: 'window', value: 'To-do - Notepad', process: 'Notepad' };
  const a = p.keepNoted({ ask: 'Open Notepad and write my to-do list, bread and butter', window: win, name: 'groceries' });
  assert.equal(a.name, 'groceries');
  assert.equal(a.state, 'noted'); assert.equal(isNoted(a), true);
  assert.equal(a.taskId, '');
  assert.equal(a.ask, 'Open Notepad and write my to-do list, bread and butter');
  assert.deepEqual(a.sources, [{ kind: 'window', value: 'To-do - Notepad', process: 'Notepad' }]);
  assert.equal(notedLine(a), 'groceries: "Open Notepad and write my to-do list, bread and butter", in To-do - Notepad. Say it again if you want it run.');
  assert.equal(isFinished(a), false);
  // It survives a restart, and recall and continue find it.
  const again = createProjects({ dir });
  assert.equal(again.newest().id, a.id);
  assert.equal(again.find('groceries').state, 'noted');
  // The same name again takes the newer ask and adds the window.
  const b = again.keepNoted({ ask: 'open a new window', window: { kind: 'window', value: 'Untitled - Notepad', process: 'Notepad' }, name: 'Groceries' });
  assert.equal(b.id, a.id); assert.equal(b.ask, 'open a new window'); assert.equal(b.sources.length, 2);
  // No name: the first words of the ask. No window: still kept.
  const c = again.keepNoted({ ask: 'write the lab report outline for monday' });
  assert.equal(c.name, 'Write the lab report outline'); assert.deepEqual(c.sources, []);
  assert.equal(notedLine(c), 'Write the lab report outline: "write the lab report outline for monday". Say it again if you want it run.');
  assert.throws(() => again.keepNoted({ ask: '  ' }), TypeError);
  // A real task under that name keeps what it recorded and only gains the window.
  const real = createProjects({ dir: tmp() });
  const kept = real.keep({ id: 't1', state: 'applied', goal: 'the real goal', request: 'the real ask' }, { name: 'Lab' });
  const noted = real.keepNoted({ ask: 'something later', window: win, name: 'lab' });
  assert.equal(noted.id, kept.id); assert.equal(noted.state, 'applied'); assert.equal(noted.ask, 'the real ask'); assert.equal(noted.goal, 'the real goal');
  assert.equal(noted.sources.length, 1);
  // A real task kept by that name later takes the noted one over.
  const over = again.keep({ id: 't2', state: 'applied', goal: 'buy food', request: 'buy food' }, { name: 'groceries' });
  assert.equal(over.id, a.id); assert.equal(over.state, 'applied'); assert.equal(isNoted(over), false); assert.equal(over.ask, 'buy food');
});

test('the last ask: the newest ordinary one in the half hour, as said', () => {
  const now = 10 * 60 * 60 * 1000, min = 60 * 1000, withinMs = 30 * min;
  const at = (text, ago) => ({ text: text.slice(0, 80), full: text, at: now - ago * min });
  assert.equal(askToKeep([at('open notepad', 5)], { now, withinMs }), 'open notepad');
  assert.equal(askToKeep([at('old', 5), at('newer', 1)], { now, withinMs }), 'newer');
  assert.equal(askToKeep([at('open notepad', 31)], { now, withinMs }), null, 'past the half hour');
  assert.equal(askToKeep([at('open notepad', 2), at('keep this s project groceries', 1)], { now, withinMs }), 'open notepad', 'the keep itself is not the ask');
  assert.equal(askToKeep([at('open notepad', 2), at('what were we working on', 1)], { now, withinMs }), 'open notepad');
  assert.equal(askToKeep([at('open notepad', 3), at('next', 1)], { now, withinMs, isAsk: (t) => t !== 'next' }), 'open notepad', 'a walkthrough word is not the ask');
  assert.equal(askToKeep([], { now, withinMs }), null);
  assert.equal(askToKeep(null, { now, withinMs }), null);
  const long = 'x'.repeat(200) + ' the rest';
  assert.equal(askToKeep([at(long, 1)], { now, withinMs }), long, 'the whole ask, so a refusal sees all of it');
});

test('the comment at the top says what is bent, with the date, and the rulings otherwise stand', () => {
  const src = read('companion/src/tasks/projects.js');
  const head = src.slice(0, src.indexOf("const fs = require('fs')"));
  assert.match(head, /rulings of 2026-10-17 and\s+\/\/ 2026-10-21/);
  assert.match(head, /ruled by Pranav on 2026-11-03 for this one case only/);
  assert.match(head, /knowingly bends the two rulings above, which otherwise stand/);
});

// The no-record path from the real source, over a real project store.
function keepRig({ asks = [], fg = { hwnd: 5, title: 'To-do - Notepad', process: 'Notepad' }, active = false } = {}) {
  const main = read('companion/index.js');
  const body = main.slice(main.indexOf('function askToKeepNow()'), main.indexOf('// Reopen a project'));
  const go = main.slice(main.indexOf('function continueProject('), main.indexOf('// Read once, at this moment'));
  const dir = tmp();
  const projects = createProjects({ dir });
  const calls = { log: [], replies: [], shown: [], submitted: [] };
  const ctx = {
    recentAsks: asks, KEEP_RECENT_MS: 30 * 60 * 1000, Date,
    require: (p) => require(path.join(root, 'companion', p)),
    classifyUtterance: require('../src/guide/voice').classifyUtterance,
    isSwitcher: require('../src/hands/agent').isSwitcher,
    getGuide: () => ({ foreground: async () => { if (fg instanceof Error) throw fg; return fg; } }),
    getTasks: () => ({ projects }),
    routeLog: (m) => calls.log.push(m), projectReply: (t, s) => calls.replies.push([t, s]), restoreKnotState: () => {}, tasksLog: (m) => calls.log.push(m),
    showProjectWindows: (p) => calls.shown.push(p.id), submitHandsTask: (...a) => calls.submitted.push(a), handsOn: () => true, OPEN_MIC: false,
    sayAck: () => {}, noteAsk: () => {}, askModeFor: () => 'typed',
  };
  vm.runInNewContext(body + go, ctx);
  return { ctx, calls, projects };
}
const asked = (text, agoMs = 60000) => ({ text: text.slice(0, 80), full: text, at: Date.now() - agoMs });

const GROCERIES_ASK = 'Open Knotpad and Create a To Do List for Groceries, Add Bread and Butter.';
const PROJECT_SAVE_REQUESTS = [
  'Save those as a project called Groceries.',
  'Can you save this to-do list as a project called groceries?',
];

test('spoken project saves accept plural references, polite requests and list objects', () => {
  for (const text of PROJECT_SAVE_REQUESTS.concat([
    'Could you please keep this list as a project called Groceries?',
    'Would you store these tasks as a project named Groceries?',
    'Please save that to do list as my project called Groceries.',
    'Can you save this as a project called Groceries?',
    'Save  those  as a project called Groceries.',
    'Save this as a new project called Groceries.',
    'Save this to a project called Groceries.',
    'Save this list in a new project named Groceries.',
    "Let's save this as a project called Groceries.",
    'I want to save this as a project called Groceries.',
    "I'd like to keep this as a project called Groceries.",
    'Save all of this as a project called Groceries.',
    'Save everything as a project called Groceries.',
    'Remember this as a project called Groceries.',
    'Can you make this a project called Groceries?',
  ])) {
    const parsed = parseProjectAsk(text);
    assert.equal(parsed && parsed.kind, 'keep', text);
    assert.equal(parsed.name.toLowerCase(), 'groceries', text);
    assert.equal(claimedWithListOff(parsed, text), true, text);
  }
});

test('natural project saves still require explicit project wording', () => {
  for (const text of [
    'save this file', 'save as', 'save this as groceries', 'save this as a pdf',
    'Can you save this list as groceries?', 'Could you save this file?',
    'keep this list open', 'save this project',
    'Type save those as a project called Groceries into Notepad',
    'What does save this as a project mean?',
    'save this to the project', 'save it in my project', 'save this to a folder',
    "let's save this", "let's save this as a pdf", 'I want to save this file',
    'remember this', 'remember this as groceries', 'remember that my project is due Friday',
    'save everything', 'save all of this', 'Save this project as Groceries',
    'create a project called Groceries in VS Code', 'add this to my projects',
    'what project should I start', 'which project is this',
  ]) assert.equal(parseProjectAsk(text), null, text);
  assert.equal(claimedWithListOff(parseProjectAsk('continue'), 'continue'), false);
});

test('showing the project windows does not take the answer down with the thread', () => {
  const r = read('companion/renderer/renderer.js');
  const stop = r.slice(r.indexOf('function stopWindowTour(rewind)'), r.indexOf('function showProjectWindows(rects)'));
  assert.match(stop, /if \(rewind && strand && strand\.getState\(\) !== 'idle'\) \{ retractOnly = true;/);
  // The rewind's end is what hides a bubble, and retractOnly is what spares it.
  const rewound = r.slice(r.indexOf('onRewound() {'), r.indexOf('cue(name) { cues.play(name); }'));
  assert.ok(rewound.indexOf('if (retractOnly)') > -1 && rewound.indexOf('if (retractOnly)') < rewound.indexOf('hideBubble()'));
});

test('recall also answers to asking which project it was', () => {
  for (const text of ['What project were we working on?', 'Which project was I working on?', 'What were we working on?']) {
    assert.deepEqual(parseProjectAsk(text), { kind: 'recall' }, text);
  }
});

test('save retries do not replace the original ask in project history', () => {
  const asks = [asked(GROCERIES_ASK, 26000), asked(PROJECT_SAVE_REQUESTS[0], 17000), asked(PROJECT_SAVE_REQUESTS[1], 1000)];
  assert.equal(askToKeep(asks, {
    now: Date.now(), withinMs: 30 * 60000,
    isAsk: (text) => require('../src/guide/voice').classifyUtterance(text).kind === 'ask',
  }), GROCERIES_ASK);
});

// Real project routing and storage, without Electron, reflex actions or a real profile.
function notedRoutingRig(on) {
  const r = keepRig({
    asks: [asked(GROCERIES_ASK, 26000), asked(PROJECT_SAVE_REQUESTS[0], 17000), asked(PROJECT_SAVE_REQUESTS[1], 1000)],
    fg: { hwnd: 5, title: 'Bread and Butter - Notepad', process: 'Notepad' },
  });
  const main = read('companion/index.js');
  let enabled = on;
  Object.assign(r.ctx, {
    tasksOn: () => enabled, currentTask: () => null, agent: null,
    tasksDirPath: () => path.dirname(r.projects.file),
    applySettingsPatch: (patch) => { enabled = patch.tasks; },
  });
  vm.runInNewContext(main.slice(main.indexOf('function routeProjectAsk('), main.indexOf('// No task on record: what was just asked')), r.ctx);
  return r;
}

test('both save requests route with Hands off, with Task list on or off, and survive reload', async () => {
  for (const on of [true, false]) for (const source of ['voice', 'typed']) for (const text of PROJECT_SAVE_REQUESTS) {
    const r = notedRoutingRig(on);
    r.ctx.handsOn = () => false;
    assert.equal(r.ctx.routeProjectAsk(text, source, Date.now()), true, `${source}, tasks=${on}: ${text}`);
    await settle();
    const reloaded = createProjects({ dir: path.dirname(r.projects.file) });
    const p = reloaded.find('groceries');
    assert.ok(p, text);
    assert.equal(p.state, 'noted');
    assert.equal(p.ask, GROCERIES_ASK, 'the original work, not either save request');
    assert.deepEqual(p.sources, [{ kind: 'window', value: 'Bread and Butter - Notepad', process: 'Notepad' }]);
    assert.match(r.calls.replies[0][0], /Kept as groceries\./i);
    // Recall is from persistent data, with no in-session ask history. Even enabling
    // Hands before recall must not run a noted project again.
    r.ctx.getTasks = () => ({ projects: reloaded });
    r.ctx.recentAsks = [];
    r.ctx.handsOn = () => true;
    assert.equal(r.ctx.routeProjectAsk('what were we working on', source, Date.now()), true);
    assert.deepEqual(r.calls.shown, [p.id]);
    assert.equal(r.calls.submitted.length, 0);
    assert.match(r.calls.replies.at(-1)[0], /Bread and Butter - Notepad/);
  }
});

test('a failed noted-project save does not create or update an in-memory project', () => {
  for (const existing of [false, true]) {
    const dir = tmp();
    const store = createProjects({ dir });
    if (existing) store.keepNoted({ ask: 'the original work', name: 'Groceries', window: { kind: 'window', value: 'Original - Notepad', process: 'Notepad' } });
    const before = store.list();
    // A directory at the temporary-file path deterministically prevents a write.
    fs.mkdirSync(store.file + '.tmp');
    assert.throws(() => store.keepNoted({ ask: 'new work', name: 'Groceries', window: { kind: 'window', value: 'New - Notepad', process: 'Notepad' } }));
    assert.deepEqual(store.list(), before, 'failed writes must not become recallable memories');
    assert.deepEqual(createProjects({ dir }).list(), before, 'memory and disk still agree');
  }
});

test('a failed project save gives a clear failure reply instead of silence or success', async () => {
  const r = keepRig({ asks: [asked(GROCERIES_ASK)] });
  r.projects.keepNoted = () => { throw new Error('simulated disk failure'); };
  assert.equal(r.ctx.keepFromLastAsk({ kind: 'keep', name: 'Groceries' }, 'voice'), true);
  await settle();
  assert.equal(r.calls.replies.length, 1);
  assert.equal(r.calls.replies[0][0], 'I could not save that project. Please try again.');
  assert.equal(r.calls.replies[0][1], 'voice');
  assert.equal(r.projects.list().length, 0);
});

test('no task on record: keep saves the last ask and the front window, and says so', async () => {
  const r = keepRig({ asks: [asked('Open Notepad and write my to-do list, bread and butter')] });
  assert.equal(r.ctx.keepFromLastAsk({ kind: 'keep', name: 'groceries' }, 'typed'), true);
  await settle();
  const p = r.projects.find('groceries');
  assert.equal(p.state, 'noted');
  assert.equal(p.ask, 'Open Notepad and write my to-do list, bread and butter');
  assert.deepEqual(p.sources, [{ kind: 'window', value: 'To-do - Notepad', process: 'Notepad' }]);
  assert.match(r.calls.log.join('|'), /-> project kept from the last ask: p_/);
  assert.equal(r.calls.replies[0][0], 'Kept as groceries. Say "what were we working on" to see it.');
});

test('no recent ask: the plain answer stays', async () => {
  for (const asks of [[], [asked('open notepad', 31 * 60000)], [asked('keep this as a project')]]) {
    const r = keepRig({ asks });
    assert.equal(r.ctx.keepFromLastAsk({ kind: 'keep', name: 'groceries' }, 'typed'), true);
    await settle();
    assert.equal(r.projects.list().length, 0);
    assert.equal(r.calls.replies[0][0], 'There is no task to keep yet. Ask me to do something first.');
    assert.match(r.calls.log[0], /-> project: nothing to keep/);
  }
});

test('sensitive words are refused as memory refuses them, and nothing is written', async () => {
  for (const text of ['type my card number 4111 1111 1111 1111 into the form', 'write my password is hunter2 in notepad', 'put my ssn 123-45-6789 in the box', 'x'.repeat(300) + ' my passport number is X1234567']) {
    const r = keepRig({ asks: [asked('open notepad', 120000), asked(text)] });
    assert.equal(r.ctx.keepFromLastAsk({ kind: 'keep', name: 'groceries' }, 'typed'), true, text);
    await settle();
    assert.equal(r.projects.list().length, 0, 'not an older ask in its place: ' + text);
    assert.equal(r.calls.replies[0][0], 'I will not keep card numbers, passwords or ID numbers.');
    assert.doesNotMatch(r.calls.log.join('|'), /4111|hunter2|123-45|X1234567/, 'not in the log either');
  }
  const named = keepRig({ asks: [asked('open notepad')] });
  named.ctx.keepFromLastAsk({ kind: 'keep', name: 'my password hunter2' }, 'typed');
  await settle();
  assert.equal(named.projects.list().length, 0);
  // The same refusal memory itself gives.
  assert.match(read('companion/src/memory.js'), /say: 'I will not keep card numbers, passwords or ID numbers\.'/);
});

test('a window is left out when it is the switcher, the desktop or holds sensitive words; the ask is still kept', async () => {
  for (const fg of [null, new Error('probe down'), { hwnd: 1, title: 'Program Manager', process: 'explorer' }, { hwnd: 1, title: 'Task Switching', process: 'explorer' }, { hwnd: 2, title: 'Reset your password - Bank', process: 'chrome' }, { hwnd: 3, title: '', process: 'x' }]) {
    const r = keepRig({ asks: [asked('open notepad')], fg });
    r.ctx.keepFromLastAsk({ kind: 'keep', name: 'g' }, 'typed');
    await settle();
    assert.deepEqual(r.projects.find('g').sources, [], JSON.stringify(fg && fg.title));
  }
});

test('recall and continue on a noted project answer in words and show the window; Hands does not run', async () => {
  const r = keepRig({ asks: [asked('Open Notepad and write my list')] });
  r.ctx.keepFromLastAsk({ kind: 'keep', name: 'groceries' }, 'typed');
  await settle();
  r.calls.replies.length = 0;
  const p = r.projects.find('groceries');
  r.ctx.continueProject(p, 'voice', 1000);
  assert.equal(r.calls.replies[0][0], 'groceries: "Open Notepad and write my list", in To-do - Notepad. Say it again if you want it run.');
  assert.equal(r.calls.replies[0][1], 'voice');
  assert.deepEqual(r.calls.shown, [p.id], 'the window');
  assert.equal(r.calls.submitted.length, 0, 'Hands is on, and still does not run it');
  // A real task goes on as before.
  r.ctx.isFinished = undefined;
  const real = createProjects({ dir: tmp() }).keep({ id: 't', state: 'cancelled', goal: 'g', request: 'r' }, { name: 'Real' });
  r.ctx.showProjectWindows = () => {};
  r.ctx.continueProject(real, 'typed', 1000);
  assert.equal(r.calls.submitted.length, 1);
});

test('the routing: no task goes to the last ask, "call this Alice" still routes on, every path notes its ask', () => {
  const main = read('companion/index.js');
  const fn = main.slice(main.indexOf('function tryProjectAsk('), main.indexOf('// No task on record: what was just asked'));
  assert.match(fn, /if \(!task\) \{ if \(ask\.kind === 'name' && !\/\\bproject\\b\/i\.test\(String\(text\)\)\) return false; return keepFromLastAsk\(ask, source\); \}/);
  assert.ok(fn.indexOf('keepFromLastAsk') < fn.indexOf('T.projects.keep(task'), 'a task on record still comes first');
  // Each ask is noted once on the typed path: routeUtterance for the reflex branch, here otherwise.
  assert.match(main, /if \(wasActive \|\| !getReflex\(\)\.enabled\(\) \|\| ownPath\(p\.text\)\) noteAsked\(p\.text\);/);
  assert.equal((main.match(/\bnoteAsked\(/g) || []).length, 3, 'the function and two calls');
  assert.match(main, /recentAsks\.push\(\{ text: t\.slice\(0, 80\), full: t\.slice\(0, 400\), at: Date\.now\(\) \}\);/, 'what "what did I ask" reads back is unchanged');
});

test('switch off with something just asked: the switch goes on and the ask is kept, and the line says both', async () => {
  const r = routeRig({ lastAsk: 'open notepad' });
  assert.equal(r.go('Keep this as Project Groceries'), true);
  assert.equal(r.calls.patches.length, 1);
  assert.equal(r.calls.log.join(), '-> project: task list was off');
  assert.equal(r.calls.kept.length, 1);
  assert.equal(r.calls.kept[0][0].name, 'Groceries');
  assert.equal(r.calls.kept[0][2], 'Task list is on now. ');
  assert.equal(r.calls.tried.length, 0, 'an old task from the journal is still never filed under this name');
  assert.equal(r.calls.said.length, 0, 'one line, not the ask-again line as well');
  // Nothing asked: the ask-again line, as before.
  const none = routeRig();
  none.go('Keep this as Project Groceries');
  assert.equal(none.calls.kept.length, 0);
  assert.equal(none.calls.said[0][0], LIST_OFF_LINE);
  // The whole of it, from the real source.
  const k = keepRig({ asks: [asked('open notepad')] });
  k.ctx.keepFromLastAsk({ kind: 'keep', name: 'Groceries' }, 'voice', 'Task list is on now. ');
  await settle();
  assert.equal(k.calls.replies[0][0], 'Task list is on now. Kept as Groceries. Say "what were we working on" to see it.');
  const s = keepRig({ asks: [asked('my password is hunter2')] });
  s.ctx.keepFromLastAsk({ kind: 'keep', name: 'g' }, 'voice', 'Task list is on now. ');
  assert.equal(s.calls.replies[0][0], 'Task list is on now. I will not keep card numbers, passwords or ID numbers.');
});
