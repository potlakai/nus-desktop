// The quick pointer's pure parts: what is sent to Jev, and the gate that
// decides whether the thread may go out before the model has answered.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFastPointer, buildControlQuestions, gate, templateInstruction, marginOf, modeFromEnv, plannedKey, THRESHOLDS, MAX_OPTIONS } = require('../src/guide/fastpoint');

const R = (x, y) => ({ x, y, w: 80, h: 24 });
const ELEMENTS = [
  { id: 1, name: 'Insert', type: 'TabItem', rect: R(100, 60), box: [0.05, 0.05, 0.04, 0.02] },
  { id: 2, name: 'PivotTable', type: 'Button', rect: R(20, 120), box: [0.01, 0.11, 0.04, 0.05] },
  { id: 3, name: '', type: 'Button', rect: R(300, 120), box: [0.2, 0.11, 0.04, 0.05] },
  { id: 4, name: 'Q3 budget FINAL (Pranav).xlsx', type: 'ListItem', rect: R(300, 400), box: [0.2, 0.4, 0.2, 0.03] },
  { id: 5, name: 'Submit Assignment', type: 'Button', rect: R(1500, 900), box: [0.78, 0.83, 0.09, 0.04] },
  { id: 6, name: 'Password', type: 'Edit', rect: R(600, 500), box: [0.4, 0.5, 0.2, 0.03] },
  { id: 7, name: 'Save', type: 'Button', rect: R(900, 60), box: [0.5, 0.05, 0.04, 0.02] },
  { id: 8, name: 'Save', type: 'Button', rect: R(900, 700), box: [0.5, 0.7, 0.04, 0.02] },
];
const INPUT = { task: 'help me make a pivot table', window: { title: 'Book1 - Excel', process: 'EXCEL' }, steps: [], planned: null, elements: ELEMENTS };
const answer = (key, confidence, extra) => Object.assign({ control: { choice: key, confidence, probabilities: { [key]: confidence, none: Math.max(0, 1 - confidence - 0.01) } }, finished: { noul: 0.02 }, right_app: { noul: 0.97 } }, extra || {});

test('only named UI-label controls go to Jev: no unnamed controls, no list items, names clipped', () => {
  const { state, questions, options } = buildControlQuestions(INPUT);
  const keys = Object.keys(questions.control.criteria);
  assert.deepEqual(keys, ['none', 'e1', 'e2', 'e5', 'e6', 'e7', 'e8']);
  assert.equal(options.get('e2').name, 'PivotTable');
  assert.equal(questions.control.criteria.e1, 'TabItem "Insert", top left');
  assert.equal(JSON.stringify(questions).includes('Q3 budget'), false, 'a file name in a list never leaves the machine');
  assert.equal(state.goal, 'help me make a pivot table');
  assert.deepEqual(state.app, { window: 'Book1 - Excel', process: 'EXCEL' });
  assert.equal(questions.finished.type, 'noul');
  assert.equal(questions.right_app.type, 'noul');
  const long = buildControlQuestions(Object.assign({}, INPUT, { elements: [{ id: 9, name: 'x'.repeat(200), type: 'Button', rect: R(1, 1), box: [0, 0, 0.1, 0.1] }] }));
  assert.ok(long.questions.control.criteria.e9.length < 70);
});

test('the option list stays inside what Jev accepts', () => {
  const many = Array.from({ length: 400 }, (_, i) => ({ id: i + 1, name: 'Button ' + i, type: 'Button', rect: R(i, i), box: [0, 0, 0.1, 0.1] }));
  const { questions } = buildControlQuestions(Object.assign({}, INPUT, { elements: many }));
  assert.ok(Object.keys(questions.control.criteria).length <= MAX_OPTIONS + 1);
  assert.ok(Object.keys(questions.control.criteria).length <= 254);
});

test('the gate: sure, clear and safe goes out; everything else waits for the model', () => {
  const { options } = buildControlQuestions(INPUT);
  const g = (a, planned) => gate(a, options, ELEMENTS, null, planned);
  const ok = g(answer('e1', 0.93));
  assert.equal(ok.accept, true);
  assert.equal(ok.element.name, 'Insert');
  assert.equal(g(answer('none', 0.9)).reason, 'none');
  assert.equal(g(answer('e99', 0.99)).reason, 'unknown option');
  assert.equal(g(answer('e1', 0.7)).reason, 'confidence');
  assert.equal(g({ control: { choice: 'e1', confidence: 0.9, probabilities: { e1: 0.5, e2: 0.4 } } }).reason, 'margin');
  assert.equal(g(answer('e1', 0.95, { finished: { noul: 0.6 } })).reason, 'maybe finished');
  assert.equal(g(answer('e1', 0.95, { right_app: { noul: 0.2 } })).reason, 'maybe wrong app');
  assert.equal(g(answer('e7', 0.99)).reason, 'duplicate name', 'two Save buttons: Jev cannot know which');
  assert.equal(g(answer('e5', 0.99)).reason, 'irreversible', 'Submit is never quick-pointed');
  assert.equal(g(answer('e6', 0.99)).reason, 'sensitive');
  for (const r of [g(answer('e5', 0.99)), g(answer('e6', 0.99)), g(answer('e7', 0.99))]) assert.equal(r.accept, false);
  // No distribution returned: confidence alone decides.
  assert.equal(g({ control: { choice: 'e1', confidence: 0.9 } }).accept, true);
  assert.equal(marginOf({ choice: 'a', probabilities: { a: 0.7, b: 0.2, c: 0.1 } }).toFixed(2), '0.50');
});

