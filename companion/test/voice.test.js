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
  assert.match(main, /function pttStart\(\)/);
  assert.match(main, /function pttStop\(reason\)/);
  assert.match(main, /VK_SPACE/, 'the probe reports the release');
  assert.match(main, /createSTT\(settings\)/, 'local whisper first, cloud keys as fallback');
  // (2026-09-21: start() also takes when the words were heard, for the timing line.)
  assert.match(main, /getGuide\(\)\.start\(kind\.text, 'voice'[,)]/, 'a spoken ask starts a guide session marked voice');
  assert.match(main, /state\.capturing/, 'never while a meeting is being listened to');
  const preload = read('preload.js');
  assert.match(preload, /pttPcm/);
  assert.match(preload, /'ptt:state'/);
  const js = read('renderer', 'renderer.js');
  assert.match(js, /nus\.on\('ptt:state'/);
  assert.match(js, /if \(pttHeld\) nus\.pttPcm\(e\.data\.buffer\);\n\s+else if \(captureOn\(\)\) nus\.micPcm\(e\.data\.buffer\);\n\s+else if \(tourMic\) \{ tourLevel\(e\.data\.level\); return; \}\n\s+else return;/, 'one mic, two sinks, the tour\'s bars, and silence between presses');
  assert.match(js, /const MIC_WARM_MS = 45000;/, 'the mic stays warm between presses');
  assert.match(js, /function say\(text, opts\)/, 'spoken step lines, queued');
  assert.match(js, /if \(p\.speak\) say\(p\.speak\)/);
  assert.match(js, /nus\.on\('guide:say'/, 'sentences spoken as they stream');
  const session = read('src', 'guide', 'session.js');
  assert.match(session, /speak: s\.source === 'voice' && !this\.saidThisStep\(\) \? target\.instruction : undefined/, 'typed asks stay silent; streamed sentences are not said twice');
  assert.match(session, /if \(s\.source === 'voice'\) this\.d\.send\('guide:say'/, 'early speech only for voice asks');
});
