'use strict';
// Which microphone the Companion listens with (onboard-0120): the device list, the saved pick,
// plugging in and pulling out, the silent-microphone check, and the wiring in the Knot's window,
// the tour's card and Settings.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const M = require('../renderer/mic-devices');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const dev = (deviceId, label, kind = 'audioinput') => ({ deviceId, label, kind, groupId: 'g' });
// What Chromium lists on a laptop with a USB headset plugged in.
const LAPTOP = [dev('default', 'Default - Microphone Array (Realtek(R) Audio)'), dev('communications', 'Communications - Microphone Array (Realtek(R) Audio)'),
  dev('aaa', 'Microphone Array (Realtek(R) Audio)'), dev('bbb', 'Headset Microphone (USB Audio)'), dev('spk', 'Speakers (Realtek(R) Audio)', 'audiooutput')];

test('the list: real inputs only, the stand-ins and outputs left out, the default named', () => {
  const f = M.inputs(LAPTOP);
  assert.deepEqual(f.list, [{ id: 'aaa', label: 'Microphone Array (Realtek(R) Audio)' }, { id: 'bbb', label: 'Headset Microphone (USB Audio)' }]);
  assert.equal(f.defaultLabel, 'Microphone Array (Realtek(R) Audio)');
  // Before the microphone may be used, Chromium hides the names: they are numbered.
  const hidden = M.inputs([dev('default', ''), dev('x1', ''), dev('x2', '')]);
  assert.deepEqual(hidden.list.map((d) => d.label), ['Microphone 1', 'Microphone 2']);
  assert.deepEqual(M.inputs(null), { list: [], defaultLabel: '' });
});

test('the pick: nothing saved is the default; saved, renamed and missing', () => {
  const f = M.inputs(LAPTOP);
  assert.deepEqual(M.choose(f, {}), { id: '', label: 'Microphone Array (Realtek(R) Audio)', why: 'default' });
  assert.equal(M.choose(f, { micDeviceId: 'bbb', micDeviceLabel: 'Headset Microphone (USB Audio)' }).why, 'saved');
  // Windows gave the headset a new id (another USB port): found again by its name.
  const moved = M.inputs([dev('default', 'Default - Microphone Array (Realtek(R) Audio)'), dev('aaa', 'Microphone Array (Realtek(R) Audio)'), dev('ccc', 'Headset Microphone (USB Audio)')]);
  assert.deepEqual(M.choose(moved, { micDeviceId: 'bbb', micDeviceLabel: 'Headset Microphone (USB Audio)' }), { id: 'ccc', label: 'Headset Microphone (USB Audio)', why: 'renamed' });
  // Unplugged: the default stands in, and the wanted name is kept to say so.
  const gone = M.choose(M.inputs([dev('default', 'Default - Microphone Array (Realtek(R) Audio)'), dev('aaa', 'Microphone Array (Realtek(R) Audio)')]), { micDeviceId: 'bbb', micDeviceLabel: 'Headset Microphone (USB Audio)' });
  assert.equal(gone.why, 'missing'); assert.equal(gone.id, ''); assert.equal(gone.wanted, 'Headset Microphone (USB Audio)');
});

test('constraints: the default needs no device id; a pick asks for exactly that one', () => {
  assert.equal(M.constraints('').audio.deviceId, undefined);
  assert.deepEqual(M.constraints('bbb').audio.deviceId, { exact: 'bbb' });
  assert.equal(M.constraints('bbb').audio.channelCount, 1);
  assert.equal(M.constraints('bbb').audio.echoCancellation, true);
});

test('plugging in: a new microphone is named and nothing moves; the chosen one coming back is reopened', () => {
  const before = M.inputs(LAPTOP.filter((d) => d.deviceId !== 'bbb'));
  const after = M.inputs(LAPTOP);
  const r = M.react(before, after, {}, '');
  assert.deepEqual(r.added.map((d) => d.id), ['bbb']);
  assert.match(r.message, /^New microphone: Headset Microphone \(USB Audio\)\. To use it, pick it in Settings, Voice, Microphone\.$/);
  assert.equal(r.reopen, false, 'the default did not change, so the open mic stays');
  const back = M.react(before, after, { micDeviceId: 'bbb', micDeviceLabel: 'Headset Microphone (USB Audio)' }, '');
  assert.equal(back.reopen, true); assert.match(back.message, /^Listening with Headset Microphone \(USB Audio\) again\.$/);
});

