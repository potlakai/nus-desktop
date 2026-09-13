// Speech-to-text factory. Decoupled from the LLM provider because Anthropic has
// no audio API; we transcribe with whatever audio-capable key is available, and
// fall back across providers. Returns { text, provider } or { text:'', error }.
const { pcmToWav } = require('./wav');

async function transcribeOpenAI(apiKey, wav, model, signal) {
  const OpenAI = require('openai');
  const toFile = OpenAI.toFile || require('openai/uploads').toFile;
  const client = new OpenAI({ apiKey });
  const file = await toFile(wav, 'audio.wav', { type: 'audio/wav' });
  const res = await client.audio.transcriptions.create({ file, model: model || 'whisper-1' }, { signal });
  return (res.text || '').trim();
}

async function transcribeGemini(apiKey, wav, signal) {
  const { GoogleGenAI } = require('@google/genai');
  const ai = new GoogleGenAI({ apiKey });
  const res = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    config: { abortSignal: signal },
    contents: [{ role: 'user', parts: [
      { text: 'Transcribe this audio verbatim. Return only the spoken words with no commentary. If there is no clear speech, return an empty response.' },
      { inlineData: { mimeType: 'audio/wav', data: wav.toString('base64') } }
    ] }]
  });
  return ((res && res.text) || '').trim();
}

function createSTT(settings) {
  const keys = settings.apiKeys || {};
  const chain = [];
  // Local whisper.cpp first: free, offline, and keyless. Cloud keys stay as
  // fallbacks so a missing binary never silently kills listening.
  let sttLocal = null;
  try { sttLocal = require('../../src/stt-local'); } catch { sttLocal = null; }
  if (sttLocal && sttLocal.status().available) {
    chain.push({ p: 'local', fn: async (_wav, pcm, options) => {
      const res = await sttLocal.transcribePcm(pcm, options);
      if (res.error) throw new Error(res.error);
      return res.text || '';
    } });
  }
  if (keys.openai) chain.push({ p: 'openai', fn: (wav, _pcm, options) => transcribeOpenAI(keys.openai, wav, settings.sttModel, options.signal) });
  if (keys.gemini) chain.push({ p: 'gemini', fn: (wav, _pcm, options) => transcribeGemini(keys.gemini, wav, options.signal) });

  return {
    available: chain.length > 0,
    providers: chain.map((c) => c.p),
    async transcribe(pcm, options = {}) {
      if (!chain.length || !pcm || pcm.length < 3200) return { text: '' };
      const wav = pcmToWav(pcm, 16000, 1);
      let lastErr = null;
      for (const c of chain) {
        if (options.signal && options.signal.aborted) return { text: '', cancelled: true };
        try {
          const text = await c.fn(wav, pcm, options);
          if (options.signal && options.signal.aborted) return { text: '', cancelled: true };
          return { text, provider: c.p };
        } catch (e) {
          lastErr = { status: e && e.status, code: e && e.code, message: (e && e.message) || String(e), provider: c.p };
        }
      }
      if (options.signal && options.signal.aborted) return { text: '', cancelled: true };
      return { text: '', error: lastErr };
    }
  };
}

module.exports = { createSTT };
