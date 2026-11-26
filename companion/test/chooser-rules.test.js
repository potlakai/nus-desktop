'use strict';
// Phase 1f: the model-free fallbacks. The chooser picks a control by words and
// distance; the rules answer the reflex router's questions without a service.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chooseElement, heuristicAnswers, overlap } = require('../src/guide/chooser');
const { ruleAnswers, createRulesClient } = require('../src/reflex/rules');
const { decide, buildQuestions } = require('../src/reflex/router');
const { createFastPointer } = require('../src/guide/fastpoint');
const V = require('../src/guide/verify');

const els = [
  { id: 1, name: 'Insert', type: 'TabItem', rect: { x: 100, y: 40, w: 60, h: 24 } },
  { id: 2, name: 'Home', type: 'TabItem', rect: { x: 30, y: 40, w: 60, h: 24 } },
  { id: 3, name: 'Table', type: 'Button', rect: { x: 120, y: 90, w: 50, h: 40 } },
  { id: 4, name: 'Document body', type: 'Document', rect: { x: 0, y: 150, w: 1200, h: 800 } },
];

test('the chooser takes the control whose words match near the point, and refuses ties or far misses', () => {
  const pick = chooseElement('insert tab', { x: 135, y: 55 }, els);
  assert.equal(pick.element.id, 1);
  assert.equal(chooseElement('table button', { x: 140, y: 100 }, els).element.id, 3);
  assert.equal(chooseElement('zzz', { x: 135, y: 55 }, els), null, 'no words in common and only nearness is not enough');
  const twins = [{ id: 1, name: 'Save', type: 'Button', rect: { x: 100, y: 40, w: 60, h: 24 } }, { id: 2, name: 'Save', type: 'Button', rect: { x: 100, y: 70, w: 60, h: 24 } }];
  assert.equal(chooseElement('save', { x: 130, y: 67 }, twins), null, 'two equal candidates: keep the model\'s point');
  assert.equal(chooseElement('save', { x: 130, y: 55 }, twins).element.id, 1, 'nearness breaks a tie when the point sits on one of them');
  assert.equal(chooseElement('document', { x: 500, y: 500 }, els), null, 'a panel is never a target');
  assert.equal(overlap('the Insert tab', 'Insert'), 1);
});

test('the quick pointer without a classifier picks a control the task names, and nothing else', async () => {
  const fp = createFastPointer({ jev: { ready: () => false }, mode: () => '1', log: () => {} });
  assert.equal(fp.mode(), '1', 'live mode stays available on words alone');
  const named = await fp.pick({ task: 'click the insert tab', window: { title: 'Word', process: 'winword' }, steps: [], elements: els });
  assert.equal(named.accept, true); assert.equal(named.element.id, 1); assert.equal(named.provider, 'words');
  const vague = await fp.pick({ task: 'make a pivot table of my grades', window: {}, steps: [], elements: els });
  assert.equal(vague.accept, false, 'half a match is not a pick');
  const planned = await fp.pick({ task: 'add a table', window: {}, steps: [{ instruction: 'x' }], planned: { instruction: 'Click Table', control: 'Table' }, elements: els });
  assert.equal(planned.accept, true); assert.equal(planned.element.id, 3);
  const ha = heuristicAnswers({ task: 'nothing here', options: new Map() });
  assert.equal(ha.control.choice, 'none');
});

test('a ring pick reconciles as verified', () => {
  const hit = V.reconcile({ target: { kind: 'bbox', label: 'Insert' }, elements: [], bboxPhys: { x: 90, y: 30, w: 80, h: 40 }, fromPoint: Object.assign({ ring: true }, els[0]), found: null });
  assert.equal(hit.source, 'frompoint-ring'); assert.equal(hit.verified, true); assert.deepEqual(hit.rect, els[0].rect);
});

const apps = [{ key: 'notepad', name: 'Notepad', describe: 'Notepad (notepad, note pad, notes)' }, { key: 'word', name: 'Word', describe: 'Microsoft Word (word, microsoft word)' }];

test('the rules name intents the way the classifier would, conservatively', () => {
  const intent = (t) => ruleAnswers(t, { apps, sites: ['youtube', 'gmail'] }).intent.choice;
  assert.equal(intent('open notepad'), 'open_app');
  assert.equal(ruleAnswers('open notepad', { apps }).app.choice, 'notepad');
  assert.equal(intent('how do I insert a table'), 'guide');
  assert.equal(intent('where is the save button'), 'guide');
  assert.equal(intent('type hello world'), 'type_text');
  assert.equal(intent('search norbert wiener'), 'web_search');
  assert.equal(intent('add a note call akrit'), 'remember_note');
  assert.equal(intent('keep me off reels for 20 minutes'), 'focus_guard');
  assert.equal(intent('thanks that is all'), 'dismiss');
  assert.equal(intent('next step'), 'next');
  assert.equal(intent('what is the capital of peru'), 'ask');
  assert.equal(intent('which button do I click here'), 'guide');
  assert.equal(intent('okay great'), 'none');
  assert.equal(intent('go to youtube'), 'open_site', 'a site named in full, with no app of that name, is a site');
  assert.equal(ruleAnswers('open the website youtube', { apps, sites: ['youtube'] }).site.choice, 'youtube');
  assert.equal(ruleAnswers('', { apps }).intent.choice, 'none');
});

