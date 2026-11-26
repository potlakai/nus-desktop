'use strict';
// Parakeet v3, in its own process: loads the model through sherpa-onnx and turns
// a finished stretch of 16 kHz speech into text. Lives apart from the UI so a
// slow decode never stalls the Knot, and so its memory goes when the process
// does (voice/parakeet.js).
//
// Messages in:  { type: 'load', dir, threads }  { type: 'decode', id, pcm: Int16 bytes }
// Messages out: { type: 'hello' }  { type: 'ready', ms }
//               { type: 'text', id, text, ms, secs }  { type: 'error', id?, message }
const path = require('path');
const { pcm16ToFloat32 } = require('../wav');

const RATE = 16000;
let recognizer = null;

function send(m) { if (process.send) process.send(m); }

function load({ dir, threads }) {
  const t0 = Date.now();
  const sherpa = require('sherpa-onnx-node');
  recognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: RATE, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: path.join(dir, 'encoder.int8.onnx'), decoder: path.join(dir, 'decoder.int8.onnx'), joiner: path.join(dir, 'joiner.int8.onnx') },
      tokens: path.join(dir, 'tokens.txt'),
      modelType: 'nemo_transducer',
      numThreads: Math.max(1, Number(threads) || 4),
      provider: 'cpu',
      debug: 0,
    },
    decodingMethod: 'greedy_search',
  });
  send({ type: 'ready', ms: Date.now() - t0 });
}

function decode({ id, pcm }) {
  if (!recognizer) { send({ type: 'error', id, message: 'not loaded' }); return; }
  const t0 = Date.now();
  // The samples are made here and copied in. Electron's Node refuses N-API
  // external buffers, which sherpa's readWave hands out by default, so it is not used.
  const samples = pcm16ToFloat32(pcm);
  const stream = recognizer.createStream();
  stream.acceptWaveform({ samples, sampleRate: RATE });
  recognizer.decode(stream);
  const result = recognizer.getResult(stream);
  send({ type: 'text', id, text: String((result && result.text) || ''), ms: Date.now() - t0, secs: samples.length / RATE });
}

process.on('message', (m) => {
  try {
    if (!m) return;
    if (m.type === 'load') load(m);
    else if (m.type === 'decode') decode(m);
  } catch (e) { send({ type: 'error', id: m && m.id, message: String((e && e.message) || e).slice(0, 300) }); }
});
process.on('disconnect', () => process.exit(0));
send({ type: 'hello' });
