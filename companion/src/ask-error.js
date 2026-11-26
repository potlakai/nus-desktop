'use strict';

// A failed ask, in one sentence the person can act on. Feedback 2026-10-23 to
// 10-27 (#21, #82, #92, #98, #116, #120) was the bubble printing provider JSON:
// Gemini 429 quota, Gemini 503 high demand, a Claude Code 402 credits error,
// "fetch failed". The raw text still goes to the log and to "Tell Pranav";
// only the bubble gets this.
//
// Pure, no Electron: the guide, Hands, the assignment helper and index.js all
// call it. get-started.js keeps its own words for the key box ("paste it here").

const NAMES = { publik: 'publik', gemini: 'Gemini', anthropic: 'Anthropic', openai: 'OpenAI', nvidia: 'Nvidia', cli: 'Claude Code', 'claude-code': 'Claude Code', 'claude (desktop)': 'Claude Code' };

const NET = /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed|network|getaddrinfo|socket hang up/i;
const SIGNED_OUT = /cli_not_logged_in|not logged in|\/login|failed to authenticate|oauth|session expired/i;

// Who answered, from the provider id, or from the error text when the caller
// does not know (a Claude Code error starts "cli_", Gemini names its host).
function providerName(provider, text) {
  const p = String(provider || '').toLowerCase();
  if (NAMES[p]) return NAMES[p];
  if (/^cli_|claude code/i.test(text)) return 'Claude Code';
  if (/generativelanguage|gemini/i.test(text)) return 'Gemini';
  if (/anthropic|x-api-key/i.test(text)) return 'Anthropic';
  if (/nvidia|nvapi/i.test(text)) return 'Nvidia';
  return '';
}

// publik API's own failures (companion/src/publik): an empty balance shows Publik's message,
// one line on what to do, and the bubble's Top up button carries Publik's one link.
let publik = null;
try { publik = require('./publik'); } catch (_) { publik = null; }

