'use strict';
// The voice, in its own process: loads a Kokoro model through sherpa-onnx and
// turns one line of text at a time into 24 kHz samples. Lives apart from the
// UI so a slow sentence never stalls the Knot; the main process queues lines
// and the renderer plays them in order (voice/index.js).
//
// Messages in:  { type: 'load', dir, speaker, threads }  { type: 'say', id, text, speed }  { type: 'stop' }
// Messages out: { type: 'ready', sampleRate, speakers, ms } { type: 'audio', id, sampleRate, pcm: Int16 bytes, ms, secs }
//               { type: 'error', id?, message }
const path = require('path');
const fs = require('fs');

let tts = null, speaker = 0, stopped = 0;

function send(m) { if (process.send) process.send(m); }

function load({ dir, speaker: sid, threads }) {
  const t0 = Date.now();
  const sherpa = require('sherpa-onnx-node');
  const modelFile = fs.existsSync(path.join(dir, 'model.onnx')) ? 'model.onnx' : 'model.int8.onnx';
  const lexicon = ['lexicon-gb-en.txt', 'lexicon-us-en.txt'].map((f) => path.join(dir, f)).filter((f) => fs.existsSync(f)).join(',');
  tts = new sherpa.OfflineTts({
    model: { kokoro: { model: path.join(dir, modelFile), voices: path.join(dir, 'voices.bin'), tokens: path.join(dir, 'tokens.txt'), dataDir: path.join(dir, 'espeak-ng-data'), lexicon, lang: 'en-us' }, numThreads: Math.max(1, Number(threads) || 2), debug: 0, provider: 'cpu' },
    maxNumSentences: 1,
  });
  speaker = Number(sid) || 0;
  send({ type: 'ready', sampleRate: tts.sampleRate, speakers: tts.numSpeakers, model: modelFile, ms: Date.now() - t0 });
}

function say({ id, text, speed }) {
  if (!tts) { send({ type: 'error', id, message: 'voice not loaded' }); return; }
  const gen = stopped;
  const t0 = Date.now();
  const line = String(text || '').replace(/\s+/g, ' ').trim();
  if (!line) { send({ type: 'audio', id, sampleRate: tts.sampleRate, pcm: Buffer.alloc(0), ms: 0, secs: 0 }); return; }
  // Electron's Node refuses N-API external buffers, so the samples are copied in.
  const audio = tts.generate({ text: line, sid: speaker, speed: Number(speed) || 1.0, enableExternalBuffer: false });
  if (gen !== stopped) return;                       // cut off while it was being made
  const n = audio.samples.length;
  const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) { const v = Math.max(-1, Math.min(1, audio.samples[i])); pcm.writeInt16LE(Math.round(v * 32767), i * 2); }
  send({ type: 'audio', id, sampleRate: audio.sampleRate, pcm, ms: Date.now() - t0, secs: n / audio.sampleRate });
}

process.on('message', (m) => {
  try {
    if (!m) return;
    if (m.type === 'load') load(m);
    else if (m.type === 'say') say(m);
    else if (m.type === 'stop') stopped++;
  } catch (e) { send({ type: 'error', id: m && m.id, message: String(e && e.message || e).slice(0, 300) }); }
});
process.on('disconnect', () => process.exit(0));
// Silence the lexicon's "Duplicated word" chatter; real errors come back as messages.
process.stderr.write = () => true;
send({ type: 'hello' });
