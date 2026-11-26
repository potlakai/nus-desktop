'use strict';
// Which asks are about the person's own memory, read by code (no model):
//
//   brief    "what's my brief", "what does my brief say about career"
//   today    "what's on my plate today", "what should I work on today"
//   merge    "look at my eigenvalues chat and my diagonalization chat and find the gap"
//   chats    "what did I ask Claude about FPL", "across my chats, ...", "in my chats ..."
//   recent   "what was I working on last week"
//   vault    "what's in my vault about the telemetry contract", "search my notes for ..."
//
// -> { kind, query, sinceMs, label, picks } or null. Anything else routes as before.

const CHAT = '(?:chats?|conversations?|threads?)';
const VENDOR = '(?:claude|chat ?gpt|gpt|gemini|the ai|ai|my ai)';
const QUESTION = /\b(what|whats|what's|which|when|where|who|why|how|did|do|does|have|has|was|were|is|are|find|search|show|tell|remind|look|pull|list|summari[sz]e|any)\b/i;

const BRIEF = /\b(my|the|today'?s|this morning'?s|morning)\s+(morning\s+)?brief\b(?!ing)|^\s*(brief|my brief|morning brief)\s*[.?!]*\s*$/i;
// Reading it, not doing something with it ("email the brief to Ankith" and
// "open my brief in Notepad" are Hands tasks).
const BRIEF_ASK = /^\s*(my\s+|morning\s+)?brief\s*[.?!]*\s*$|\b(what'?s|what\s+is|what\s+does|read|give\s+me|tell\s+me|play|go\s+over|run\s+(me\s+)?through|hear|summari[sz]e)\b/i;
const TODAY = [
  /\bwhat'?s on my plate\b/i,
  /\bwhat\s+(?:is|'s)\s+on\s+my\s+plate\b/i,
  /\bmy\s+(tasks|to-?dos?|to do list)\s+(for\s+)?today\b/i,
  /\btoday'?s\s+(tasks|to-?dos?)\b/i,
  /\bwhat\s+should\s+i\s+(do|work on|focus on|get done)\s+today\b/i,
];
const MERGE_VERB = /\b(merge|combine|compare|connect|cross[- ]?reference|put together|join|stitch)\b|\bfind\s+(the\s+)?gaps?\b|\bwhat'?s\s+the\s+gap\b|\bwhere'?s\s+the\s+gap\b|\bwhat\s+(am i|i'?m)\s+missing\b/i;
const CHATS = [
  new RegExp('\\b(my|our|those|these)\\s+(?:' + VENDOR + '\\s+)?' + CHAT + '\\b', 'i'),
  new RegExp('\\bwhat\\s+did\\s+i\\s+(ask|tell|say to|talk to|discuss with|ask about with)\\s+' + VENDOR + '\\b', 'i'),
  new RegExp('\\b(did|have)\\s+i\\s+(ever\\s+)?(ask|asked|tell|told|talk(ed)?\\s+to|discuss(ed)?)\\s+' + VENDOR + '\\b', 'i'),
  new RegExp('\\bwhen\\s+i\\s+(asked|was asking|talked to|was talking to)\\s+' + VENDOR + '\\b', 'i'),
  new RegExp('\\bin\\s+(my\\s+)?(claude|chat ?gpt|gemini)(\\s+' + CHAT + ')?\\b', 'i'),
  new RegExp('\\bwhat\\s+(did|does)\\s+(claude|chat ?gpt|gpt|gemini)\\s+(say|tell me|suggest|recommend)\\b', 'i'),
];
const RECENT = [
  /\bwhat\s+(was|were|have|had)\s+(i|we)\s+(been\s+)?(working on|doing|busy with|focused on|up to|building|thinking about)\b/i,
  /\b(last|this|past)\s+(week|few days|couple of days|month)\b.*\b(i|we)\s+(was|were|have been|had been)?\s*(working on|doing|busy with|focused on|building)\b/i,
  /\b(i|we)\s+(was|were)\s+(working on|doing|building)\b.*\b(last|this|past)\s+(week|few days|month)\b/i,
];
const VAULT = [
  /\b(in|from|across|search|check|through)\s+(my|the)\s+(vault|notes|second brain|obsidian)\b/i,
  /\bmy\s+(vault|notes|second brain|obsidian)\s+(say|says|have|has|about|on)\b/i,
  /\bwhat\s+do\s+(my|the)\s+(vault|notes)\b/i,
  /\b(vault|notes)\s+about\b/i,
];

function windowFor(text, now) {
  const t = String(text).toLowerCase();
  const d = 86400000;
  if (/\byesterday\b/.test(t)) return { sinceMs: now - 2 * d, label: 'since yesterday' };
  if (/\btoday\b|\bthis morning\b/.test(t)) return { sinceMs: now - d, label: 'today' };
  if (/\b(last|past)\s+(few|couple of)\s+days\b/.test(t)) return { sinceMs: now - 4 * d, label: 'the last few days' };
  if (/\bthis week\b/.test(t)) return { sinceMs: now - 7 * d, label: 'this week' };
  if (/\b(last|past)\s+week\b|\brecently\b|\blately\b/.test(t)) return { sinceMs: now - 14 * d, label: 'the last two weeks' };
  if (/\b(this|last|past)\s+month\b/.test(t)) return { sinceMs: now - 45 * d, label: 'the last month or so' };
  return { sinceMs: 0, label: '' };
}

// "my eigenvalues chat and my diagonalization one" -> ['eigenvalues', 'diagonalization'].
function mergePicks(text) {
  const quoted = Array.from(String(text).matchAll(/["\u201c']([^"\u201d']{3,80})["\u201d']/g)).map((m) => m[1].trim());
  if (quoted.length >= 2) return quoted.slice(0, 2);
  let s = String(text).replace(/[?.!]+$/, '');
  const between = /\bbetween\s+(.+)$/i.exec(s);
  if (between) s = between[1];
  else s = s.replace(/^.*?\b(merge|combine|compare|connect|cross[- ]?reference|put together|join|stitch|look at|read|take)\b\s*/i, '');
  s = s.replace(/\s*(,\s*)?(and\s+)?(then\s+)?(find|tell|show|figure out|what'?s|where'?s|what am i)\b.*$/i, '');
  const parts = s.split(/\s*(?:\band\b|\bwith\b|\bvs\.?\b|\bversus\b|&|,)\s*/i)
    .map((p) => p.replace(/\b(my|the|our|that|those|these|two|both|last|latest|recent|newest)\b/gi, ' ')
      .replace(new RegExp('\\b' + CHAT + '\\b|\\bones?\\b|\\b' + VENDOR + '\\b|\\babout\\b|\\bon\\b', 'gi'), ' ')
      .replace(/\s+/g, ' ').trim())
    .filter((p) => p.length >= 3);
  return parts.slice(0, 2);
}

function parseRecallAsk(text, { now = Date.now() } = {}) {
  const t = String(text || '').trim();
  if (!t || t.length > 600) return null;
  // "Remember ...", "forget ..." are memory facts (memory.js), never a search.
  if (/^\s*(please\s+)?(remember|forget|don'?t forget|note that|save)\b/i.test(t)) return null;
  const win = windowFor(t, now);
  if (BRIEF.test(t) && BRIEF_ASK.test(t)) return { kind: 'brief', query: t, ...win };
  if (TODAY.some((re) => re.test(t))) return { kind: 'today', query: t, ...win };
  const namesChats = CHATS.some((re) => re.test(t)) || new RegExp('\\b' + CHAT + '\\b', 'i').test(t);
  if (MERGE_VERB.test(t) && namesChats) return { kind: 'merge', query: t, picks: mergePicks(t), ...win };
  if (CHATS.some((re) => re.test(t)) && QUESTION.test(t)) return { kind: 'chats', query: t, ...win };
  if (RECENT.some((re) => re.test(t))) return { kind: 'recent', query: t, ...(win.sinceMs ? win : { sinceMs: now - 7 * 86400000, label: 'the last week' }) };
  if (VAULT.some((re) => re.test(t))) return { kind: 'vault', query: t, ...win };
  return null;
}

module.exports = { parseRecallAsk, mergePicks, windowFor };