test('pulling out: the chosen one goes, the default takes over, said in plain words', () => {
  const before = M.inputs(LAPTOP), after = M.inputs(LAPTOP.filter((d) => d.deviceId !== 'bbb'));
  const r = M.react(before, after, { micDeviceId: 'bbb', micDeviceLabel: 'Headset Microphone (USB Audio)' }, 'bbb');
  assert.equal(r.reopen, true);
  assert.equal(r.message, 'Headset Microphone (USB Audio) was unplugged. Using Microphone Array (Realtek(R) Audio) for now.');
  // The mic closed: nothing to reopen, the message still says what happened.
  assert.equal(M.react(before, after, { micDeviceId: 'bbb', micDeviceLabel: 'Headset Microphone (USB Audio)' }, null).reopen, false);
  // Windows moved its own default while the default was open: open it again.
  const moved = M.inputs([dev('default', 'Default - Headset Microphone (USB Audio)'), dev('aaa', 'Microphone Array (Realtek(R) Audio)'), dev('bbb', 'Headset Microphone (USB Audio)')]);
  assert.equal(M.react(before, moved, {}, '').reopen, true);
});

test('the silent check: nothing before 5 s or once heard; dead at near zero, quiet otherwise', () => {
  assert.equal(M.verdict(3000, false, 0), '');
  assert.equal(M.verdict(6000, true, 0), '');
  assert.equal(M.verdict(6000, false, 0), 'dead');
  assert.equal(M.verdict(6000, false, 0.004), 'quiet');
  assert.match(M.helpLine('dead', 'Microphone Array', true), /^No sound at all from Microphone Array\. It may be muted or the wrong one\. Pick another below\.$/);
  assert.match(M.helpLine('dead', 'Microphone Array', false), /Windows Settings, System, Sound, Input\. Or go on without it and type to me\./);
  assert.match(M.failLine('NotFoundError'), /click me any time and type/);
  assert.match(M.failLine('NotAllowedError'), /Privacy, Microphone/);
  assert.match(M.failLine('NotReadableError'), /busy/);
  for (const t of [M.helpLine('dead', 'x', true), M.helpLine('quiet', 'x', false), M.failLine(''), M.failLine('NotAllowedError')]) assert.doesNotMatch(t, /—/);
});

test('wiring: the Knot opens the picked device, follows plug events and pick changes', () => {
  const r = read('companion/renderer/renderer.js');
  assert.match(r, /getUserMedia\(NM\.constraints\(want\.id\)\)/);
  assert.doesNotMatch(r, /getUserMedia\(\{ audio: \{ echoCancellation/, 'no microphone opened without the pick');
  assert.match(r, /addEventListener\('devicechange'/);
  assert.match(r, /NM\.react\(micFoundList, next, settings \|\| \{\}, micStream \? micOpenId : null\)/);
  assert.match(r, /reopenMic\('new pick'\)/);
  // The tour card: the device rows, the silent check, a way on with no microphone.
  assert.match(r, /add\('div', 'tr-mics'\); renderTourMics\(\);/);
  assert.match(r, /NM\.verdict\(Date\.now\(\) - tourMicAt, tourHeardSent, tourPeak\)/);
  assert.match(r, /id: 'tour-mic-none'/);
  const idx = read('companion/renderer/index.html');
  assert.ok(idx.indexOf('mic-devices.js') > 0 && idx.indexOf('mic-devices.js') < idx.indexOf('renderer.js?'), 'loaded before renderer.js');
});

test('wiring: the pick is a setting both windows may write, and Settings shows it', () => {
  const store = read('companion/src/store.js');
  assert.match(store, /micDeviceId: '',\s*\n\s*micDeviceLabel: '',/);
  assert.match(read('companion/index.js'), /OVERLAY_STRINGS = new Set\(\[[^\]]*'micDeviceId', 'micDeviceLabel'\]\)/);
  assert.match(read('src/main-companion.js'), /for \(const key of \['micDeviceId', 'micDeviceLabel'\]\)/);
  assert.match(read('companion/index.js'), /action === 'tour-mic-none' && tour\.step === S\.mic\) \{ tour\.caps\.whisper = false;/);
  const html = read('companion/home/index.html');
  for (const id of ['mic-select', 'mic-test', 'mic-meter', 'mic-note']) assert.match(html, new RegExp('id="' + id + '"'));
  assert.match(html, /renderer\/mic-devices\.js/);
  const home = read('companion/home/home.js');
  assert.match(home, /api\.settingsSet\(micSaved\)/);
  assert.match(home, /addEventListener\('devicechange'/);
});
