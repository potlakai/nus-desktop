const DEBUG = false; // Set to false to disable debug logging
// LLM factory: OpenAI / Anthropic / Gemini behind one streaming interface.
// stream({ system, turns:[{role,text}], imageDataUrl, maxTokens, onToken }) -> Promise<fullText>

function stripDataUrl(dataUrl) {
  const m = /^data:(.+?);base64,(.*)$/s.exec(dataUrl || '');
  return m ? { mime: m[1], b64: m[2] } : null;
}

// idleAfterTextMs: some servers send the whole reply and then neither a finish
// chunk nor [DONE], and hold the connection open for minutes (raw SSE probe
// 2026-11-15: 2 of 8 calls). With this set, once text has arrived, that long
// without a new token ends the call with the text.
const IDLE_AFTER_TEXT_MS = 2500;
// The old name of the same guard, kept as an alias so an import written against
// the previous release still resolves. New code should use IDLE_AFTER_TEXT_MS.
const PUBLIK_IDLE_AFTER_TEXT_MS = IDLE_AFTER_TEXT_MS;
// extra: fields one provider needs in the request body and others would refuse (Nvidia's
// Nemotron takes reasoning_effort; see nvidiaArgs).
async function streamOpenAI({ apiKey, model, system, turns, imageDataUrl, maxTokens, onToken = () => {}, baseURL, signal, idleAfterTextMs, extra }) {
  if (idleAfterTextMs > 0) return streamUntilIdle({ apiKey, model, system, turns, imageDataUrl, maxTokens, onToken, baseURL, signal, extra }, idleAfterTextMs);
  if (DEBUG) console.log('[DEBUG LLM] streamOpenAI called', { model, baseURL, hasImage: !!imageDataUrl, maxTokens });
  const OpenAI = require('openai');
  const client = new OpenAI({ apiKey, baseURL });
  const messages = [{ role: 'system', content: system }];
  let imageAttached = false;
  turns.forEach((t, i) => {
    const last = i === turns.length - 1;
    if (last && imageDataUrl && t.role === 'user') {
      imageAttached = true;
      messages.push({ role: 'user', content: [
        { type: 'text', text: t.text },
        { type: 'image_url', image_url: { url: imageDataUrl } }
      ] });
    } else {
      messages.push({ role: t.role, content: t.text });
    }
  });
  if (imageDataUrl && !imageAttached) {
    messages.push({ role: 'user', content: [{ type: 'image_url', image_url: { url: imageDataUrl } }] });
  }
  if (DEBUG) console.log('[DEBUG LLM] streamOpenAI sending request to OpenAI SDK with messages count:', messages.length);
  try {
    // signal: a stop (Esc, "stop") closes the stream instead of letting the
    // reply run to completion (2026-10-31; the Anthropic and Gemini paths already did).
    const stream = await client.chat.completions.create({ ...(extra || {}), model, messages, stream: true, max_tokens: maxTokens }, signal ? { signal } : undefined);
    let full = '';
    for await (const part of stream) {
      if (signal && signal.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
      const d = part.choices && part.choices[0] && part.choices[0].delta && part.choices[0].delta.content;
      if (d) { full += d; onToken(d); }
    }
    if (DEBUG) console.log('[DEBUG LLM] streamOpenAI finished successfully, total length:', full.length);
    return full;
  } catch (err) {
    if (DEBUG) console.error('[DEBUG LLM] streamOpenAI error:', err);
    throw err;
  }
}

// A reply that has reached the end of a sentence, a tag or a line. One that goes
// quiet mid-word or mid-sentence ("Click ") gets one more idle window before it
// is taken as it is, so a slow chunk is never cut short at the first pause.
const LOOKS_FINISHED = /[.!?\])"'`*:;’”…]\s*$|\n\s*$/;
function streamUntilIdle(args, idleMs) {
  const inner = new AbortController();
  const outer = args.signal;
  let full = '', timer = null, idled = false, waitedOnce = false;
  const onAbort = () => inner.abort();
  if (outer) { if (outer.aborted) inner.abort(); else outer.addEventListener('abort', onAbort, { once: true }); }
  const quiet = () => {
    if (!waitedOnce && !LOOKS_FINISHED.test(full)) { waitedOnce = true; timer = setTimeout(quiet, idleMs); if (timer.unref) timer.unref(); return; }
    idled = true; inner.abort();
  };
  const arm = () => { clearTimeout(timer); timer = setTimeout(quiet, idleMs); if (timer.unref) timer.unref(); };
  const onToken = (d) => { full += d; arm(); if (args.onToken) args.onToken(d); };
  const done = () => { clearTimeout(timer); if (outer) outer.removeEventListener('abort', onAbort); };
  return streamOpenAI({ ...args, signal: inner.signal, onToken }).then(
    (text) => { done(); if (outer && outer.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; } return idled ? full : text; },
    (err) => { done(); if (idled && !(outer && outer.aborted) && full) return full; throw err; });
}

