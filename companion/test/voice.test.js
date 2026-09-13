const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { cleanTranscript, classifyUtterance } = require('../src/guide/voice');

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

test('whisper noise tags are stripped and empty utterances dropped', () => {
  assert.equal(cleanTranscript('[BLANK_AUDIO] help me (wind blowing) submit this'), 'help me submit this');
  assert.equal(cleanTranscript('[BLANK_AUDIO]'), '');
  assert.equal(cleanTranscript('  a  '), '');
});

test('"thanks" and friends wind the thread back; "next" advances; everything else is an ask', () => {
  for (const s of ['thanks', 'Thank you', 'thanks Nūs', 'wind it up', 'wind up.', 'never mind', 'okay stop', 'that\'s it', 'cancel']) assert.equal(classifyUtterance(s).kind, 'dismiss', s);
  for (const s of ['next', 'Next step', 'done', 'okay, what\'s next?']) assert.equal(classifyUtterance(s).kind, 'next', s);
  for (const s of ['help me submit my essay', 'thanks for nothing, where is the settings page', 'next to the button there is a link, what is it']) assert.equal(classifyUtterance(s).kind, 'ask', s);
  assert.equal(classifyUtterance('[BLANK_AUDIO]').kind, 'empty');
});

test('push-to-talk is wired: hotkey, probe keyup, renderer mic route, spoken lines only for voice asks', () => {
  const main = read('index.js');
  assert.match(main, /CommandOrControl\+Alt\+Space/, 'default push-to-talk chord');
  assert.match(main, /'commandorcontrol\+alt\+space'/, 'reserved');
  assert.match(main, /function pttStart\(fromButton = false\)/);
  assert.match(main, /function pttStop\(reason\)/);
  assert.match(main, /VK_SPACE/, 'the probe reports the release');
  assert.match(main, /createSTT\(settings\)/, 'local whisper first, cloud keys as fallback');
  assert.match(main, /runFeature\('ask', kind\.text, ptt\.id\)/, 'an unscoped spoken question keeps its transcript identity without granting screen capture');
  assert.match(main, /state\.capturing/, 'never while a meeting is being listened to');
  const preload = read('preload.js');
  assert.match(preload, /pttPcm/);
  assert.match(preload, /'ptt:state'/);
  const js = read('renderer', 'renderer.js');
  assert.match(js, /nus\.on\('ptt:state'/);
  assert.match(js, /pttHeld \? nus\.pttPcm\(e\.data\.buffer\) : nus\.micPcm\(e\.data\.buffer\)/, 'one mic, two sinks');
  assert.match(js, /function say\(text\)/, 'spoken step line');
  assert.match(js, /if \(p\.speak\) say\(p\.speak\)/);
  const session = read('src', 'guide', 'session.js');
  assert.match(session, /speak: s\.source === 'voice' \? target\.instruction : undefined/, 'typed asks stay silent');
});

test('live preview stays bounded: whole buffer while short, then only the audio after the frozen head', () => {
  const { partialWindow, PARTIAL_WINDOW_S } = require('../src/guide/voice');
  const second = 16000 * 2;
  const short = Buffer.alloc(5 * second);
  assert.deepEqual({ head: null, freeze: false, len: partialWindow(short, null, PARTIAL_WINDOW_S).pcm.length }, { head: null, freeze: false, len: short.length });
  const long = Buffer.alloc(21 * second);
  const first = partialWindow(long, null, PARTIAL_WINDOW_S);
  assert.equal(first.head, null, 'no head yet: the whole buffer is transcribed once more');
  assert.equal(first.freeze, true, 'a segment past the window is frozen after this pass');
  const head = { text: 'Help me add a task.', endSample: long.length / 2 };
  const later = Buffer.concat([long, Buffer.alloc(4 * second)]);
  const next = partialWindow(later, head, PARTIAL_WINDOW_S);
  assert.equal(next.head, 'Help me add a task.');
  assert.equal(next.pcm.length, 4 * second, 'only the audio after the head is transcribed');
  assert.equal(next.freeze, false);
  const headBeyond = { text: 'x', endSample: later.length };  // stale head past the buffer never throws
  assert.equal(partialWindow(later, headBeyond, PARTIAL_WINDOW_S).pcm.length, 0);
});

test('a new voice session forgets the previous preview head', () => {
  const main = read('index.js');
  assert.match(main, /ptt\.chunks = \[\];\n\s+ptt\.partialHead = null;/);
  assert.match(main, /const \{ head, pcm, freeze \} = partialWindow\(whole, ptt\.partialHead, PARTIAL_WINDOW_S\);/);
  assert.match(main, /console\.log\('\[ptt\] stop: ' \+ reason/, 'every voice stop names its reason in the log');
});
