'use strict';
// The Mac talk key's release (2026-11-16): the modifier poll and the Companion's wiring.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { FLAG, macChordMods, chordHeld, watchChordRelease } = require('../src/voice/mac-release');
const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

test('the chord modifiers come from the accelerator; the final key is not one', () => {
  assert.deepEqual(macChordMods('Control+Alt+Space'), ['control', 'alt']);
  assert.deepEqual(macChordMods('CommandOrControl+Shift+M'), ['command', 'shift']);
  assert.deepEqual(macChordMods('Control+Alt+K'), ['control', 'alt']);
  assert.deepEqual(macChordMods('Space'), []);
  assert.deepEqual(macChordMods(''), []);
});

test('held means every chord modifier is down; extra modifiers do not matter', () => {
  const mods = ['control', 'alt'];
  assert.equal(chordHeld(FLAG.control | FLAG.alt, mods), true);
  assert.equal(chordHeld(FLAG.control | FLAG.alt | FLAG.command, mods), true, 'Command held too still counts');
  assert.equal(chordHeld(FLAG.control, mods), false, 'Option let go');
  assert.equal(chordHeld(0, mods), false);
  assert.equal(chordHeld(FLAG.control | FLAG.alt, []), false, 'no chord, never held');
});

function fakeSpawn() {
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => { child.killed = true; };
  const calls = [];
  const spawn = (cmd, args) => { calls.push({ cmd, args }); return child; };
  return { child, spawn, calls };
}

test('the watcher reports held, then released, once each, across split chunks', () => {
  const { child, spawn, calls } = fakeSpawn();
  const seen = [];
  const w = watchChordRelease({ mods: ['control', 'alt'], onChange: (h) => seen.push(h), spawn });
  assert.equal(calls[0].cmd, '/usr/bin/osascript');
  assert.deepEqual(calls[0].args.slice(0, 2), ['-l', 'JavaScript']);
  const both = FLAG.control | FLAG.alt;
  child.stderr.emit('data', 'f ' + both + '\nf ' + (both | FLAG.command) + '\n');
  // Option let go, the line split across two chunks.
  child.stderr.emit('data', 'f ' + String(FLAG.control).slice(0, 3));
  child.stderr.emit('data', String(FLAG.control).slice(3) + '\n');
  assert.deepEqual(seen, [true, false]);
  w.stop();
  assert.equal(child.killed, true);
  child.stderr.emit('data', 'f ' + both + '\n');
  assert.deepEqual(seen, [true, false], 'nothing after stop');
});

test('a released first reading is reported as not held (a quick tap)', () => {
  const { child, spawn } = fakeSpawn();
  const seen = [];
  watchChordRelease({ mods: ['control', 'alt'], onChange: (h) => seen.push(h), spawn });
  child.stderr.emit('data', 'f 0\n');
  assert.deepEqual(seen, [false]);
});

test('a spawn that throws reports an error and still returns a stop', () => {
  let err = '';
  const w = watchChordRelease({ mods: ['control', 'alt'], onError: (m) => { err = m; }, spawn: () => { throw new Error('no osascript'); } });
  assert.equal(err, 'no osascript');
  w.stop();
});

test('the Companion watches the release on a Mac and stops it with the press', () => {
  const src = read('index.js');
  assert.match(src, /require\('\.\/src\/voice\/mac-release'\)/);
  assert.match(src, /function startMacReleaseWatch\(/);
  assert.match(src, /startMacReleaseWatch\(\);/, 'pttStart starts it');
  const stop = src.slice(src.indexOf('async function pttStop('), src.indexOf('async function pttStop(') + 400);
  assert.match(stop, /stopMacReleaseWatch\(\)/, 'pttStop ends it');
  assert.match(src, /pttStop\('release'\)/);
});
