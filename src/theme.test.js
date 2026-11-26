'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const theme = require('./theme');

test('two themes, and the butler is the default', () => {
  assert.deepEqual(theme.THEMES, ['jarvis', 'nus']);
  assert.equal(theme.DEFAULT, 'jarvis');
});

test('a stored value is cleaned rather than trusted', () => {
  assert.equal(theme.normalise('nus'), 'nus');
  assert.equal(theme.normalise('  NUS '), 'nus');
  assert.equal(theme.normalise('Jarvis'), 'jarvis');
  for (const bad of ['', null, undefined, 'dark', 0, {}, ['nus'], '<b>']) {
    assert.equal(theme.normalise(bad), 'jarvis', String(bad) + ' falls back to the default');
  }
});

test('isTheme says only yes for the two real values', () => {
  assert.equal(theme.isTheme('jarvis'), true);
  assert.equal(theme.isTheme('NŪS'.replace('Ū', 'U')), true);
  assert.equal(theme.isTheme('nus '), true);
  assert.equal(theme.isTheme('nus2'), false);
  assert.equal(theme.isTheme(undefined), false);
});

test('the switch flips, and a keystroke on a bad value lands somewhere sane', () => {
  assert.equal(theme.other('jarvis'), 'nus');
  assert.equal(theme.other('nus'), 'jarvis');
  assert.equal(theme.other('garbage'), 'nus', 'default flipped once');
  assert.equal(theme.other(theme.other('nus')), 'nus', 'twice is where it started');
});

test('each theme has a name and a sentence for the settings row', () => {
  for (const t of theme.THEMES) {
    const d = theme.describe(t);
    assert.ok(d.name && d.name.length > 1, t + ' has a name');
    assert.ok(d.note && d.note.length > 10, t + ' has a note');
    assert.notEqual(d.name, theme.describe(theme.other(t)).name, 'the two are told apart');
  }
});
