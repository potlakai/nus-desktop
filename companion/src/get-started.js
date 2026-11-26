// The key helpers that outlived Get started: the Gemini key shape check, the
// plain-words provider errors Settings shows, and the answer source order. The
// first screen of a new install is the tour now (companion/src/tour.js).
//
// Pure Node, no Electron.

const AI_STUDIO_URL = 'https://aistudio.google.com/apikey';
// A Gemini key from AI Studio. New keys are auth keys that start with "AQ."
// (AI Studio stopped issuing the old kind in 2026); older ones are "AIza" and
// 35 more URL-safe characters. Anything else gets a sentence before a network
// call is spent on it.
function geminiKeyShape(raw) {
  const key = String(raw || '').trim().replace(/^["']|["']$/g, '');
  if (!key) return { ok: false, key, message: 'Paste the key from AI Studio here.' };
  if (/\s/.test(key)) return { ok: false, key, message: 'That has spaces in it. Copy only the key, it is one word that starts with AQ. or AIza.' };
  if (/^sk-ant-/i.test(key)) return { ok: false, key, message: 'That is an Anthropic key. Paste it in Settings, under Anthropic. This box takes a free Gemini key.' };
  if (/^AQ\./.test(key)) {
    if (!/^AQ\.[0-9A-Za-z_.-]{20,}$/.test(key)) return { ok: false, key, message: 'That key looks cut off. Copy the whole key again from AI Studio.' };
    return { ok: true, key, message: '' };
  }
  if (!/^AIza/.test(key)) return { ok: false, key, message: 'That does not look like a Gemini key. It starts with AQ. or AIza. Copy it again from AI Studio.' };
  if (!/^AIza[0-9A-Za-z_-]{35}$/.test(key)) return { ok: false, key, message: 'That key looks cut off. Copy the whole key again from AI Studio.' };
  return { ok: true, key, message: '' };
}

// Apple review fix 4: one sentence a person can act on, never provider JSON.
// The raw text stays available behind "Details" (scrubbed of the key by the host).
function plainKeyError(provider, raw) {
  const text = String(raw || '');
  const net = /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed|network|getaddrinfo|socket hang up/i;
  if (provider === 'cli') {
    if (/not installed|cli_missing/i.test(text)) return 'Claude Code is not on this computer. Use a free Gemini key instead.';
    if (/cli_not_logged_in|not logged in|login/i.test(text)) return 'Claude Code is installed but not signed in. Open a terminal, run claude, sign in, then press Try again.';
    if (/cli_spend_limit|usage limit|rate limit|quota/i.test(text)) return 'Claude Code says your plan is out of usage for now. Use a free Gemini key instead, or try again later.';
    if (/cli_timeout|timed? ?out/i.test(text)) return 'Claude Code took too long to answer. Press Try again.';
    return 'Claude Code did not answer. Press Try again, or use a free Gemini key instead.';
  }
  if (provider === 'gemini') {
    if (/no key/i.test(text)) return 'Paste the key from AI Studio here.';
    if (net.test(text)) return 'Nūs could not reach Google. Check your internet, then paste the key again.';
    if (/API key not valid|API_KEY_INVALID|invalid api key|INVALID_ARGUMENT|\b400\b/i.test(text)) return 'Google did not accept this key. Copy it again from AI Studio; it starts with AQ. or AIza.';
    if (/expired/i.test(text)) return 'This key has expired. Make a new one in AI Studio and paste it here.';
    if (/RESOURCE_EXHAUSTED|quota|rate limit|\b429\b/i.test(text)) return 'This key is out of free asks for now. Try again in a minute, or tomorrow.';
    if (/PERMISSION_DENIED|SERVICE_DISABLED|not been used|disabled|\b403\b/i.test(text)) return 'This key cannot use Gemini yet. Make the key in AI Studio, not in Google Cloud, and paste that one.';
    if (/location|region|not supported/i.test(text)) return 'Google does not offer the free Gemini key where you are. Claude Code or an Anthropic key in Settings works instead.';
    return 'That key did not work. Copy it again from AI Studio and paste it here.';
  }
  if (provider === 'nvidia') {
    if (/no key/i.test(text)) return 'Paste a key from build.nvidia.com first.';
    if (net.test(text)) return 'Nūs could not reach Nvidia. Check your internet, then press Test again.';
    if (/\b40[13]\b|unauthori[sz]ed|forbidden|invalid.{0,20}key/i.test(text)) return 'Nvidia did not accept this key. Copy it again from build.nvidia.com; it starts with nvapi-.';
    if (/\b402\b|credit|quota|\b429\b|rate limit/i.test(text)) return 'This Nvidia key is out of free credits or hit its limit. Try again later, or use a free Gemini key.';
    // 410 Gone: "The model ... has reached its end of life ... and is no longer available." (2026-11-16)
    if (/\b404\b|\b410\b|not found|no longer available|end of life/i.test(text)) return 'Nvidia no longer offers the model Nūs asked for. Use a free Gemini key for now.';
    return 'That key did not work. Copy it again from build.nvidia.com.';
  }
  if (provider === 'anthropic') {
    if (/no key/i.test(text)) return 'Paste an Anthropic key first.';
    if (net.test(text)) return 'Nūs could not reach Anthropic. Check your internet, then press Test again.';
    if (/credit|billing|balance/i.test(text)) return 'This Anthropic account has no credit left. Add credit in the Anthropic console, or use a free Gemini key.';
    if (/authentication|invalid x-api-key|\b401\b/i.test(text)) return 'Anthropic did not accept this key. Copy it again from the Anthropic console; it starts with sk-ant-.';
    if (/rate limit|\b429\b|overloaded|\b529\b/i.test(text)) return 'Anthropic is busy or this key hit its limit. Try again in a minute.';
    return 'That key did not work. Copy it again from the Anthropic console.';
  }
  if (provider === 'typesafe') {
    if (/no key/i.test(text)) return 'Paste a TypeSafe key first.';
    if (net.test(text)) return 'Nūs could not reach TypeSafe. Check your internet, then press Test again.';
    if (/\b401\b|\b403\b|unauthor|forbidden|invalid/i.test(text)) return 'TypeSafe did not accept this key. Copy it again from typesafe.ai.';
    return 'The voice commands key did not work. Copy it again from typesafe.ai.';
  }
  return 'That did not work. Try again.';
}

// Which answer source is ready, in the order the Knot uses them: its own key
// first, then Claude Code on this computer.
function answerSource({ keys = {}, cli = false, cliOk = false } = {}) {
  if (keys.gemini) return 'gemini';
  if (keys.anthropic) return 'anthropic';
  if (keys.nvidia) return 'nvidia';
  if (cli && cliOk) return 'claude-code';
  return null;
}

const SOURCE_LABELS = { gemini: 'Gemini', anthropic: 'Anthropic', nvidia: 'Nvidia', 'claude-code': 'Claude Code' };

module.exports = { AI_STUDIO_URL, SOURCE_LABELS, geminiKeyShape, plainKeyError, answerSource };
