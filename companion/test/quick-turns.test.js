// The "feels fast" round (0.1.7): two quick actions in one sentence, volume
// by amount, and the Knot's size by voice.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { knotMoveCommand, knotSizeCommand, nextKnotSize, selfCommands, KNOT_SCALE } = require('../src/knot-moves');
const { splitClauses } = require('../src/reflex/router');
const { createReflex } = require('../src/reflex');
const { volumePresses, VK } = require('../src/reflex/executor');
const { ruleAnswers } = require('../src/reflex/rules');

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

function fakeProbe(log) {
  let hwnd = 100;
  return {
    request: async (op, p) => {
      log.push(op + (p && p.keys ? ':' + p.keys.join('+') : ''));
      if (op === 'fg') return { hwnd: hwnd++ };
      if (op === 'apps.list') return { apps: [{ name: 'Notepad', appId: 'np' }] };
      return { ok: true };
    },
  };
}
// A stand-in classifier: says what each clause is, with a set confidence.
function jevSays(map) {
  return {
    ready: () => true, provider: 'fake',
    async systemOne({ state }) {
      const u = String(state.utterance || '').toLowerCase();
      for (const [re, intent, conf] of map) if (re.test(u)) return { answers: { intent: { choice: intent, confidence: conf }, addressed: { noul: 0.9 } }, ms: 5, model: 'fake' };
      return { answers: { intent: { choice: 'none', confidence: 0.9 }, addressed: { noul: 0.9 } }, ms: 5, model: 'fake' };
    },
  };
}

test('"move to the top right" said on its own moves the Knot', () => {
  assert.deepEqual(knotMoveCommand('Move to the top right.'), { corner: 'tr' });
  assert.deepEqual(knotMoveCommand('move over to the bottom left corner'), { corner: 'bl' });
  assert.deepEqual(knotMoveCommand('can you go to the top left'), { corner: 'tl' });
  // Still never a window, a tab or a page.
  for (const t of ['move the window to the top right', 'move it to the top right', 'go to the top left tab', 'move left', 'top right']) assert.equal(knotMoveCommand(t), null, t);
});

test('the Knot gets smaller, bigger and back to normal by voice', () => {
  for (const t of ['Make yourself smaller.', 'make yourself a bit smaller', 'get smaller', 'shrink', 'Knot, make yourself smaller please']) assert.deepEqual(knotSizeCommand(t), { size: 'smaller' }, t);
  for (const t of ['make yourself bigger', 'get bigger', 'grow', 'make yourself a little bigger again']) assert.deepEqual(knotSizeCommand(t), { size: 'bigger' }, t);
  for (const t of ['make yourself normal size', 'back to your normal size', 'go back to normal size', 'normal size']) assert.deepEqual(knotSizeCommand(t), { size: 'normal' }, t);
  // Anything else made bigger is not the Knot.
  for (const t of ['make it bigger', 'make the text bigger', 'make the window smaller', 'make this smaller', 'turn the volume up', 'zoom in', '']) assert.equal(knotSizeCommand(t), null, t);
  // Three sizes, one step at a time.
  assert.equal(nextKnotSize('normal', { size: 'smaller' }), 'small');
  assert.equal(nextKnotSize('small', { size: 'smaller' }), 'small');
  assert.equal(nextKnotSize('small', { size: 'bigger' }), 'normal');
  assert.equal(nextKnotSize('normal', { size: 'bigger' }), 'big');
  assert.equal(nextKnotSize('big', { size: 'normal' }), 'normal');
  assert.equal(nextKnotSize(undefined, { size: 'smaller' }), 'small');
  assert.ok(KNOT_SCALE.small < 1 && KNOT_SCALE.big > 1 && KNOT_SCALE.normal === 1);
});

test('the Knot\'s own clauses come out of a sentence, the rest routes on', () => {
  assert.deepEqual(selfCommands('Move to the top right and turn it down a bit.', splitClauses), { cmds: [{ move: { corner: 'tr' } }], rest: 'turn it down a bit.' });
  assert.deepEqual(selfCommands('make yourself smaller and turn up the volume a little', splitClauses), { cmds: [{ size: { size: 'smaller' } }], rest: 'turn up the volume a little' });
  assert.deepEqual(selfCommands('make yourself smaller and move to the top left', splitClauses), { cmds: [{ size: { size: 'smaller' } }, { move: { corner: 'tl' } }], rest: '' });
  assert.equal(selfCommands('open notepad and type hello', splitClauses), null);
  // "Go back" after another action is about the page, not the Knot.
  assert.equal(selfCommands('open chrome and go back', splitClauses), null);
  assert.deepEqual(selfCommands('go back', splitClauses), { cmds: [{ move: { home: true } }], rest: '' });
});

