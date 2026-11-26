// Voice, the small pure part: cleaning a whisper transcript and deciding
// what an utterance means to the Knot. The audio path lives in main.
'use strict';

// Whisper adds noise tags like [BLANK_AUDIO] and (wind blowing); strip them
// and drop utterances that were nothing but noise.
function cleanTranscript(text) {
  const t = String(text || '').replace(/\[[^\]]*\]/g, '').replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
  return t.length > 1 ? t : '';
}

// "I got it from here" cuts the Knot off mid-line, like "stop" (Pranav,
// 2026-10-13, from the reference reel).
const DISMISS = /^(?:(?:ok(?:ay)?|alright|cool|thanks|nah)[,.! ]+)?(?:wind (?:it )?(?:back )?up|thanks?(?: you)?(?: n[uū]s)?|never ?mind|stop(?: talking| it| there| please)?|cancel|that'?s (?:all|it|enough)|enough|go away|leave me alone|dismiss|(?:be )?quiet|shh+|hush|(?:i'?ve |i )?got it(?: from here)?|i(?:'ll| can| will) take it from here|i(?:'m| am) good(?: from here)?)[.!]?$/i;
const NEXT = /^(?:ok(?:ay)?[,.! ]+)?(?:next|next step|done|go on|continue|what'?s next|and then)[.!?]?$/i;

// -> { kind:'dismiss'|'next'|'ask', text }
function classifyUtterance(text) {
  const t = cleanTranscript(text);
  if (!t) return { kind: 'empty', text: '' };
  if (DISMISS.test(t)) return { kind: 'dismiss', text: t };
  if (NEXT.test(t)) return { kind: 'next', text: t };
  return { kind: 'ask', text: t };
}

module.exports = { cleanTranscript, classifyUtterance };
