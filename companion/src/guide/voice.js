// Voice, the small pure part: cleaning a whisper transcript and deciding
// what an utterance means to the Knot. The audio path lives in main.
'use strict';

// Whisper adds noise tags like [BLANK_AUDIO] and (wind blowing); strip them
// and drop utterances that were nothing but noise.
function cleanTranscript(text) {
  const t = String(text || '').replace(/\[[^\]]*\]/g, '').replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
  return t.length > 1 ? t : '';
}

const DISMISS = /^(?:ok(?:ay)?[,.! ]+)?(?:wind (?:it )?(?:back )?up|thanks?(?: you)?(?: n[uū]s)?|never ?mind|stop|cancel|that'?s (?:all|it|enough)|go away|leave me alone|dismiss)[.!]?$/i;
const NEXT = /^(?:ok(?:ay)?[,.! ]+)?(?:next|next step|done|go on|continue|what'?s next|and then)[.!?]?$/i;

// -> { kind:'dismiss'|'next'|'ask', text }
function classifyUtterance(text) {
  const t = cleanTranscript(text);
  if (!t) return { kind: 'empty', text: '' };
  if (DISMISS.test(t)) return { kind: 'dismiss', text: t };
  if (NEXT.test(t)) return { kind: 'next', text: t };
  return { kind: 'ask', text: t };
}

const PARTIAL_WINDOW_S = 20;
// Incremental preview: the audio after the frozen head is transcribed on each
// pass; once that segment is longer than windowS it is frozen into the head
// (its text kept, its end remembered) so every pass stays bounded.
// -> { head: frozen text or null, pcm: the audio to transcribe now, freeze }
function partialWindow(whole, partialHead, windowS) {
  const bytes = windowS * 16000 * 2;
  const headEnd = partialHead && partialHead.text ? Math.min(whole.length, partialHead.endSample * 2) : 0;
  const pcm = headEnd ? whole.subarray(headEnd) : whole;
  return { head: headEnd ? partialHead.text : null, pcm, freeze: pcm.length >= bytes };
}

module.exports = { cleanTranscript, classifyUtterance, partialWindow, PARTIAL_WINDOW_S };

