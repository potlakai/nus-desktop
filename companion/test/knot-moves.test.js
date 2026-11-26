const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { knotMoveCommand } = require('../src/knot-moves');

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

test('plain words send the Knot to a corner', () => {
  assert.deepEqual(knotMoveCommand('move to the top left corner'), { corner: 'tl' });
  assert.deepEqual(knotMoveCommand('Knot, go to the bottom right'), { corner: 'br' });
  assert.deepEqual(knotMoveCommand('can you move yourself to the upper right'), { corner: 'tr' });
  assert.deepEqual(knotMoveCommand('scoot over to the lower-left'), { corner: 'bl' });
  assert.deepEqual(knotMoveCommand('go sit in the top right corner'), { corner: 'tr' });
});

test('"go back" sends it to where it was', () => {
  for (const t of ['go home', 'Go back.', 'okay, come back home', 'knot, go back to your spot', 'back to your corner']) assert.deepEqual(knotMoveCommand(t), { home: true }, t);
});

test('anything about a window, a tab or an app is not for the Knot', () => {
  for (const t of ['move the window to the top left', 'snap this to the left', 'move it to the top right corner', 'go to the top left tab', 'open the app in the bottom right',
    'go back a page', 'go back in the browser', 'what is in the top left corner', 'top left', 'move left', 'go to youtube', '']) assert.equal(knotMoveCommand(t), null, t);
  assert.equal(knotMoveCommand('move yourself to the top left ' + 'and then '.repeat(20)), null, 'a long sentence is not a quick command');
});

test('the move is wired from the tray, Home and the spoken or typed word to the overlay', () => {
  const main = read('index.js'), preload = read('preload.js'), js = read('renderer', 'renderer.js'), home = fs.readFileSync(path.join(root, '..', 'src', 'main-companion.js'), 'utf8');
  assert.match(main, /function moveKnot\(where\)/);
  assert.match(main, /label: 'Move Knot to'/, 'tray menu');
  assert.match(main, /const sc = selfCommands\(text, splitClauses\)/, 'spoken');
  assert.match(main, /const sc = selfCommands\(p\.text, splitClauses\)/, 'typed');
  assert.match(main, /send\('knot:pos', Object\.assign\(\{ skate: true \}, knotPosPayload\(\)\)\)/, 'a changed screen skates it to its spot');
  assert.match(preload, /'knot:move'/); assert.match(preload, /'knot:backdrop'/);
  assert.match(js, /nus\.on\('knot:move'/);
  assert.match(home, /companion\.moveKnot\(/, 'Home');
});

test('the brightness behind the Knot is one number, sampled locally and kept nowhere', () => {
  const main = read('index.js'), ps = read('src', 'win', 'probe.ps1');
  assert.match(ps, /'screen\.luma' \{/);
  assert.match(main, /probe\.request\('screen\.luma'/);
  assert.match(main, /send\('knot:backdrop', \{ luma: /);
  const fn = main.slice(main.indexOf('async function sampleBackdrop()'), main.indexOf('function startBackdropWatch()'));
  assert.ok(fn.length > 100);
  assert.doesNotMatch(fn, /writeFile|appendFile|console\.log\([^)]*luma|store\.setSettings|fetch\(/, 'never stored, logged or sent anywhere');
  const js = read('renderer', 'renderer.js'), css = read('renderer', 'styles.css');
  assert.match(js, /nus\.on\('knot:backdrop'/);
  assert.match(js, /classList\.toggle\('on-light', onLight\)/);
  assert.match(css, /#orb\.k3d\.on-light,[^{]*\{ box-shadow: none; \}/, 'no glow ring on a light desktop');
});
