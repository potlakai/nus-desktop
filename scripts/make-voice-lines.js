#!/usr/bin/env node
'use strict';
// The Knot's fixed lines, made once when the app is built.
//
// The tour's cards and the short replies ("On it.", "Let me look.") are fixed text in a fixed
// voice. Until 0.1.33 every new install made them on its own processor during its first minute:
// about 3.7 cores for half a minute on an 8-core PC, measured 2026-11-21, while the new person was
// on the tour and asking their first questions. This makes them here, into vendor/voice-lines,
// with the same voice code, the same names and the same audio format the app uses, and the build
// copies them to resources/voice-lines (electron-builder.companion.config.js). The app then finds
// each line already there (companion/src/voice/lines.js `shipped`).
//
//   node scripts/make-voice-lines.js           make what is missing, drop what is no longer a line
//   node scripts/make-voice-lines.js --check   exit 1 if any line is missing (makes nothing)
//
// Needs the voice on disk: npm run setup:voice. Runs before every dist:companion.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createVoice } = require('../companion/src/voice');
const { LINES, createLineCache, fileName, readWav, voiceKeyOf } = require('../companion/src/voice/lines');
const Tour = require('../companion/src/tour');

const OUT = path.join(__dirname, '..', 'vendor', 'voice-lines');
const CHECK = process.argv.includes('--check');

// Every line the app keeps for the voice it ships with. The greeting with the person's name is
// not here: it is made on their computer, once, after they say their name.
function wantedLines() { return [...new Set(LINES.concat(Tour.cachedLines()))].filter(Boolean); }

async function main() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nus-voice-lines-'));
  const voice = createVoice({ userData: scratch, settings: { get: () => ({}) }, log: () => {} });
  const st = voice.status();
  const v = voice.VOICES[st.voice];
  if (!st.installed || !v || st.voice === 'system') { console.error('The voice is not on disk (vendor/voice). Run: npm run setup:voice'); process.exit(2); }
  const key = voiceKeyOf(st.voice, v);
  const want = wantedLines();
  const names = new Map(want.map((l) => [fileName(key, l), l]));
  fs.mkdirSync(OUT, { recursive: true });
  const good = (name) => { try { return Boolean(readWav(fs.readFileSync(path.join(OUT, name)))); } catch (_) { return false; } };
  const missing = [...names.keys()].filter((n) => !good(n));

  if (CHECK) {
    console.log('voice lines for ' + key + ': ' + (names.size - missing.length) + ' of ' + names.size + ' on disk');
    process.exit(missing.length ? 1 : 0);
  }

  // The same cache the app writes with, pointed at the shipped folder, so names and format match.
  const cache = createLineCache({ dir: OUT, voiceKey: () => key, synth: (line) => voice.synth(line), keep: () => true, log: (m) => console.log('  ' + m) });
  const t0 = Date.now();
  if (missing.length) {
    console.log('making ' + missing.length + ' of ' + names.size + ' lines in ' + st.voice + ' ...');
    await cache.prerender(want);
  }
  try { voice.close(); } catch (_) { /* gone */ }

  // A line that is no longer said is not shipped.
  let dropped = 0;
  for (const f of fs.readdirSync(OUT)) { if (f.endsWith('.wav') && !names.has(f)) { fs.unlinkSync(path.join(OUT, f)); dropped++; } }
  const still = [...names.keys()].filter((n) => !good(n));
  let bytes = 0, secs = 0;
  for (const n of names.keys()) { try { const b = fs.readFileSync(path.join(OUT, n)); bytes += b.length; const a = readWav(b); secs += a ? a.secs : 0; } catch (_) { /* counted as missing */ } }
  fs.writeFileSync(path.join(OUT, 'lines.json'), JSON.stringify({ voice: key, lines: names.size, seconds: Math.round(secs), bytes }, null, 1) + '\n');
  console.log('voice lines for ' + key + ': ' + (names.size - still.length) + ' of ' + names.size + ' on disk, ' + missing.length + ' made in ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s, '
    + dropped + ' old dropped, ' + Math.round(secs) + ' s of speech, ' + (bytes / 1048576).toFixed(1) + ' MB');
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (_) { /* temp */ }
  process.exit(still.length ? 1 : 0);
}

if (require.main === module) main().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
module.exports = { wantedLines, OUT };
