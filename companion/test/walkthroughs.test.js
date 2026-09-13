const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createWalkthroughs, keyFor } = require('../src/guide/walkthroughs');

const rec = (over = {}) => Object.assign({
  task: 'submit my essay on canvas',
  app: { process: 'chrome', title: 'Canvas - Assignments' },
  steps: [
    { instruction: 'Click Assignments', name: 'Assignments', type: 'Hyperlink', automationId: '', boxNorm: { x: 0.1, y: 0.2, w: 0.05, h: 0.02 } },
    { instruction: 'Click Submit Assignment. This sends it.', name: 'Submit Assignment', type: 'Button' },
  ],
}, over);

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nus-wt-'));
  return path.join(dir, 'companion-walkthroughs.json');
}

test('a kept session becomes a walkthrough keyed by app and task, and persists to disk', () => {
  const file = tmpFile();
  let t = 1000;
  const w = createWalkthroughs({ file, now: () => t++ });
  const e = w.record(rec());
  assert.equal(e.key, keyFor('chrome', 'submit my essay on canvas'));
  assert.equal(e.steps.length, 2);
  assert.equal(e.steps[1].target.name, 'Submit Assignment');
  assert.equal(e.runs, 1);
  const again = createWalkthroughs({ file, now: () => t++ });
  assert.equal(again.list().length, 1, 'reloaded from disk');
  assert.equal(again.record(rec()).runs, 2, 'a repeat run updates, never duplicates');
  assert.equal(again.list().length, 1);
});

test('steps without a control name are dropped; nothing is saved without an app or steps', () => {
  const w = createWalkthroughs({});
  assert.equal(w.record(rec({ steps: [{ instruction: 'x', name: '' }] })), null);
  assert.equal(w.record(rec({ app: null })), null);
  const e = w.record(rec({ steps: [{ instruction: 'a', name: 'A' }, { instruction: 'b', name: '' }] }));
  assert.equal(e.steps.length, 1);
});

test('find matches the same app and a close enough ask, never a different app or a stale entry', () => {
  const w = createWalkthroughs({});
  w.record(rec());
  assert.ok(w.find({ process: 'chrome', title: 'Canvas', task: 'submit my essay on canvas' }), 'exact');
  assert.ok(w.find({ process: 'Chrome', title: 'Canvas - Assignments', task: 'submit essay canvas' }), 'close enough, case-insensitive process');
  assert.equal(w.find({ process: 'msedge', title: 'Canvas', task: 'submit my essay on canvas' }), null, 'different app');
  assert.equal(w.find({ process: 'chrome', title: 'Canvas', task: 'change my password' }), null, 'different ask');
  assert.equal(w.find({ process: 'chrome', title: 'YouTube', task: 'submit essay' }), null, 'a browser on another site does not match');
  w.markStale(keyFor('chrome', 'submit my essay on canvas'));
  assert.equal(w.find({ process: 'chrome', title: 'Canvas', task: 'submit my essay on canvas' }), null, 'stale entries are not offered');
});

test('two misses retire a walkthrough; a fresh keep revives it', () => {
  const w = createWalkthroughs({});
  const e = w.record(rec());
  assert.equal(w.miss(e.key), false);
  assert.equal(w.miss(e.key), true);
  assert.equal(w.find({ process: 'chrome', task: rec().task }), null);
  w.record(rec());
  assert.ok(w.find({ process: 'chrome', title: 'Canvas', task: rec().task }));
  assert.equal(w.get(e.key).misses, 0);
});

test('forget removes, forApp lists live entries for an app, and the file stays bounded', () => {
  const file = tmpFile();
  const w = createWalkthroughs({ file });
  for (let i = 0; i < 90; i++) w.record(rec({ task: 'task number ' + i }));
  assert.equal(w.list().length <= 80, true);
  assert.equal(w.forApp('chrome').length <= 80, true);
  const key = w.list()[0].key;
  w.forget(key);
  assert.equal(w.get(key), null);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw.schema_version, 1);
});