// effort: 'low' | 'medium' | 'high' | ... (output_config.effort). Current Claude
// models think by default and the thinking counts against max_tokens, so a
// small budget can come back with no text at all: the floor below is for that.
async function streamAnthropic({ apiKey, model, system, turns, imageDataUrl, maxTokens, onToken = () => {}, effort, signal, onUsage, assignment }) {
  if (DEBUG) console.log('[DEBUG LLM] streamAnthropic called', { model, hasImage: !!imageDataUrl, maxTokens });
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey, ...(assignment ? { maxRetries: 0, timeout: 60000 } : {}) });
  const messages = turns.map((t, i) => {
    const last = i === turns.length - 1;
    if (last && imageDataUrl && t.role === 'user') {
      const img = stripDataUrl(imageDataUrl);
      const content = [];
      if (img) content.push({ type: 'image', source: { type: 'base64', media_type: img.mime, data: img.b64 } });
      content.push({ type: 'text', text: t.text });
      return { role: 'user', content };
    }
    return { role: t.role, content: t.text };
  });
  if (DEBUG) console.log('[DEBUG LLM] streamAnthropic sending request to Anthropic SDK with messages count:', messages.length);
  try {
    // The system prompt is marked for the prompt cache: it is the same on every
    // guide step and every walkthrough problem, so only the screenshot and the
    // question are read fresh. Keep anything that changes per turn out of it.
    const cachedSystem = system ? [{ type: 'text', text: String(system), cache_control: { type: 'ephemeral' } }] : undefined;
    const request = { model, max_tokens: assignment ? Number(maxTokens) || 4096 : Math.max(Number(maxTokens) || 0, 4096), system: cachedSystem, messages, stream: true };
    if (effort && !/haiku/i.test(model)) request.output_config = { effort: String(effort) };
    const stream = await client.messages.create(request, { signal });
    let full = '';
    let usage = {}, stopReason = '';
    for await (const ev of stream) {
      if (ev.type === 'message_start') usage = { ...usage, ...ev.message.usage };
      if (ev.type === 'message_delta') { usage = { ...usage, ...ev.usage }; stopReason = ev.delta?.stop_reason || stopReason; }
      if (ev.type === 'message_delta' && onUsage && usage.input_tokens != null && usage.output_tokens != null) onUsage(usage);
      if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') { full += ev.delta.text; onToken(ev.delta.text); }
    }
    if (assignment && stopReason && stopReason !== 'end_turn') throw new Error('incomplete model reply: ' + stopReason);
    if (DEBUG) console.log('[DEBUG LLM] streamAnthropic finished successfully, total length:', full.length);
    return full;
  } catch (err) {
    if (DEBUG) console.error('[DEBUG LLM] streamAnthropic error:', err);
    throw err;
  }
}

