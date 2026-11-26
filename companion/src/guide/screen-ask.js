'use strict';
// Questions about the screen, told apart from "show me where" asks, by code.
//
// Live 2026-11-11 (Pranav, in the Claude desktop app): "summarize the output
// here", "I want you to summarize it for me" and "what do you see here" all went
// to the pointing guide, whose prompt can only name the next click. It circled
// the chat's text box and said to type "summarize" into it, or said there was
// nothing to click. Nothing local ever sent an ask about the screen to an answer.
//
// screenAsk(text) -> { mode, page } or null
//   mode: summarize | read | explain | check | describe | ask
//   page: true when the window's own words (UI Automation, src/page-read.js)
//         answer it best; the screenshot answer is the fallback either way.
// An ask that also says where, how do I, show me, click, or goes on to do
// something ("... and email it to Lee") is never one: that stays with the
// guide or Hands.
const { readsPage } = require('../reflex/rules');

// Whisper and fast typing: "sumamrize", "summerize", "summarise", and
// "Sutterize" (route.log 2026-11-11 23:48:06). Never "sunrise" or "satirize".
const SUMMARIZE_SPELLINGS = /\bs[uo][mt][a-z]{1,5}ri[sz]e(?:d)?\b/gi;
function normalize(text) {
  return String(text || '')
    .replace(/[’‘]/g, "'")
    .replace(SUMMARIZE_SPELLINGS, 'summarize')
    // "Great this." is how the speech model wrote "Grade this" (live 2026-11-23, twice).
    .replace(/^(\s*(?:(?:ok|okay|so|please|hey|nus)[\s,]+)*)great (this|it|that|my [\w']+)\b/i, '$1grade $2')
    .replace(/\bwaht\b/gi, 'what').replace(/\bwhats\b/gi, "what's").replace(/\bthats\b/gi, "that's")
    .replace(/\b(?:rn|pls|plz)\b/gi, '')
    .replace(/\bu\b/gi, 'you')
    .replace(/\s+/g, ' ')
    .trim();
}

// Words in front that carry nothing: "okay", "can you", "I want you to", "for fun".
const LEAD = "^\\s*(?:(?:hey|hi|ok|okay|so|um+|uh+|please|nus|nūs|just|now|well|alright|yo|for fun|quick(?:ly)?|real quick|and|also|actually|can you|could you|would you|will you|i want you to|i need you to|i'd like you to|go ahead and|try to|help me)[\\s,]+)*";
// Asks about where or how to click, and asks that go on to act: never a screen answer.
const HOW_WHERE = /\b(?:how (?:do|can|would|should|to)|how'd i|where(?:'s| is| are| do| can| should)?|show me|click|tap|press|walk me|point (?:at|to|me)|guide me|teach me|which (?:button|menu|tab|option|setting)|take me to|find (?:the|my) (?:button|setting|option|menu))\b/i;
const THEN_ACT = /\b(?:and|then|,)\s+(?:then\s+)?(?:send|email|e-mail|mail|post|submit|save|type|write|paste|put|open|share|reply|text|message|dm|copy|add|attach|upload|print|delete)\b/i;
// Something on the screen: "this", "here", "my screen", "what you see", "the output".
// "What's going on" counts only at the end or with "here" ("what's going on with
// the economy" is a general question). "The answer", "the question" count only
// as "this" or "my" ("what's the answer to life" is not about the screen).
const SCREEN_REF = /\b(?:this|these|those|here|over here|(?:my|the|this|your) screen|on screen|on-screen|what (?:you|i) (?:see|have|got)|what you're seeing|what i'm looking at|looking at|going on(?=\s*(?:here|over here|on (?:my|the) screen|[?.!]*\s*$))|on (?:my|the) (?:screen|page|monitor|display)|(?:the|this|my) (?:output|page|web ?page|tab|window|text box|error|error message|message|dialog|popup|pop-up|chart|graph|code|screenshot|picture|image|slide|spreadsheet|cell|formula|terminal|log|document|pdf|article|email|essay|paragraph|instructions|directions|assignment|rubric|syllabus|prompt)|(?:this|my) (?:answer|question|problem|post|thread|reply|response|result|results|table|text|box|doc|site|photo|sheet|work|homework|assignment))\b/i;
// "it" and "that" on their own point at the screen only after these verbs
// ("summarize it for me", "read that to me"): "explain it like I'm twelve"
// after a spoken answer is the same conversation (rules.js, live 2026-11-03).
const IT_REF = /\b(?:it|that)\b/i;

const RULES = [
  // summarize / recap / gist
  ['summarize', new RegExp(LEAD + "(?:summarize|sum (?:it |this |that )?up|recap|tl;?dr|break (?:it |this |that )?down|give me (?:a |the )?(?:quick |short |brief )?(?:summary|gist|rundown|tl;?dr|overview|breakdown|main points|key points)|what's the (?:gist|summary|tl;?dr|main point))\\b", 'i'), true],
  // read it out
  ['read', new RegExp(LEAD + "(?:read(?: out)?|read aloud)\\b(?! (?:up|about) )", 'i'), true],
  // explain / describe / translate
  // ("Explained this error." is how the speech model wrote "Explain this error", live 2026-11-23.)
  ['explain', new RegExp(LEAD + "(?:explain(?:ed)?|break down|translate|clarify)\\b", 'i'), false],
  ['describe', new RegExp(LEAD + "(?:describe|tell me (?:about|what)|talk me through what)\\b", 'i'), false],
  // check my work (the red pen, src/guide/marks.js PEN_RULES): the work on the
  // screen is named, or it is "this" and nothing else is asked. "Check my
  // email", "check the weather", "mark this as done" are not this.
  ['check', new RegExp(LEAD + "(?:(?:double[- ]?)?check|grade|mark|correct|proof ?read|red[- ]?pen|go over|look over|review)\\s+(?:(?:my|this|the|these|that)\\s+(?:[\\w']+\\s+)?(?:work|working|answers?|math|maths|homework|essay|paragraph|code|solution|proof|steps|calculations?|equations?|spelling|grammar|writing|assignment|problem|sums?|totals?|numbers|draft|paper|response|sentences?|logic|formulas?|query|sql|function|script|translation)|(?:this|it|that|these)(?:\\s+over)?)(?:\\s+(?:for me|please|for (?:mistakes|errors|typos)|real quick|quickly))*[\\s.!?]*$", 'i'), 'whole'],
  ['check', new RegExp(LEAD + "(?:what did i (?:get|do) wrong|where did i (?:go|mess up|get it) ?(?:wrong)?|what(?:'s| is) wrong (?:with (?:this|my [\\w']+)|here)|did i (?:get|do) (?:this|it|that|these) (?:right|wrong|correctly)|(?:are there |any )(?:mistakes|errors|typos)(?: (?:here|in (?:this|my [\\w']+)))?|(?:find|spot|show me|where(?:'s| is| are)) (?:my|the|any) (?:mistakes?|errors?|typos?))[\\s.!?]*$", 'i'), 'whole'],
  // is this right
  // (The whole ask is the check, and it names what it checks: "is it true that
  // cats ..." runs on past the adjective and is a general question.)
  ['check', new RegExp(LEAD + "(?:(?:is|are|does|do|was|were)\\s+(?:this|that|these|those|it|my \\w+|this \\w+)|did i|am i|have i)(?:\\s+[\\w']+){0,3}?\\s+(?:right|correct|wrong|ok|okay|good|fine|accurate|true|spelled right|grammatically correct|make sense|look right|look good|look ok|done right)(?:\\s+(?:to you|to me|for me|here|so far))?[\\s.!?]*$", 'i'), 'whole'],
  // "look at this and tell me what's going on"
  ['describe', new RegExp(LEAD + "(?:(?:take a |have a )?look at|check out|see)\\b(?=[^.?!]*\\b(?:and|then)\\s+(?:tell|explain|say|describe|summarize|let me know))", 'i'), false],
  // what does this mean, what's going on here, what am I looking at, why is this red
  ['ask', new RegExp(LEAD + "(?:what(?:'s| is| are| was| were| does| do| did| am| can|'re)?|why(?:'s| is| are| does| do| did| won't| isn't| can't)?|who(?:'s| is)?|which)\\b", 'i'), false],
];

function screenAsk(text) {
  const raw = String(text || '').trim();
  if (!raw || raw.length > 220) return null;
  const t = normalize(raw);
  // A check of their work is asked in "where" words too ("where did I go wrong", "where's my mistake").
  for (const [mode, re, itCounts] of RULES) { if (mode === 'check' && itCounts === 'whole' && re.test(t)) return { mode, page: false }; }
  if (HOW_WHERE.test(t) || THEN_ACT.test(t)) return null;
  // The window's own words: the old page rules still decide first.
  const pg = readsPage(t);
  if (pg) return { mode: pg.mode, page: true };
  for (const [mode, re, itCounts] of RULES) {
    if (!re.test(t)) continue;
    if (itCounts === 'whole') return { mode, page: false };
    const rest = t.replace(re, ' ');
    if (SCREEN_REF.test(rest) || (itCounts && (IT_REF.test(rest) || !rest.replace(/\b(?:for me|please|now|for you|real quick|quickly|out loud|aloud|to me|thanks)\b|[\s.,!?]/gi, '')))) {
      // "Summarize" alone, "read it to me": the page the person is on.
      return { mode, page: mode === 'summarize' || mode === 'read' };
    }
    return null;
  }
  return null;
}

// Does the ask read like a question to be answered, not a task to click
// through? Used when the pointing model ends up with nothing to point at.
const QUESTION_LEAD = new RegExp(LEAD + "(?:what|why|who|which|when|is|are|does|do|did|can|could|should|explain|describe|summarize|read|tell me|translate|define)\\b", 'i');
function answerish(text) {
  const t = normalize(text);
  if (!t) return false;
  if (screenAsk(t)) return true;
  return QUESTION_LEAD.test(t) && !HOW_WHERE.test(t) && !THEN_ACT.test(t);
}

// Too little to act on: "help", "can you help me", "do the thing", "um so like".
const VAGUE = /^\s*(?:(?:hey|ok|okay|so|um+|uh+|hmm+|well|like|yeah|please|nus)[\s,]+)*(?:help(?: me)?(?: out)?|can you help(?: me)?(?: out)?|could you help(?: me)?|i need (?:some )?help|do (?:the|that|this) thing|do something|(?:um+|uh+|hmm+|so|like|well|yeah)(?:[\s,]+(?:um+|uh+|hmm+|so|like|well|yeah))*)[\s.,!?]*$/i;
function vagueAsk(text) { return VAGUE.test(String(text || '')); }
const CLARIFY_LINE = 'What do you need? Say it in a few words, like "summarize this" or "where is Save".';

// A pointing step that hands the ask back: "Type 'summarize for me' in the box",
// "Ask Claude to summarize it". Never a valid step (2026-11-11). The ask itself
// naming typing ("type hello", "how do I type an accent") is left alone.
const HANDBACK_VERB = /\b(?:type|enter|write|paste|ask|say|send|put|tell)\b/i;
// Their own ask, or another assistant, named outright: enough on its own.
const HANDBACK_SELF = /\b(?:your (?:question|request|prompt|ask)|ask (?:claude|chatgpt|copilot|gemini|the (?:ai|assistant|chat|bot)|it|them) to)\b/i;
// A box to type into: a hand-back only with the ask's verb or quoted words.
const HANDBACK_TO = /\b(?:(?:the|a) (?:text box|textbox|chat box|message box|input|prompt box|search box)|in the box|into the box|in the chat|into the chat)\b/i;
const ANSWER_VERBS = /\b(?:summar\w*|explain\w*|describ\w*|recap|gist|translat\w*|read|tell|what|why)\b/i;
const STOP = new Set(['the', 'a', 'an', 'this', 'that', 'it', 'is', 'are', 'me', 'my', 'for', 'to', 'you', 'i', 'can', 'please', 'what', 'here', 'of', 'on', 'in', 'and', 'okay', 'ok', 'so', 'want', 'do', 'does', 'going']);
const words = (s) => normalize(s).toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter((w) => w && !STOP.has(w));
function handsAskBack(instruction, task) {
  const ins = normalize(instruction);
  const ask = normalize(task);
  if (!ins || !HANDBACK_VERB.test(ins)) return false;
  if (/\b(?:type|enter|write|paste)\b/i.test(ask)) return false;
  if (HANDBACK_SELF.test(ins)) return true;
  if (HANDBACK_TO.test(ins) && (ANSWER_VERBS.test(ins) || /["“'][^"”']{3,}["”']/.test(ins))) return true;
  // The step's quoted words are the ask's own words.
  const quoted = /["“']([^"”']{3,})["”']/.exec(ins);
  if (quoted) {
    const q = new Set(words(quoted[1]));
    const a = words(ask);
    if (a.length && a.filter((w) => q.has(w)).length / a.length >= 0.5) return true;
    if (/\bsummar/i.test(quoted[1]) && /\bsummar/i.test(ask)) return true;
  }
  return false;
}

// A pointing step that says there is nothing to click, for an ask that wanted
// an answer: never spoken, the answer is given instead.
const NO_CLICK = /\b(?:nothing (?:to|you need to|needs to be|here to) (?:click|press|do)|no(?:thing)? (?:button|control)s? to click|there(?:'s| is) nothing (?:to click|here)|no need to click|you don't need to click)\b/i;
function noClickLine(instruction) { return NO_CLICK.test(String(instruction || '')); }

module.exports = { screenAsk, answerish, vagueAsk, handsAskBack, noClickLine, normalize, CLARIFY_LINE };
