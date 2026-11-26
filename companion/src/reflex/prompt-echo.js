'use strict';
// Did whisper answer with the hint list instead of the speech?
//
// Whisper is given a short prompt of names to expect (listen.js vocabularyPrompt).
// On a quiet or cut-off clip a decoder with its whole context can recite that
// prompt back as if it had been said. The careful decode of a whole press
// (listen.js whole) checks its answer here and, on an echo, keeps the words the
// fast pass heard.
//
// Adapted from OpenWhispr's dictionary echo filter, src/utils/dictionaryEchoFilter.js
// (github.com/OpenWhispr/openwhispr, MIT License, Copyright (c) 2024 OpenWhispr
// Team; see THIRD-PARTY.md): normalize, promptTerms and matchesDictionaryPrompt,
// as CommonJS, without the parts for other speech providers.

const normalize = (s) => String(s || '')
  .toLowerCase()
  .replace(/[^\p{L}\p{N}\s]/gu, '')
  .replace(/\s+/g, ' ')
  .trim();

const PROMPT_DELIMITER_RE = /[,、，]/;

// The hint list's entries, normalized, in the order the prompt carries them.
const promptTerms = (prompt) => String(prompt || '').split(PROMPT_DELIMITER_RE).map(normalize).filter(Boolean);

// True when text is the prompt said back: all of it, one phrase of it looped, or
// two or more of its entries in the order sent making up nearly all of the text.
function echoesPrompt(text, prompt) {
  if (!text || !prompt) return false;

  const terms = promptTerms(prompt);
  const normalizedPrompt = terms.join(' ');
  const normalizedText = promptTerms(text).join(' ');
  if (!normalizedText || !normalizedPrompt) return false;
  if (normalizedText === normalizedPrompt) return true;

  const textWords = normalizedText.split(' ');
  const promptWords = normalizedPrompt.split(' ');
  if (terms.length === 1) {
    // A single phrase can loop in full; repeating its first word is ordinary speech.
    return textWords.length % promptWords.length === 0 && textWords.every((word, index) => word === promptWords[index % promptWords.length]);
  }

  // Count only complete entries in the order sent. Shared vocabulary alone would
  // discard "Massachusetts General Hospital" for "General Hospital, Massachusetts".
  const transcript = ' ' + normalizedText + ' ';
  const uniqueTextWords = new Set(textWords);
  const matchedWords = new Set();
  let offset = 0;
  let matchedTerms = 0;
  for (const term of terms) {
    const words = term.split(' ');
    if (!uniqueTextWords.has(words[0])) continue;
    const start = transcript.indexOf(' ' + term + ' ', offset);
    if (start === -1) continue;
    offset = start + 1 + term.length;
    matchedTerms++;
    for (const word of words) matchedWords.add(word);
  }

  const textComposition = matchedWords.size / uniqueTextWords.size;
  const dictionaryUsage = matchedWords.size / new Set(promptWords).size;
  return matchedTerms >= 2 && textComposition >= 0.9 && dictionaryUsage >= 0.7;
}

module.exports = { echoesPrompt, promptTerms, normalize };