// Same contract as streamAnthropic: signal aborts the losing lane, json asks
// for a JSON object, onUsage settles the spend ledger, assignment refuses a
// truncated reply. Until 2026-09-30 all four were dropped on the floor here,
// so a Gemini-key assignment run could neither cancel nor settle.
async function streamGemini({ apiKey, model, system, turns, imageDataUrl, maxTokens, onToken, signal, json, onUsage, assignment }) {
  if (DEBUG) console.log('[DEBUG LLM] streamGemini called', { model, hasImage: !!imageDataUrl, maxTokens });
  const { GoogleGenAI } = require('@google/genai');
  const ai = new GoogleGenAI({ apiKey });
  const contents = turns.map((t, i) => {
    const last = i === turns.length - 1;
    const parts = [{ text: t.text }];
    if (last && imageDataUrl && t.role === 'user') {
      const img = stripDataUrl(imageDataUrl);
      if (img) parts.push({ inlineData: { mimeType: img.mime, data: img.b64 } });
    }
    return { role: t.role === 'assistant' ? 'model' : 'user', parts };
  });
  const hasImage = contents.some((c) => (c.parts || []).some((p) => p.inlineData));
  if (imageDataUrl && !hasImage) {
    const img = stripDataUrl(imageDataUrl);
    if (img) contents.push({ role: 'user', parts: [{ inlineData: { mimeType: img.mime, data: img.b64 } }] });
  }
  if (DEBUG) console.log('[DEBUG LLM] streamGemini sending request to Google SDK with contents count:', contents.length);
  try {
    const config = { systemInstruction: system };
    if (signal) config.abortSignal = signal;
    if (maxTokens) config.maxOutputTokens = Math.max(Number(maxTokens) || 0, 1024);
    if (json) config.responseMimeType = 'application/json';
    // Flash thinks by default and the thinking is paid in silence before the
    // first token (completeGemini already turns it off, 2026-09-15). The chat
    // panel and other stream callers get the same rule; an assignment lane
    // keeps thinking, that is what it is for.
    if (!assignment && /flash/i.test(String(model))) config.thinkingConfig = { thinkingBudget: 0 };
    const stream = await ai.models.generateContentStream({ model, contents, config });
    let full = '';
    let lastFinishReason = 'UNKNOWN';
    let usage = null;
    for await (const chunk of stream) {
      if (signal && signal.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
      const t = chunk && chunk.text;
      if (t) { full += t; onToken(t); }
      if (chunk && chunk.candidates && chunk.candidates[0] && chunk.candidates[0].finishReason) {
        lastFinishReason = chunk.candidates[0].finishReason;
      }
      const u = chunk && chunk.usageMetadata;
      if (u && Number.isFinite(u.promptTokenCount) && Number.isFinite(u.candidatesTokenCount)) usage = { input_tokens: u.promptTokenCount, output_tokens: u.candidatesTokenCount };
    }
    if (usage && onUsage) onUsage(usage);
    if (assignment && lastFinishReason && !/^(STOP|UNKNOWN)$/.test(lastFinishReason)) throw new Error('incomplete model reply: ' + lastFinishReason);
    if (DEBUG) console.log('[DEBUG LLM] streamGemini finished successfully, total length:', full.length, 'finishReason:', lastFinishReason);
    return full;
  } catch (err) {
    if (DEBUG) console.error('[DEBUG LLM] streamGemini error:', err);
    throw err;
  }
}

// One non-streaming answer. json:true asks the provider for a JSON object
// where the SDK supports it (Gemini); elsewhere the prompt carries the
// contract and the caller parses tolerantly. Used for pointing, where a
// small, fast, structured reply matters more than tokens on screen.
async function completeGemini({ apiKey, model, system, turns, imageDataUrl, maxTokens, json, onDelta, signal }) {
  const { GoogleGenAI } = require('@google/genai');
  const ai = new GoogleGenAI({ apiKey });
  const contents = turns.map((t, i) => {
    const last = i === turns.length - 1;
    const parts = [{ text: t.text }];
    if (last && imageDataUrl && t.role === 'user') {
      const img = stripDataUrl(imageDataUrl);
      if (img) parts.push({ inlineData: { mimeType: img.mime, data: img.b64 } });
    }
    return { role: t.role === 'assistant' ? 'model' : 'user', parts };
  });
  // Gemini 3.x Flash thinks by default and the thinking counts against
  // maxOutputTokens: a 400-token budget came back as an EMPTY reply on every
  // guide step (2026-09-15). Thinking off for Flash, and a floor on the budget.
  const config = { systemInstruction: system, maxOutputTokens: Math.max(Number(maxTokens) || 0, 1024), temperature: 0.2 };
  if (/flash/i.test(String(model))) config.thinkingConfig = { thinkingBudget: 0 };
  if (json) config.responseMimeType = 'application/json';
  if (signal) config.abortSignal = signal;
  // A caller that can use text as it arrives (the guide speaks sentences
  // while the tags are still being written) gets the stream; the same config.
  if (typeof onDelta === 'function' && !json) {
    const stream = await ai.models.generateContentStream({ model, contents, config });
    let full = '';
    for await (const chunk of stream) {
      if (signal && signal.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
      const t = chunk && chunk.text;
      if (t) { full += t; onDelta(t); }
    }
    return full;
  }
  const res = await ai.models.generateContent({ model, contents, config });
  return (res && typeof res.text === 'string') ? res.text : (res && res.text) || '';
}

// Gemini answers 503 "This model is currently experiencing high demand" in bursts, and its SDK does
// not try again by itself (the OpenAI and Anthropic SDKs do). On 2026-11-21 seven first-day users
// sent that error from their first few asks. One quiet second try, and only when it is safe: nothing
// has been said or shown yet, nobody pressed stop, and it is not an assignment lane (those settle
// their own failures). A second failure is thrown as it is, so the person still gets the plain line.
const BUSY_RETRY_MS = 700;
function isBusy(err) {
  if (!err) return false;
  const status = Number(err.status || err.code);
  if (status === 502 || status === 503 || status === 504 || status === 529) return true;
  return /\b50[234]\b|\b529\b|UNAVAILABLE|overloaded|high demand/i.test(String(err.message || err));
}
function withBusyRetry(fn, waitMs = BUSY_RETRY_MS) {
  return async (args) => {
    let said = false;
    const heard = (cb) => (typeof cb === 'function' ? (t) => { said = true; return cb(t); } : cb);
    const a = { ...args, onToken: heard(args.onToken), onDelta: heard(args.onDelta) };
    const stopped = () => !!(args.signal && args.signal.aborted);
    try { return await fn(a); } catch (err) {
      if (said || stopped() || args.assignment || !isBusy(err)) throw err;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      if (stopped()) throw err;
      return fn(a);
    }
  };
}
const geminiStream = withBusyRetry(streamGemini);
const geminiComplete = withBusyRetry(completeGemini);

// On a Mac each request's instructions also say it is a Mac (companion/src/computer-words.js).
const { paramsWithComputer } = require('./computer-words');

// The extra providers, all served by streamOpenAI because they speak the same
// chat-completions shape. Only the base URL differs, so one table is enough.
//
// opencode go is the operator's own plan endpoint. Its model IDs were not
// published when this was written, so store.js leaves both tiers blank: an
// unset model keeps ready() false rather than 404ing on every ask.
const EXTRA_BASE_URLS = {
  groq: 'https://api.groq.com/openai/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  opencode: 'https://opencode.ai/zen/go/v1',
};
// Headers OpenRouter wants so requests can be attributed. Optional to it, and
// harmless to the others, but only sent where they make sense.
function extraHeaders(provider, settings) {
  if (provider !== 'openrouter') return undefined;
  return {
    // Attribution only. A personal build has no site to point at, so the
    // repository is named; OpenRouter uses it for its own dashboards.
    'HTTP-Referer': 'https://github.com/omsenjalia/nus-desktop',
    'X-Title': 'J.A.R.V.I.S',
  };
}
// A custom endpoint: anything OpenAI-shaped the operator points us at, including
// a local proxy. Trailing slashes are stripped so the SDK does not build //chat.
function customBaseUrl(settings) {
  return String((settings && settings.customBaseUrl) || '').trim().replace(/\/+$/, '');
}
// Everything except Anthropic and Gemini is served by streamOpenAI.
const OPENAI_COMPATIBLE = new Set(['openai', 'nvidia', 'ollama', 'groq', 'openrouter', 'opencode', 'custom']);
function isOpenAICompatible(provider) { return OPENAI_COMPATIBLE.has(provider); }

// Which providers need a key, and which can run without one. Ollama is local;
// a custom endpoint may be an unauthenticated local server.
function needsKey(provider) { return !['ollama', 'custom'].includes(provider); }
// One place that turns a provider name into streamOpenAI arguments, so stream()
// and complete() cannot drift apart.
function openAIArgsFor(provider, args, settings) {
  if (provider === 'nvidia') return nvidiaArgs(args);
  if (provider === 'ollama') return { ...args, baseURL: 'http://localhost:11434/v1' };
  if (EXTRA_BASE_URLS[provider]) {
    const headers = extraHeaders(provider, settings);
    return { ...args, baseURL: EXTRA_BASE_URLS[provider], extra_headers: headers };
  }
  if (provider === 'custom') {
    const base = customBaseUrl(settings);
    if (!base) throw new Error('custom provider has no base URL (Settings, Keys)');
    const headers = extraHeaders(provider, settings);
    return { ...args, baseURL: base, extra_headers: headers };
  }
  return args;
}

// Nvidia's OpenAI-compatible endpoint. Nemotron models think before answering unless told not to
// (reasoning_effort defaults to "high" there): slower asks, and the key Test's 8-token budget
// would be spent on thinking. Other Nvidia models refuse fields they do not list, so only
// Nemotron gets it.
const NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1';
function nvidiaArgs(args) {
  const extra = /nemotron/i.test(String(args.model || '')) ? { reasoning_effort: 'none' } : undefined;
  return { ...args, baseURL: NVIDIA_BASE_URL, extra };
}

// opts.ownKey: test settings.provider's own key even when something else would answer the
// asks. The Test button in Settings uses it (0.1.36).
function createLLM(settings, opts = {}) {
  // NUS_COMPANION_CLAUDE_API=1 (launch-day1.ps1 -ClaudeApi): Claude through the
  // ANTHROPIC_API_KEY already in the environment, whatever the settings say.
  // Opt-in because it spends API credits; the key is never written to settings.
  const envClaude = process.env.NUS_COMPANION_CLAUDE_API === '1' && !!process.env.ANTHROPIC_API_KEY;
  const provider = envClaude ? 'anthropic' : settings.provider;
  const keys = settings.apiKeys || {};
  const apiKey = envClaude ? process.env.ANTHROPIC_API_KEY : keys[provider];
  const tier = settings.smart ? 'smart' : 'fast';
  const model = envClaude ? (process.env.NUS_COMPANION_CLAUDE_MODEL || 'claude-sonnet-5') : ((settings.models || {})[provider] || {})[tier];

  // Set to 4096 (effectively unlimited for a single response) 
  // since some SDKs like Anthropic require a maxTokens value.
  const maxTokens = 4096;

  if (DEBUG) console.log('[DEBUG LLM] createLLM initialized:', { provider, model, isKeyPresent: !!apiKey, ready: (!!apiKey || !needsKey(provider)) && !!model });

  return {
    provider, model, apiKey,
    // Ready means "an ask would reach a model": a key where one is needed, a
    // model ID, and for a custom endpoint a base URL to send it to. Ollama needs
    // neither a key nor a URL.
    ready: (!!apiKey || !needsKey(provider)) && !!model && (provider !== 'custom' || !!customBaseUrl(settings)),
    async stream(params) {
      if (DEBUG) console.log('[DEBUG LLM] stream() invoked for provider:', provider);
      const args = { apiKey, model, maxTokens, ...paramsWithComputer(params) };
      if (provider === 'anthropic') return streamAnthropic(args);
      if (provider === 'gemini') return geminiStream(args);
      if (isOpenAICompatible(provider)) return streamOpenAI(openAIArgsFor(provider, args, settings));
      throw new Error('unknown provider: ' + provider);
    },
    async complete(params = {}) {
      // params.model: one call on another model of the same provider (a problem
      // walkthrough wants the smart tier). Unset leaves the configured one.
      // params.onDelta: streamed text for callers that can use it as it arrives.
      const args = { apiKey, maxTokens: params.maxTokens || 512, ...paramsWithComputer(params), model: params.model || model, onToken: params.onToken || params.onDelta || (() => {}) };
      if (provider === 'gemini') return geminiComplete(args);
      // The other SDKs stream fine; collect and return.
      if (provider === 'anthropic') return streamAnthropic(args);
      if (isOpenAICompatible(provider)) return streamOpenAI(openAIArgsFor(provider, args, settings));
      throw new Error('unknown provider: ' + provider);
    }
  };
}

module.exports = { createLLM, streamOpenAI, nvidiaArgs, NVIDIA_BASE_URL, EXTRA_BASE_URLS, openAIArgsFor, isOpenAICompatible, needsKey, customBaseUrl, IDLE_AFTER_TEXT_MS, PUBLIK_IDLE_AFTER_TEXT_MS, LOOKS_FINISHED, withBusyRetry, isBusy, BUSY_RETRY_MS };