test('volume by amount: a bit is one press, a lot is five, plain is three', () => {
  for (const t of ['turn it down a bit', 'turn the volume up a little', 'nudge it up a notch', 'turn it down just a touch', 'a little bit louder', 'turn it down slightly']) assert.equal(volumePresses(t), 1, t);
  for (const t of ['turn it way down', 'turn the volume up a lot', 'much louder']) assert.equal(volumePresses(t), 5, t);
  for (const t of ['turn the volume down', 'louder', '', undefined]) assert.equal(volumePresses(t), 3, String(t));
});

test('the rules hear the ways people turn it up and down', () => {
  for (const t of ['turn up the volume a little', 'turn it up', 'turn the music up', 'raise the volume', 'louder please']) assert.equal(ruleAnswers(t).intent.choice, 'volume_up', t);
  for (const t of ['turn it down a bit', 'turn down the volume', 'turn the volume down a bit', 'lower the volume', 'quieter']) assert.equal(ruleAnswers(t).intent.choice, 'volume_down', t);
});

test('"turn it down a bit" presses the volume key once', async () => {
  const ops = [];
  const reflex = createReflex({ probe: fakeProbe(ops), shell: { openExternal: async () => {} }, jevClient: jevSays([[/down/, 'volume_down', 0.9]]), spawnFn: () => ({ unref() {} }) });
  await reflex.start();
  await reflex.handle('turn it down a bit', { final: true });
  assert.equal(ops.filter((o) => o === 'keys.chord:' + VK.VOL_DOWN).length, 1);
});

test('two quick actions in one sentence both run', async () => {
  const ops = [], fires = [];
  const jev = jevSays([[/volume|turn it/, 'volume_down', 0.85], [/maximi/, 'maximize', 0.9]]);
  const reflex = createReflex({ probe: fakeProbe(ops), shell: { openExternal: async () => {} }, jevClient: jev, onFire: (f) => fires.push(f.intent), spawnFn: () => ({ unref() {} }) });
  await reflex.start();
  const out = await reflex.handle('maximize this and turn the volume down a bit', { final: true });
  assert.deepEqual(fires, ['maximize', 'volume_down']);
  assert.equal(out.fired, 2);
  assert.equal(ops.filter((o) => o === 'keys.chord:' + VK.VOL_DOWN).length, 1, 'a bit = one press');
});

test('a wavering key-press clause in a chain is not pressed', async () => {
  const ops = [], fires = [];
  const jev = jevSays([[/maximi/, 'maximize', 0.9], [/volume/, 'volume_down', 0.6]]);
  const reflex = createReflex({ probe: fakeProbe(ops), shell: { openExternal: async () => {} }, jevClient: jev, onFire: (f) => fires.push(f.intent), spawnFn: () => ({ unref() {} }) });
  await reflex.start();
  const out = await reflex.handle('maximize this and turn the volume down', { final: true });
  assert.deepEqual(fires, ['maximize']);
  assert.ok(!ops.includes('keys.chord:' + VK.VOL_DOWN));
  assert.match(String(out.brainText), /volume/, 'the unsure clause goes on to the thinking model');
});

test('size is wired from the words to the overlay and kept like the spot', () => {
  const main = read('index.js'), preload = read('preload.js'), js = read('renderer', 'renderer.js'), css = read('renderer', 'styles.css');
  assert.match(main, /function sizeKnot\(cmd\)/);
  assert.match(main, /store\.setSettings\(\{ knotSize: next \}\)/);
  assert.match(main, /send\('knot:size', \{ size: next/);
  // Spoken clauses run before Hands or the reflex layer can take the sentence.
  const route = main.slice(main.indexOf('async function routeUtterance('), main.indexOf('function routeUtteranceSlow('));
  assert.ok(route.indexOf('selfCommands(text, splitClauses)') < route.indexOf('if (handsClaims(text))'));
  // The screenshot mask grows with a bigger Knot.
  assert.match(main, /KNOT_MASK_DIP \* Math\.max\(1, KNOT_SCALE\[knotSize\(\)\]/);
  assert.match(preload, /'knot:size'/);
  assert.match(js, /nus\.on\('knot:size'/);
  assert.match(js, /applyKnotSize\(settings\.knotSize, false\)/, 'restored at boot');
  assert.match(css, /scale: var\(--knot-scale, 1\)/);
});
