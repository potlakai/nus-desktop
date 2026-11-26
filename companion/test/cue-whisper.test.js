// The press pop plays as the mic opens, the one cue allowed while the mic is
// live. This proves whisper does not hear it as a word: a recorded turn with
// the pop mixed over its start, at the pop's full level, transcribes the same
// as the clean recording. Runs only where the vendored whisper and model are
// (Windows checkouts); elsewhere it skips.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..', '..');
const exe = path.join(root, 'vendor', 'whisper', process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli');
const model = ['ggml-small.en-q5_1.bin', 'ggml-base.en-q5_1.bin'].map((n) => path.join(root, 'vendor', 'whisper-models', n)).find((p) => fs.existsSync(p));
const fixture = path.join(root, 'scripts', 'bench', 'fixtures', 'open-chrome.wav');
const have = fs.existsSync(exe) && model && fs.existsSync(fixture);

const spec = require('../renderer/knot-spec.js');
const sampler = require('../renderer/cue-samples.js');
const { pcmToWav } = require('../src/wav');

function words(out) { return String(out || '').toLowerCase().replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function transcribe(wavPath) {
  // The app's own flags (src/stt-local.js runWhisper), the short-clip ones included.
  const r = spawnSync(exe, ['-m', model, '-f', wavPath, '-l', 'en', '-t', '4', '-nt', '-np', '-ac', '512', '-nf', '-bo', '1', '-bs', '1'], { encoding: 'utf8', timeout: 90000, windowsHide: true });
  assert.equal(r.status, 0, 'whisper ran: ' + (r.stderr || '').slice(-300));
  return words(r.stdout);
}
function pcmOf(wavPath) {
  const b = fs.readFileSync(wavPath);
  assert.equal(b.readUInt32LE(24), 16000, 'the fixture is 16 kHz');
  return b.subarray(44);
}
function mixed(pcm, at) {
  const pop = sampler.render(spec.character.cues, 'press', 16000);
  const out = Buffer.from(pcm);
  const i0 = Math.round(at * 16000);
  for (let i = 0; i < pop.length && i0 + i < out.length / 2; i++) {
    const v = Math.max(-32768, Math.min(32767, out.readInt16LE((i0 + i) * 2) + Math.round(pop[i] * 32767)));
    out.writeInt16LE(v, (i0 + i) * 2);
  }
  return out;
}

test('whisper hears the same words with the press pop over the start of the turn', { skip: !have && 'no vendored whisper here' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nus-cue-whisper-'));
  const pcm = pcmOf(fixture);
  const clean = path.join(dir, 'clean.wav');
  fs.writeFileSync(clean, pcmToWav(pcm, 16000, 1));
  const heard = transcribe(clean);
  assert.match(heard, /open chrome/, 'the clean turn reads "open chrome": ' + heard);
  // At the very start (the mic opening) and 150 ms in, under the first syllable.
  for (const at of [0, .15]) {
    const p = path.join(dir, 'pop-' + at + '.wav');
    fs.writeFileSync(p, pcmToWav(mixed(pcm, at), 16000, 1));
    assert.equal(transcribe(p), heard, 'the pop at ' + at + ' s changes nothing');
  }
  fs.rmSync(dir, { recursive: true, force: true });
});