function plainAskError(provider, raw) {
  const text = String((raw && raw.message) || raw || '');
  if (publik && (String(provider || '').toLowerCase() === 'publik' || Number(raw && raw.status) === 402)) {
    const line = publik.errorLine(raw);
    if (line) return line;
  }
  const name = providerName(provider, text);
  const who = name || 'the AI';
  const Who = name || 'The AI';
  const keys = 'Settings > Keys';
  // Already one of ours (the no-key copy, a spend cap): keep it.
  if (/^No AI is set up/i.test(text)) return text;
  if (/no_ai/i.test(text)) return 'No AI is set up yet. Add a free Gemini key in ' + keys + ', or sign in to Claude Code.';
  if (/aborted|AbortError/i.test(text)) return 'Stopped.';
  if (SIGNED_OUT.test(text)) return 'Claude Code is signed out on this computer. The quick fix: paste a free Gemini key on the dashboard, under Settings, Keys. Or sign Claude Code back in.';
  if (NET.test(text)) return 'I could not reach ' + who + '. Check your internet and ask again.';
  // Before the quota check: Anthropic's credit error mentions billing too.
  if (/\b402\b|more credits|credit balance|insufficient.{0,12}credit|out of credits/i.test(text)) {
    return Who + ' is out of credits on this account. Add credit there, or use a free Gemini key in ' + keys + '.';
  }
  if (/cli_spend_limit|usage limit/i.test(text)) return 'Claude Code is out of usage on your plan for now. Try again later, or add a free Gemini key in ' + keys + '.';
  if (/\b429\b|RESOURCE_EXHAUSTED|quota|rate.?limit|too many requests/i.test(text)) {
    if (name === 'Gemini') return 'Your free Gemini key hit its limit. Wait a minute and ask again. If it keeps happening, today\'s free asks are used up; they come back tomorrow.';
    return Who + ' hit its usage limit. Wait a minute and ask again.';
  }
  if (/\b50[234]\b|\b529\b|UNAVAILABLE|overloaded|high demand|temporarily/i.test(text)) return Who + ' is busy right now. Ask again in a few seconds.';
  // Claude Code gave no word in time, and the pool says why (src/claude-pool.js quietEnd, 0.1.32).
  // Overloaded, rate limits, signed out and no plan are caught by the lines above.
  if (/kept retrying: no response from Claude/i.test(text)) return 'Claude Code could not reach Claude. Check your internet and ask again.';
  if (/Claude Code did not start within/i.test(text)) return 'Claude Code did not start in time on this computer. Ask again. If it keeps happening, a free Gemini key in ' + keys + ' answers without it.';
  if (/kept retrying: /i.test(text)) return 'Claude Code could not get an answer from Claude just now. Ask again in a minute.';
  if (/timed? ?out|cli_timeout|deadline/i.test(text)) return Who + ' took too long to answer. Ask again.';
  if (/API key not valid|API_KEY_INVALID|invalid.{0,12}(api.?)?key|authentication|unauthori[sz]ed|\b401\b/i.test(text)) return Who + ' did not accept your key. Check it in ' + keys + '; the Test button there says what is wrong.';
  if (/PERMISSION_DENIED|SERVICE_DISABLED|forbidden|\b403\b/i.test(text)) return Who + ' refused this key. Check it in ' + keys + '.';
  if (/location|region|not supported in your/i.test(text)) return 'Gemini\'s free key does not work where you are. Claude Code or an Anthropic key in ' + keys + ' works instead.';
  if (/\b404\b|\b410\b|not found|no longer available|end of life/i.test(text)) return Who + ' no longer offers the model Nūs asked for. Use another key in ' + keys + ' for now.';
  if (/SAFETY|blocked|content policy|refus/i.test(text)) return Who + ' would not answer that one. Try asking another way.';
  if (/incomplete model reply|max_tokens|MAX_TOKENS/i.test(text)) return 'The answer got cut off. Ask again, or ask for less at once.';
  if (/empty reply/i.test(text)) return Who + ' sent back nothing. Ask again.';
  return 'Something went wrong getting an answer from ' + who + '. Ask again, and if it keeps happening, tell Pranav from the Feedback button.';
}

// Pure: the person's own key or Claude Code is the reason this ask failed, and asking again will
// not fix it soon (quota used up, no credit, key refused, model gone, signed out, nothing set up).
// Feedback 2026-11-08 to 11-14: all nine error reports were this, five of them Gemini's free
// quota. A build with publik then offers one tap to "Switch to publik" (index.js). Not for a
// dropped connection, a busy model, a timeout or a refusal: those pass, or are not the key's fault.
function ownKeyStuck(provider, raw) {
  if (String(provider || '').toLowerCase() === 'publik') return false;
  const text = String((raw && raw.message) || raw || '');
  if (!text || /aborted|AbortError/i.test(text)) return false;
  if (/^No AI is set up|no_ai/i.test(text)) return true;
  if (SIGNED_OUT.test(text) || /cli_spawn_failed|cli_not_found|cli_spend_limit|usage limit/i.test(text)) return true;
  if (NET.test(text)) return false;
  if (/\b402\b|more credits|credit balance|insufficient.{0,12}credit|out of credits/i.test(text)) return true;
  if (/\b429\b|RESOURCE_EXHAUSTED|quota|rate.?limit|too many requests/i.test(text)) return true;
  if (/\b50[234]\b|\b529\b|UNAVAILABLE|overloaded|high demand|temporarily|timed? ?out|cli_timeout|deadline/i.test(text)) return false;
  if (/API key not valid|API_KEY_INVALID|invalid.{0,12}(api.?)?key|authentication|unauthori[sz]ed|\b401\b/i.test(text)) return true;
  if (/PERMISSION_DENIED|SERVICE_DISABLED|forbidden|\b403\b/i.test(text)) return true;
  if (/location|region|not supported in your/i.test(text)) return true;
  if (/\b404\b|\b410\b|not found|no longer available|end of life/i.test(text)) return true;
  return false;
}

module.exports = { plainAskError, providerName, ownKeyStuck };