test('a pick that matches the model\'s own plan for this step needs less from Jev', () => {
  const { options } = buildControlQuestions(INPUT);
  assert.equal(plannedKey({ control: 'PivotTable' }, options, THRESHOLDS.plannedOverlap), 'e2');
  assert.equal(plannedKey({ control: 'Save' }, options, THRESHOLDS.plannedOverlap), null, 'two matches is no match');
  const hedged = answer('e2', 0.7);
  assert.equal(gate(hedged, options, ELEMENTS, null, null).accept, false);
  const withPlan = gate(hedged, options, ELEMENTS, null, { instruction: 'Click PivotTable', control: 'PivotTable' });
  assert.equal(withPlan.accept, true);
  assert.equal(withPlan.planned, true);
  // The plan never rescues an irreversible control.
  assert.equal(gate(answer('e5', 0.7), options, ELEMENTS, null, { control: 'Submit Assignment' }).accept, false);
});

test('the placeholder sentence is short and names the control', () => {
  assert.equal(templateInstruction({ name: 'Insert', type: 'TabItem' }), 'Open the "Insert" tab.');
  assert.equal(templateInstruction({ name: 'PivotTable', type: 'Button' }), 'Click "PivotTable".');
  assert.equal(templateInstruction({ name: 'Search', type: 'Edit' }), 'Click the "Search" box.');
  assert.equal(templateInstruction({ name: '', type: 'Button' }), 'Click here.');
  for (const type of ['Button', 'TabItem', 'MenuItem', 'Edit', 'CheckBox', 'RadioButton', 'ComboBox', 'SplitButton']) {
    assert.ok(templateInstruction({ name: 'Conditional Formatting Rules Manager', type }).split(/\s+/).length <= 12);
  }
});

test('modes: off without a key, off unless asked for, and pick never throws', async () => {
  assert.equal(modeFromEnv(undefined), '0');
  assert.equal(modeFromEnv('shadow'), 'shadow');
  assert.equal(modeFromEnv('1'), '1');
  assert.equal(modeFromEnv('banana'), '0');
  const noKey = createFastPointer({ jev: { ready: () => false, systemOne: async () => { throw new Error('no'); } }, mode: '1', heuristic: false });
  assert.equal(noKey.mode(), '0');
  const words = createFastPointer({ jev: { ready: () => false, systemOne: async () => { throw new Error('no'); } }, mode: '1' });
  assert.equal(words.mode(), '1', 'with no key the words of the task can still pick (chooser-rules.test.js)');

  const calls = [];
  const fp = createFastPointer({ jev: { ready: () => true, systemOne: async (req) => { calls.push(req); return { answers: answer('e1', 0.95), ms: 140, model: 'fake' }; } }, mode: () => '1' });
  assert.equal(fp.mode(), '1');
  const pick = await fp.pick(INPUT);
  assert.equal(pick.accept, true);
  assert.equal(pick.ms, 140);
  assert.equal(pick.options, 6);
  assert.equal(calls.length, 1, 'one Jev call');
  assert.deepEqual(Object.keys(calls[0].questions), ['control', 'finished', 'right_app']);

  const dead = createFastPointer({ jev: { ready: () => true, systemOne: async () => { throw new Error('jev 503'); } }, mode: '1' });
  const miss = await dead.pick(INPUT);
  assert.equal(miss.accept, false);
  assert.equal(miss.reason, 'jev unavailable');

  const slow = createFastPointer({ jev: { ready: () => true, systemOne: () => new Promise(() => {}) }, mode: '1', deadlineMs: 30 });
  const late = await slow.pick(INPUT);
  assert.equal(late.accept, false, 'a hung Jev call is cut off, never awaited');

  const empty = await fp.pick(Object.assign({}, INPUT, { elements: [] }));
  assert.equal(empty.reason, 'no named controls');
  assert.equal(calls.length, 1, 'nothing to choose from: Jev is not called');
});
