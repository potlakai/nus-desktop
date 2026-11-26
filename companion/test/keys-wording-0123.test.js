'use strict';
// 0.1.23: no key is needed. A tester asked on 2026-11-15 whether a Jev (TypeSafe) key was needed,
// because the Keys page and the Knot's own guide still said voice commands needed one.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

test('nothing the person or the model reads says a TypeSafe key is needed', () => {
  const html = read('companion/home/index.html'), home = read('companion/home/home.js'), index = read('companion/index.js');
  for (const [name, text] of [['index.html', html], ['home.js', home], ['index.js', index]]) {
    assert.doesNotMatch(text, /Needs one TypeSafe key/, name);
    assert.doesNotMatch(text, /Two things to unlock/, name);
    assert.doesNotMatch(text, /Add a TypeSafe key for Jev/, name);
  }
  assert.match(html, /Works with no key\./);
  assert.match(html, /TypeSafe <small>Optional\./);
  assert.match(home, /\$\('#step-voice'\)\.classList\.add\('set'\)/, 'voice commands are always ready');
});

test('the Knot\'s guide says no key is needed on publik, and voice commands need none either way', () => {
  const index = read('companion/index.js');
  assert.match(index, /function keysGuide\(\)/);
  assert.match(index, /No key is needed: answers and pointing come through the publik account/);
  assert.match(index, /Voice commands such as opening an app, typing and searching need no key\. A TypeSafe key in Settings, Keys is optional\./);
  assert.match(index, /keysGuide\(\) \+ ' ' \+/, 'appGuide uses it');
  assert.doesNotMatch(index.slice(index.indexOf('function keysGuide'), index.indexOf('function appGuide')), /—/);
});