test('needsScreen: general questions skip the screenshot, anything about the screen keeps it', () => {
  const { needsScreen } = require('../src/reflex/rules');
  for (const q of ["what's a pivot table", 'who was Alan Turing', 'explain recursion', 'how many ounces in a cup', 'define osmosis', 'can I use a calculator on the SAT']) assert.equal(needsScreen(q), false, q);
  for (const q of ['how do I insert a table', 'where is the save button', 'what does this error mean', 'what is on my screen', 'open the settings', 'summarize this page', 'help me', 'insert a chart', '']) assert.equal(needsScreen(q), true, q);
});

test('the rules client plugs into decide() and the router like the service does', async () => {
  const client = createRulesClient({ apps: () => apps });
  assert.equal(client.ready(), true);
  const q = buildQuestions('open notepad', apps);
  const res = await client.systemOne({ state: { utterance: 'open notepad' }, questions: q.questions });
  assert.equal(res.model, 'rules');
  const d = decide('open notepad', res.answers, { final: true, apps });
  assert.equal(d.fire, true); assert.equal(d.app.key, 'notepad');
  const typed = decide('type hello there', (await client.systemOne({ state: { utterance: 'type hello there' }, questions: buildQuestions('type hello there', apps).questions })).answers, { final: true, apps });
  assert.equal(typed.fire, true); assert.equal(typed.text, 'hello there');
  const guide = decide('how do I insert a table', (await client.systemOne({ state: { utterance: 'how do I insert a table' }, questions: q.questions })).answers, { final: true, apps });
  assert.equal(guide.fire, false); assert.equal(guide.brain, true, 'a guide ask goes to the thinking model');
  const chat = decide('okay great', (await client.systemOne({ state: { utterance: 'okay great' }, questions: q.questions })).answers, { final: true, apps });
  assert.equal(chat.fire, false); assert.equal(chat.brain, false);
  const early = decide('open note', (await client.systemOne({ state: { utterance: 'open note' }, questions: q.questions })).answers, { final: false, apps });
  assert.equal(early.fire, false, 'a half sentence never fires on rules');
});

test('no-key rules, 2026-10-29: sites by name, exact apps early, tabs before next, more volume and window wordings', async () => {
  const { route, splitClauses, SITES } = require('../src/reflex/router');
  const { buildCatalog } = require('../src/reflex/catalog');
  const APPS = buildCatalog([{ name: 'Notepad', appId: 'np' }, { name: 'Google Chrome', appId: 'ch' }, { name: 'Outlook', appId: 'ol' }, { name: 'Spotify', appId: 'sp' }, { name: 'Calculator', appId: 'ca' }, { name: 'Canvas Student', appId: 'cv' }]);
  const jev = createRulesClient({ apps: () => APPS });
  const go = async (t, final = true) => route(splitClauses(t)[0], { final, apps: APPS, context: {}, jev, log: () => {} });
  const d1 = await go('open youtube'); assert.equal(d1.intent, 'open_site'); assert.equal(d1.url, SITES.youtube[0]); assert.equal(d1.fire, true);
  const d2 = await go('pull up gmail'); assert.equal(d2.intent, 'open_site', 'a site named in full beats the fuzzy Outlook match');
  const d3 = await go('open spotify'); assert.equal(d3.intent, 'open_app'); assert.equal(d3.app.name, 'Spotify', 'an installed app beats its web player');
  const d4 = await go('hey nus open calculator'); assert.equal(d4.fire, true); assert.equal(d4.app.name, 'Calculator');
  const d5 = await go('open the browser'); assert.equal(d5.fire, true); assert.equal(d5.app.name, 'Google Chrome');
  const d6 = await go('open canvas'); assert.equal(d6.fire, true); assert.equal(d6.app.name, 'Canvas Student');
  assert.equal((await go('next tab')).intent, 'next_tab');
  assert.equal((await go('next step')).intent, 'next');
  for (const [t, want] of [['a bit quieter', 'volume_down'], ['make it louder', 'volume_up'], ['move this window to the right', 'snap_right'], ['make it full screen', 'maximize'], ['what do I have today', 'brief']]) assert.equal((await go(t)).intent, want, t);
  const early = await go('open chrome', false); assert.equal(early.fire, true, 'an exact app name fires before the key comes up');
  const cut = await go('open chr', false); assert.equal(cut.fire, false, 'a name cut short waits');
  const filler = await go('okay lets move on'); assert.equal(filler.fire, false); assert.equal(filler.brain, false, 'filler never wakes the thinking model');
});
