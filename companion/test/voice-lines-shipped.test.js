'use strict';
// The Knot's fixed lines come with the app (0.1.33): a new install finds them and makes none.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LINES, createLineCache, fileName, readWav, shippedLinesDir, voiceKeyOf } = require('../src/voice/lines');
const { pcmToWav } = require('../src/wav');
const Tour = require('../src/tour');
const { wantedLines, OUT } = require('../../scripts/make-voice-lines');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nus-shipped-'));
const tone = (n = 2400) => { const b = Buffer.alloc(n * 2); for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(8000 * Math.sin(i / 7)), i * 2); return b; };
const KEY = 'fable:kokoro-v1_0:25:1';
function ship(dir, key, lines) { for (const l of lines) fs.writeFileSync(path.join(dir, fileName(key, l)), pcmToWav(tone(), 24000)); }

test('a shipped line is there without being made, and is read from the shipped folder', async () => {
  const shipped = tmp(), dir = tmp();
  ship(shipped, KEY, ['On it.', 'Let me look.']);
  let made = 0;
  const cache = createLineCache({ dir, shipped, voiceKey: () => KEY, keep: () => true, synth: async () => { made++; return { sampleRate: 24000, pcm: tone(), secs: 0.1 }; }, log: () => {} });
  assert.equal(cache.has('On it.'), true);
  assert.deepEqual(cache.missing(['On it.', 'Let me look.', 'Sure.']), ['Sure.']);
  const a = cache.get('Let me look.');
  assert.ok(a && a.sampleRate === 24000 && a.pcm.length === 4800);
  const r = await cache.prerender(['On it.', 'Let me look.']);
  assert.deepEqual(r, { made: 0, left: 0 });
  assert.equal(made, 0, 'nothing was synthesized');
  assert.deepEqual(fs.readdirSync(dir), [], 'and nothing was written to the person\'s folder');
});

test('a line that is not shipped is made as before, and only that one', async () => {
  const shipped = tmp(), dir = tmp();
  ship(shipped, KEY, ['On it.']);
  const said = [];
  const cache = createLineCache({ dir, shipped, voiceKey: () => KEY, keep: () => true, synth: async (l) => { said.push(l); return { sampleRate: 24000, pcm: tone(), secs: 0.1 }; }, log: () => {} });
  const r = await cache.prerender(['On it.', 'Hi, Maya.']);
  assert.deepEqual(said, ['Hi, Maya.']);
  assert.equal(r.made, 1);
  assert.equal(fs.readdirSync(dir).length, 1);
});

test('another voice does not get the shipped voice\'s lines', () => {
  const shipped = tmp();
  ship(shipped, KEY, ['On it.']);
  const cache = createLineCache({ dir: tmp(), shipped, voiceKey: () => 'other:model:3:1', synth: async () => null, log: () => {} });
  assert.equal(cache.has('On it.'), false);
  assert.equal(cache.get('On it.'), null);
});

test('the person\'s own copy wins, a broken shipped file is skipped, and no shipped folder is fine', async () => {
  const shipped = tmp(), dir = tmp();
  ship(shipped, KEY, ['On it.']);
  fs.writeFileSync(path.join(dir, fileName(KEY, 'On it.')), pcmToWav(tone(4800), 24000));
  const mine = createLineCache({ dir, shipped, voiceKey: () => KEY, synth: async () => null, log: () => {} });
  assert.equal(mine.get('On it.').pcm.length, 9600, 'their own, longer file');

  const bad = tmp();
  fs.writeFileSync(path.join(bad, fileName(KEY, 'Sure.')), 'not a wav');
  let made = 0;
  const cache = createLineCache({ dir: tmp(), shipped: bad, voiceKey: () => KEY, keep: () => true, synth: async () => { made++; return { sampleRate: 24000, pcm: tone(), secs: 0.1 }; }, log: () => {} });
  assert.equal(cache.get('Sure.'), null);
  assert.equal(cache.has('Sure.'), false, 'not offered again once it failed to read');
  await cache.prerender(['Sure.']);
  assert.equal(made, 1, 'so it is made here instead');

  for (const none of [undefined, '', path.join(tmp(), 'missing')]) {
    const c = createLineCache({ dir: tmp(), shipped: none, voiceKey: () => KEY, synth: async () => null, log: () => {} });
    assert.equal(c.has('On it.'), false);
  }
});

test('has() lists the shipped folder once, however often it is asked', () => {
  const shipped = tmp();
  ship(shipped, KEY, LINES);
  const real = fs.readdirSync; let lists = 0;
  fs.readdirSync = (...a) => { if (a[0] === shipped) lists++; return real(...a); };
  try {
    const cache = createLineCache({ dir: tmp(), shipped, voiceKey: () => KEY, synth: async () => null, log: () => {} });
    for (let i = 0; i < 50; i++) assert.deepEqual(cache.missing(LINES), []);
  } finally { fs.readdirSync = real; }
  assert.equal(lists, 1);
});

test('where the shipped folder is looked for, and the one voice key', () => {
  const res = path.join('C:', 'app', 'resources');
  assert.equal(shippedLinesDir(res, (p) => p === path.join(res, 'voice-lines')), path.join(res, 'voice-lines'));
  assert.match(shippedLinesDir(res, (p) => /vendor[\\/]voice-lines$/.test(p)), /vendor[\\/]voice-lines$/);
  assert.equal(shippedLinesDir(res, () => false), '');
  assert.equal(voiceKeyOf('fable', { model: 'kokoro-v1_0', speaker: 25, speed: 1.0 }), KEY);
  assert.equal(voiceKeyOf('fable', null), '');
});

test('the app, the build script and the installer agree', () => {
  const root = path.join(__dirname, '..', '..');
  const main = fs.readFileSync(path.join(root, 'companion', 'index.js'), 'utf8');
  assert.match(main, /shipped: shippedLinesDir\(\),/);
  assert.match(main, /voiceKeyOf\(st\.voice, v\)/, 'the app names the voice with the same function the build script uses');
  const want = wantedLines();
  assert.deepEqual([...want].sort(), [...new Set(LINES.concat(Tour.cachedLines()))].sort());
  assert.ok(want.length >= 40, 'the tour and the short replies: ' + want.length);
  assert.ok(!want.some((l) => /^Hi, /.test(l)), 'the greeting with a name is made on the person\'s computer');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.match(pkg.scripts['dist:companion'], /^node scripts\/make-voice-lines\.js && electron-builder /, 'every build makes the lines first');
  const cfg = fs.readFileSync(path.join(root, 'electron-builder.companion.config.js'), 'utf8');
  assert.match(cfg, /\{ from: 'vendor\/voice-lines', to: 'voice-lines', filter: \['\*\.wav', 'lines\.json'\] \}/);
});

// The files a build on this computer would ship, when they have been made (vendor is not in git).
test('made on this computer: every line is there, sane audio, nothing extra', { skip: !fs.existsSync(path.join(OUT, 'lines.json')) }, () => {
  const info = JSON.parse(fs.readFileSync(path.join(OUT, 'lines.json'), 'utf8'));
  const want = wantedLines();
  const names = new Set(want.map((l) => fileName(info.voice, l)));
  const onDisk = fs.readdirSync(OUT).filter((f) => f.endsWith('.wav'));
  assert.deepEqual(onDisk.filter((f) => !names.has(f)), [], 'no file for a line that is no longer said');
  assert.deepEqual([...names].filter((n) => !onDisk.includes(n)), [], 'run: npm run voice:lines');
  for (const l of want) {
    const a = readWav(fs.readFileSync(path.join(OUT, fileName(info.voice, l))));
    assert.ok(a && a.sampleRate === 24000, l);
    const pace = l.length / a.secs;
    assert.ok(a.secs > 0.4 && pace > 4 && pace < 26, 'odd length for "' + l + '": ' + a.secs.toFixed(2) + ' s');
  }
});
