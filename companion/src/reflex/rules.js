'use strict';
// Rule-based routing for when the classifier service is not configured.
//
// Without a TypeSafe key the whole reflex layer used to be dark: no "open
// notepad", no "how do I" detection, no quick pointer. These rules answer the
// same questions the classifier is asked (intent, app, site, free-text slot,
// complete, addressed) in the same answer shape, so decide() and the rest of
// the engine run unchanged. They are conservative: when in doubt the clause is
// handed to the thinking model or dropped, never fired.
const { soundsLike } = require('./soundslike');

const POLITE = '(?:(?:hey|ok|okay|so|um|uh|please|nus|can you|could you|would you|lets|let\'s|now|just|and|then)[\\s,]+)*';
const lead = (body) => new RegExp('^' + POLITE + '(?:' + body + ')\\b', 'i');

// Order matters: the first rule that matches names the intent.
const RULES = [
  ['dismiss', lead('thanks|thank you|that is all|that\'s all|never mind|nevermind|wind (?:it )?up|rewind|unwind|wind (?:it )?back|all done|that will do|go away')],
  // Tabs before "next": "next tab" is a tab switch, not the next step.
  ['next_tab', lead('next tab|switch tabs?|(?:go to |switch to )?the next tab')],
  ['next', lead('next(?: step)?|go on|keep going|continue|what now|and then')],
  ['focus_guard', /\b(?:keep me off|block|no more|stay off|let me back(?: on)?)\b/i],
  ['guide', lead('how (?:do|can|would|should) (?:i|you|we)|how to|help me|show me (?:where|how)|where (?:is|are|do i|can i|\'s)|walk me through|point (?:at|to|me to)|guide me|teach me')],
  ['run_routine', lead('(?:run|replay|repeat|do) (?:my|the|that) (?:routine|again)|do that again|run my routine')],
  ['remember_note', lead('(?:add|make|take) (?:a |another )?(?:quick )?note|remember(?: that| to)?|remind me|note(?: down)?(?: that)?')],
  ['type_text', lead('(?:type|write|enter)(?: out| in| down)?')],
  ['web_search', lead('(?:google |web )?search|google|look up|look for')],
  ['new_tab', lead('(?:open |make )?(?:a )?new (?:empty )?tab')],
  ['close_tab', lead('close (?:this |the )?(?:tab|document|window)')],
  ['new_item', lead('(?:create|make|start|open) (?:a )?new (?:note|document|file|doc|window)')],
  ['snap_left', lead('(?:snap|move|put) (?:it |this |that |this window |that window |the window )?(?:to the )?left')],
  ['snap_right', lead('(?:snap|move|put) (?:it |this |that |this window |that window |the window )?(?:to the )?right')],
  ['maximize', lead('maximi[sz]e|full ?size|full ?screen|make it (?:big|bigger|full ?screen)|go full ?screen')],
  ['minimize', lead('minimi[sz]e|hide (?:this|it|the window)')],
  ['volume_up', lead('(?:a (?:bit|little|tad) )?(?:(?:turn (?:the )?)?volume up|louder|(?:make|turn) it louder|(?:turn|crank|bump|nudge) (?:it|the (?:volume|music|sound|audio)) up|(?:turn|crank|bump|nudge) up(?: the (?:volume|music|sound|audio))?|(?:raise|increase) the (?:volume|sound))')],
  ['volume_down', lead('(?:a (?:bit|little|tad) )?(?:(?:turn (?:the )?)?volume down|quieter|softer|(?:make|turn) it (?:quieter|softer)|(?:turn|bring|nudge) (?:it|the (?:volume|music|sound|audio)) down|(?:turn|bring|nudge) down(?: the (?:volume|music|sound|audio))?|(?:lower|decrease) the (?:volume|sound|music))')],
  ['mute', lead('(?:un)?mute')],
  ['play_pause', lead('play|pause|resume')],
  ['screenshot', lead('(?:take )?(?:a )?screenshot|screen shot')],
  ['brief', lead('what(?:\'s| is) on my plate|what(?:\'s| is) my day|my (?:day|agenda|priorities)|brief me|what do i have (?:today|on today|going on|on my plate)|what(?:\'s| is) (?:on )?(?:today|my schedule)')],
  ['open_site', lead('(?:open|go to|pull up|bring up|launch) (?:the )?(?:website|site)|(?:open|go to|pull up|bring up) [a-z0-9.-]+ ?(?:dot|\\.) ?(?:com|org|net|ai|io|dev|app|co|edu|gov)')],
  ['open_app', lead('(?:open(?: up)?|launch|start|switch to|bring up|pull up|go to)')],
];
const QUESTION = /^\s*(?:what|who|when|why|which|where|how|is|are|can|could|do|does|did|should|would|will|explain|tell me|define|translate|convert|calculate)\b/i;
const FILLER = /^\s*(?:(?:alright|okay|ok|great|cool|nice|hmm+|uh+|um+|yeah|yes|no|right|so|well|hold on|one sec|wait|moving on|(?:lets|let's) (?:move on|go|continue|see))[\s.,!?]*)+$/i;

function answer(choice, confidence, extra) { return Object.assign({ choice, confidence }, extra || {}); }

// A site from the router's list named in the words ("open youtube", "pull up
// gmail", "go to google calendar"). Keys read as words: spotify_web is "spotify".
function siteNamed(text, sites) {
  const lower = String(text || '').toLowerCase();
  for (const k of sites || []) {
    const word = String(k).replace(/_web$/, '').replace(/_/g, ' ');
    if (new RegExp('\\b' + word + '\\b', 'i').test(lower)) return k;
  }
  return null;
}
// "open the browser", "open my browser": whichever installed app the catalog
// calls "the browser" (Chrome, then Edge, by alias order), else any browser.
const BROWSER_WORD = /\b(?:the |my |a )?browser\b/i;
function browserWord(text) { return BROWSER_WORD.test(String(text || '')); }
function defaultBrowser(apps) {
  return (apps || []).find((a) => /\bthe browser\b/i.test(a.describe || '')) || (apps || []).find((a) => /chrome|edge|firefox|brave|arc/i.test(a.name)) || null;
}

// apps: the catalog ({ key, name, describe }); sites: keys of router.SITES.
function ruleAnswers(clause, { apps = [], sites = [] } = {}) {
  const text = String(clause || '').trim();
  const ws = text.split(/\s+/).filter(Boolean);
  const answers = {
    intent: answer('none', 0.5),
    app: answer('none', 1),
    site: answer('none', 1),
    slot_start: answer('none', 1),
    slot_end: answer('none', 1),
    complete: { noul: ws.length >= 2 ? 0.8 : 0.3 },
    addressed: { noul: 0.75 },
  };
  // Filler ("okay lets move on") is not addressed to the assistant: decide()
  // then drops it instead of handing four words to the thinking model.
  if (!text || FILLER.test(text)) { answers.addressed = { noul: 0.2 }; return answers; }
  let intent = null;
  for (const [name, re] of RULES) if (re.test(text)) { intent = name; break; }
  if (!intent) intent = QUESTION.test(text) ? 'ask' : 'none';
  // A question that is really about the screen reads as a guide ask.
  if (intent === 'ask' && /\b(this|that|here|screen|window|button|menu|tab|icon|click|open|setting|settings)\b/i.test(text) && /\b(how|where|which)\b/i.test(text)) intent = 'guide';
  answers.intent = answer(intent, intent === 'none' ? 0.5 : 0.7);
  if (intent === 'open_app') {
    // "hey nus, open calculator": the sound check sees only the verb and the name.
    const bare = text.replace(new RegExp('^' + POLITE, 'i'), '');
    const site = siteNamed(bare, sites);
    const heard = soundsLike(bare, apps);
    // "open gmail" sounds a little like Outlook's "mail": a site named in full
    // wins over a fuzzy app. "open spotify" with Spotify installed stays an app.
    if (heard && (!site || heard.score >= 0.95)) {
      answers.app = answer(heard.app.key, Math.max(0.6, Math.min(0.95, heard.score)));
      // An app named exactly may fire while the sentence is still being spoken
      // (the classifier gives "open chrome" 0.93 live; the rules say the same).
      if (heard.score >= 0.95) { answers.intent = answer('open_app', 0.9); answers.complete = { noul: 0.9 }; }
    } else if (site) {
      answers.intent = answer('open_site', 0.8);
      answers.site = answer(site, 0.85);
    } else {
      const browser = browserWord(bare) ? defaultBrowser(apps) : null;
      if (browser) answers.app = answer(browser.key, 0.8);
      else answers.intent = answer('open_app', 0.45);      // "open the thing": the engine tries the sound of it, then the brain
    }
  }
  if (intent === 'open_site') {
    const lower = text.toLowerCase();
    const hit = sites.find((k) => new RegExp('\\b' + k.replace(/_/g, ' ') + '\\b', 'i').test(lower));
    answers.site = hit ? answer(hit, 0.85) : answer('other', 0.6);
  }
  return answers;
}

// Would a good answer need to see the screen? Anything that names something on
// it, points at it ("this", "here"), asks where or how in an app, or talks about
// an error, a file or a page does; a general-knowledge question does not. In
// doubt, look: a wasted screenshot costs a little time, a missing one makes the
// Knot blind.
// "it", "that" and "my" on their own are not a screen signal: "explain it like
// I'm twelve" after a spoken answer is the same conversation, not a look at
// the window behind (live 2026-11-03: it read OBS). "this", "here" and the
// nouns still are.
const SCREEN_WORDS = /\b(this|these|those|here|there|screen|window|page|tab|app|button|menu|icon|field|click|press|tap|open|close|select|find|where|see|look|show|point|highlight|which|error|message|popup|dialog|setting|settings|option|toolbar|sidebar|file|folder|document|doc|code|line|cell|row|column|chart|image|picture|photo|video|email|how do i|how can i|how to|walk me|help me|what am i|what's on|what is on)\b/i;
// "Summarize the French Revolution" is a general question too (2026-11-11); a
// summary of the screen ("summarize this") is caught before this by
// src/guide/screen-ask.js and never reaches it.
const GENERAL_LEADS = /^\s*(?:(?:hey|ok|okay|so|um|uh|please|nus|no|yes|wait|actually|well|hmm+|and|but|also|can you|could you)[\s,]+)*(what('s| is| are| was| were)|what [a-z]+ (?:did|does|do|is|are|was|were|will|would|can|should)|who|when|why|define|tell me (a|about)|explain|summari[sz]e|sum up|recap|describe|give me (?:a |the )?(?:summary|rundown|overview)|how (many|much|far|long|old|does|do)|translate|convert|calculate|is|are|can|could|should|would|does|do)\b/i;
// "What's due this week", "when is Lab 3 due", "any deadlines tomorrow": the
// desktop app's dates answer it (src/this-week.js), not the screen. Unless
// the ask is about what is on the screen ("what's due on this page").
const DUE_ASK = /\b(?:what(?:'s| is| do i have)?|anything|when(?:'s| is)?|do i have|have i got|how many|any)\b[^?]{0,60}?\b(?:due|deadlines?)\b/i;
const DUE_ON_SCREEN = /\b(?:on (?:this|the) (?:page|screen|site|tab)|here|on screen|this assignment|this page)\b/i;
const DUE_HOWTO = /\b(?:how (?:do|can|would|should) i|how to|where (?:is|are|do i|can i)|show me|walk me|click|open|submit|turn in)\b/i;
function asksDue(text) { const t = String(text || ''); return DUE_ASK.test(t) && !DUE_ON_SCREEN.test(t) && !DUE_HOWTO.test(t); }
// "Where do I live", "what class do I take with Lee", "who is my advisor": a
// question about the person is answered from what Nūs knows about them, not
// from the screen (live 2026-11-03: both went to the guide). Unless it names
// something on the screen.
const SELF_ASK = /\b(?:do i|am i|did i|have i|is my|are my|was my|were my|what'?s my|who'?s my|where'?s my|my name)\b/i;
const SCREEN_NOUNS = /\b(screen|window|page|tab|app|button|menu|icon|field|file|folder|document|error|setting|settings|dialog|popup|toolbar|sidebar)\b/i;
// "How do I insert a table" and "where do I click" are how-tos on the screen,
// not questions about the person.
const SELF_HOWTO = /^\s*(?:(?:hey|ok|okay|so|um|uh|please|nus)[\s,]+)*how\b|\bwhere (?:do|can|should) i (?!live|work|study|stay|sit|park)\b|\bhow (?:do|can|should) i\b|\b(?:what|where|which|how) (?:do|can|should|would) i (?:turn|click|press|open|close|find|go|get|change|set|enable|disable|install|type|put|add|remove|use|make|switch|save|send|start|stop)\b/i;
function asksAboutSelf(text) { const t = String(text || ''); return SELF_ASK.test(t) && !SCREEN_NOUNS.test(t) && !SELF_HOWTO.test(t) && /^\s*(?:(?:hey|ok|okay|so|um|uh|please|nus)[\s,]+)*(?:what|which|where|who|when|do|am|did|have|is|are)\b/i.test(t); }
function needsScreen(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  if (asksDue(t)) return false;
  if (asksAboutSelf(t)) return false;
  if (SCREEN_WORDS.test(t)) return true;
  return !GENERAL_LEADS.test(t);
}

// Is this something to DO on the screen (Hands), rather than a question or a
// "how do I"? An imperative that names an app, a site, a control or a thing
// to type, or two actions in a row. A "how do I" / "where is" ask is never a
// task: that is the guide. Conservative on purpose; the reflex layer still
// takes the one-word ones (open, type, search) before this is consulted.
const TASK_VERB = '(?:open|go to|navigate to|click|tap|press|select|choose|pick|type|write|enter|fill(?: in| out)?|scroll|find|search|look up|look for|play|pause|send|email|e-mail|mail|text|message|dm|reply|post|submit|turn in|hand in|book|order|add|remove|delete|close|save|download|upload|attach|drag|move|rename|sort|filter|apply|sign in|log in|check|compare|read|summari[sz]e|grab|copy|paste|share|watch|list|tidy|clean up|organi[sz]e|set|turn on|turn off|switch|mute|unmute)';
// Polite openers before the verb: "Hello Nūs, can you email ..." (live
// 2026-10-13 that form missed the task rules and went to the reflex layer).
const TASK_LEAD = '(?:(?:hey|hi|hello|yo|ok|okay|so|um|uh|please|nus|nūs|news|can you|could you|would you|will you|can u|lets|let\'s|now|just|go ahead and|i want you to|i need you to|i\'d like you to)[\\s,]+)*';
const TASK_RE = new RegExp('^\\s*' + TASK_LEAD + TASK_VERB + '\\b', 'i');
// Sending something to someone is always Hands' job: the reflex layer has no
// such action, so a "can you email ..." must never be left to it.
// "Draft an email saying ...", "write a message to ...": composing is Hands' job
// too (live 2026-11-03: the reflex layer typed "the demo is Thursday" into Notepad).
const MESSAGE_ASK = new RegExp('^\\s*' + TASK_LEAD + '(?:email|e-mail|mail|message|text|dm|(?:send|draft|write|compose|start) (?:an? |the |me an? )?(?:new )?(?:email|e-mail|mail|message|text|dm|note|reply))\\b', 'i');
const THEN_ACT = new RegExp('(\\band\\b|\\bthen\\b|,|\\bafter that\\b)\\s+(also\\s+|please\\s+|then\\s+)?' + TASK_VERB + '\\b', 'i');
const SEEK_THERE = /\b(find|search|look (up|for|through)|browse|shop|compare|check out|go through)\b.{0,80}?\b(here|on|at|from|in this|in my)\b/i;
const HOWTO = /\b(how (do|can|would|should) (i|you|we)|how to|where (is|are|do i|can i|'s)|walk me|show me (where|how)|teach me|what (is|does) (this|that)|explain)\b/i;
// "Summarize the French Revolution", "explain photosynthesis": words to say,
// nothing to do on the screen. "Summarize my emails" (my) or "... and send it"
// (a second action) is still a task.
const KNOWLEDGE_ASK = new RegExp('^\\s*' + TASK_LEAD + '(?:summari[sz]e|sum up|recap|explain|describe)\\b', 'i');
function isTask(text) {
  const t = String(text || '').trim();
  if (!t || HOWTO.test(t)) return false;
  if (KNOWLEDGE_ASK.test(t) && !/\b(?:my|this|these|that|here|it)\b/i.test(t) && !THEN_ACT.test(t) && !SEEK_THERE.test(t) && !namesTarget(t)) return false;
  return TASK_RE.test(t) || THEN_ACT.test(t) || SEEK_THERE.test(t);
}
function messageAsk(text) { return MESSAGE_ASK.test(String(text || '')); }
// "Enter the recipient as X", "put the subject as Y", "add Z to cc", "change the
// body to ...": words about a field of the thing just made. Right after a Hands
// run they are more of that task (live 2026-11-03: the reflex layer typed "the
// recipient as ..." into whatever had focus). Means nothing outside that window.
const FIELD_NAME = '(?:recipients?|to (?:field|line|box)|subject(?: line)?|cc|bcc|body|title|heading|description|message body)';
const FIELD_VERB = '(?:enter|type|put|set|fill(?: in)?|change|make|use|write|update|edit|add|insert|replace)';
const FIELD_RES = [
  // "enter the recipient as X", "change the body to ...", "add a subject"
  new RegExp('^\\s*' + TASK_LEAD + FIELD_VERB + '\\s+(?:in\\s+)?(?:(?:the|a|an|my)\\s+)?' + FIELD_NAME + '\\b', 'i'),
  // "add Z to cc", "put X in the subject", "enter X as the recipient"
  new RegExp('^\\s*' + TASK_LEAD + FIELD_VERB + '\\s+.{1,120}?\\s+(?:to|in|into|as|on|under)\\s+(?:(?:the|a|my)\\s+)?' + FIELD_NAME + '(?:\\s+(?:field|line|box))?[\\s.,!?]*$', 'i'),
  // "the subject should be X", "recipient is X"
  new RegExp('^\\s*' + TASK_LEAD + '(?:(?:the|my)\\s+)?' + FIELD_NAME + '\\s+(?:should be|is|as|to|needs to be|will be)\\b', 'i'),
  // "cc my professor", "address it to X"
  new RegExp('^\\s*' + TASK_LEAD + '(?:b?cc\\s+\\S|address (?:it|this|that) to\\b)', 'i'),
];
function fieldFollowUp(text) { const t = String(text || '').trim(); return Boolean(t) && !HOWTO.test(t) && FIELD_RES.some((re) => re.test(t)); }
function multistep(text) { const t = String(text || ''); return THEN_ACT.test(t) || SEEK_THERE.test(t); }

// Words that open a note, a typed line or a search: the rest of the sentence
// is the payload, so a pause inside it must not cut the payload short. The
// same goes for a task that carries text later in the sentence ("open a new
// tab on Notepad and type ...": live 2026-10-11 the ask arrived as "...and
// type" with the list cut off), and, with Hands on, for any task at all: Hands
// takes seconds anyway, so the whole sentence can wait for the key to come up.
const CARRIES_TEXT_RE = /^(?:(?:hey|ok|okay|so|um|uh|please|nus|can you|could you|would you|lets|let's|now|just|and|then)[\s,]+)*(?:remember|remind me|(?:add|make|take) (?:a |another )?(?:quick )?note|note(?: down)?|type|write|enter|search|google|look up|look for)\b/i;
const TEXT_LATER_RE = /\b(?:and|then|,)\s*(?:also\s+|please\s+|just\s+)?(?:type|write|enter|put|say|add|note|remember|search|google|look up)\b|\b(?:(?:to-?do|shopping|grocery|reading) list|a (?:new )?(?:note|list|message|email|reply|comment|post)|(?:that|which) says|saying|called|named|titled)\b/i;
function carriesText(text, { hands = false } = {}) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (CARRIES_TEXT_RE.test(t) || TEXT_LATER_RE.test(t)) return true;
  return Boolean(hands) && isTask(t);
}

// A final that plainly stops mid-phrase: "Draft an email to", "lee@nus.edu,",
// "Remove my...". The next final is probably the rest of it (live 2026-11-03: the
// first half of "Draft an email to <address>, saying ..." went off on its own).
// Whisper also ends plenty of finished commands in a comma ("Open Notepad,"), so
// once the key is up a comma alone does not count. "on", "in", "this" and "it"
// end whole asks ("open mic on", "rewrite this") and do not count either.
const MID_PHRASE_WORD = /\b(?:to|at|for|with|from|of|into|onto|about|by|and|or|but|the|a|an|my|your|saying|called|named|titled|because|if)[\s.,;:!?]*$/i;
const MID_PHRASE_ADDRESS = /[\w.+-]+@(?:[\w-]+(?:\.\s?[a-z]{2,})*)?[\s.,]*$/i;
function endsMidPhrase(text, { keyUp = false } = {}) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (/(?:\.\.\.|…)$/.test(t) || MID_PHRASE_ADDRESS.test(t)) return true;
  if (/[,;:]$/.test(t) && !keyUp) return true;
  return MID_PHRASE_WORD.test(t.replace(/[,;:]+$/, ''));
}

// The wait ran out and nothing came: the ask goes on without the words that were
// leading somewhere ("Open Instagram on..." is "Open Instagram"). With too little
// left to be an ask, it stays as it was said.
const CUT_TAIL = /[\s,;:]*\b(?:on|in|to|at|for|with|from|of|into|onto|about|by|and|or|but|then|the|a|an)[\s,;:]*$/i;
function trimCutOff(text) {
  const said = String(text || '').trim();
  let t = said.replace(/(?:\.\.\.|…)$/, '').trim();
  while (CUT_TAIL.test(t)) t = t.replace(CUT_TAIL, '');
  t = t.replace(/[\s,;:]+$/, '');
  return t.split(/\s+/).length >= 2 ? t : said;
}

// Does the ask name the app or site it is about ("a new tab on Notepad", "in
// Chrome", "on YouTube")? Such an ask belongs to Hands when Hands is on: the
// reflex layer's one-key rules (new tab = Ctrl+T) act on whatever is in front,
// which live 2026-10-11 was the wrong window. apps: catalog entries or names.
const KNOWN_TARGETS = ['notepad', 'word', 'excel', 'powerpoint', 'outlook', 'onenote', 'teams', 'chrome', 'firefox', 'edge', 'brave', 'safari', 'browser', 'discord', 'slack', 'spotify', 'youtube', 'gmail', 'canvas', 'blackboard', 'moodle', 'google docs', 'docs', 'sheets', 'slides', 'drive', 'vs code', 'vscode', 'visual studio', 'code', 'explorer', 'file explorer', 'settings', 'terminal', 'powershell', 'steam', 'zoom', 'whatsapp', 'telegram', 'reddit', 'twitter', 'x', 'instagram', 'tiktok', 'amazon', 'indeed', 'linkedin', 'github', 'chatgpt', 'claude', 'netflix', 'calendar', 'mail', 'paint', 'calculator', 'photos', 'camera', 'minecraft'];
// "on Notepad", "in Chrome", and the verb forms "search YouTube", "go on Chrome"
// (live 2026-10-11 "search youtube for lofi beats" went to the plain web search).
const TARGET_LEADS = new Set(['on', 'in', 'into', 'inside', 'using', 'with', 'through', 'to', 'search', 'open', 'launch', 'start', 'check', 'play', 'use', 'browse']);
const TARGET_SKIP = new Set(['up', 'the', 'my', 'a']);
function targetNames(apps) {
  const names = new Set(KNOWN_TARGETS);
  for (const a of apps || []) { const n = String(a && typeof a === 'object' ? a.name : a || '').toLowerCase().trim(); if (n.length >= 3) names.add(n); }
  return names;
}
function namesTarget(text, apps = []) {
  const words = String(text || '').toLowerCase().replace(/[^a-z0-9ū'+. -]/g, ' ').split(/\s+/).filter(Boolean);
  if (!words.length) return false;
  const names = targetNames(apps);
  // Every lead word gets its turn: "open a new tab on notepad" is named by
  // the "on", not the "open".
  for (let i = 0; i < words.length - 1; i++) {
    if (!TARGET_LEADS.has(words[i])) continue;
    let j = i + 1;
    while (j < words.length && TARGET_SKIP.has(words[j])) j++;
    for (let n = 3; n >= 1; n--) {
      if (j + n > words.length) continue;
      const cand = words.slice(j, j + n).join(' ').replace(/[.,!?]+$/, '');
      if (names.has(cand)) return true;
    }
  }
  return false;
}

// "open notepad", "launch chrome": one verb and an app name, nothing more.
// The reflex layer does that in well under a second; Hands would take a
// screenshot first. Everything else that names an app is Hands' job.
const LAUNCH_ONLY = /^(?:(?:hey|ok|okay|so|um|uh|please|nus|can you|could you|would you|lets|let's|now|just|and|then)[\s,]+)*(?:open(?: up)?|launch|start|switch to|bring up|pull up|go to)\s+(?:the\s+|my\s+)?([a-z][a-z0-9 .+'-]{1,40}?)[.!?]*$/i;
function bareLaunch(text, apps = []) {
  const m = LAUNCH_ONLY.exec(String(text || '').trim());
  if (!m) return false;
  const rest = m[1].toLowerCase().trim();
  if (rest.split(/\s+/).length > 3) return false;
  const names = targetNames(apps);
  return names.has(rest) || [...names].some((n) => n.length >= 4 && (rest === n || rest.replace(/[^a-z0-9]/g, '') === n.replace(/[^a-z0-9]/g, '')));
}

// "open Word and teach me ...": a launch followed by more. -> { app } or null.
// The app name is what the launch clause names, so the window can be brought
// to the front if the app starts minimized or behind (live 2026-10-11: Word
// opened in the background and the guide read the chat window instead).
const LAUNCH_THEN = /^\s*(?:(?:hey|ok|okay|so|um|uh|please|nus|can you|could you|would you|lets|let's|now|just)[\s,]+)*(?:open(?: up)?|launch|start|go to|bring up|pull up)\s+(?:the\s+|my\s+)?([^,.]{1,40}?)\s+(?:and|then|,)\b/i;
function launchClause(text) {
  const m = LAUNCH_THEN.exec(String(text || ''));
  if (!m) return null;
  const app = m[1].replace(/\b(?:app|application|up|for me)\b/gi, ' ').replace(/\s+/g, ' ').trim();
  return app ? { app } : null;
}

// "Hello Nūs" (whisper writes it NuS, Nus, Nu's, News, new s): a greeting on
// its own gets a hello back; a greeting in front of an ask is stripped so the
// ask routes as usual. -> { rest } (rest '' for a bare greeting) or null.
const NUS_NAME = "(?:n[uū]s|nu's|news|new s|noose|nous)";
const GREETING_RE = new RegExp("^\\s*(?:(?:hey|hi|hello|yo|hiya|good (?:morning|afternoon|evening))[\\s,]+(?:there[\\s,]+)?" + NUS_NAME + "|" + NUS_NAME + "[\\s,]+(?:hey|hi|hello))\\b[\\s,.!?]*(.*)$", 'i');
function greeting(text) {
  const m = GREETING_RE.exec(String(text || ''));
  if (!m) return null;
  const rest = m[1].replace(/^(?:(?:can|could|would|will) you|please)[\s,]+(?=$)/i, '').trim();
  return { rest };
}

// With Hands on, which asks go straight to it instead of through the reflex
// layer first: several steps, or a task that names where it happens (unless
// it is only "open <app>", which the reflex layer does faster).
function handsTakes(text, { hands = false, apps = [] } = {}) {
  if (!hands) return false;
  const t = String(text || '').trim();
  if (!t || !isTask(t)) return false;
  if (multistep(t) || MESSAGE_ASK.test(t)) return true;
  return namesTarget(t, apps) && !bareLaunch(t, apps);
}

// "Make this friendlier", "fix my grammar", "shorten this", "make this an
// email": a rewrite of the text selected in the front app. -> { style, words }
// or null. The whole ask must be the rewrite ("fix my grammar and send it" is
// not one), and a bare "fix this" is not either: it could mean code or a
// setting. Matched before the reflex layer, whose "write ..." rule would
// otherwise type the words out.
const REWRITE_LEAD = '^\\s*(?:(?:hey|ok|okay|so|um|uh|please|nus|can you|could you|would you|will you|just|now|go ahead and)[\\s,]+)*';
const REWRITE_TAIL = '(?:[\\s,]+(?:please|for me|thanks|thank you|real quick|quickly|a bit|a little))*[\\s.!?]*$';
const REWRITE_OBJ = '(?:this|that|it|these|the (?:selected |highlighted )?(?:text|words|paragraph|sentence|part)|the selection|what i (?:selected|highlighted|wrote|typed)|my (?:text|writing|message|email|paragraph|draft|sentence|reply|essay|answer|post|note|words)|this (?:text|message|email|paragraph|draft|sentence|reply|part|bit|line|section|essay|answer|post|note))';
const O = '(?:\\s+' + REWRITE_OBJ + ')';
const MORE = '(?:\\s+(?:sound|read|look))?(?:\\s+(?:a (?:bit|little|lot)|way|much|slightly))?(?:\\s+more)?';
const REWRITE_RULES = [
  ['grammar', '(?:fix|correct|check|clean up|tidy up)(?:\\s+(?:the|my|any|all the))?\\s+(?:grammar|spelling|typos|punctuation|grammar and spelling|spelling and grammar)(?:\\s+(?:in|of|on)' + O + ')?'],
  ['grammar', '(?:proofread|spell ?check|grammar ?check)' + O + '?'],
  ['grammar', '(?:fix|correct)' + O + '\\s+(?:grammar|spelling|typos)'],
  ['email', '(?:make|turn|change|convert|rewrite|write|redo|format)' + O + '?\\s+(?:(?:into|as|to)\\s+)?(?:an?\\s+)?(?:(?:proper|professional|short|quick|polite|formal|nice)\\s+)?email'],
  ['bullets', '(?:make|turn|change|convert|rewrite|format)' + O + '?\\s+(?:(?:into|as|to)\\s+)?(?:a\\s+)?(?:bullet(?:ed)?\\s+(?:points?|list)|bullets|(?:short\\s+)?list)'],
  ['bullets', 'bullet(?: ?point)?' + O],
  ['shorter', '(?:shorten|trim|tighten|condense|cut down|compress)' + O + '?(?:\\s+(?:down|up))?'],
  ['shorter', '(?:make|keep)' + O + '?' + MORE + '\\s+(?:shorter|concise|briefer|brief|tighter|punchier|to the point)'],
  ['shorter', 'cut' + O + '\\s+down'],
  ['longer', 'make' + O + '?' + MORE + '\\s+(?:longer|detailed|in depth|thorough)'],
  ['longer', '(?:expand|lengthen|flesh out)(?:\\s+on)?' + O + '?'],
  ['simpler', '(?:simplify|clarify)' + O + '?'],
  ['simpler', 'make' + O + '?' + MORE + '\\s+(?:simpler|simple|clearer|clear|plainer|easier to (?:read|understand|follow))'],
  ['friendly', 'make' + O + '?' + MORE + '\\s+(?:friendlier|friendly|warmer|warm|nicer|kinder|nice|kind|upbeat)'],
  ['formal', 'make' + O + '?' + MORE + '\\s+(?:formal|professional|polished|serious)'],
  ['casual', 'make' + O + '?' + MORE + '\\s+(?:casual|chill|relaxed|laid back|informal|less formal)'],
  ['polite', 'make' + O + '?' + MORE + '\\s+(?:polite|politer|respectful|gentler|softer)'],
  ['confident', 'make' + O + '?' + MORE + '\\s+(?:confident|assertive|direct|persuasive)'],
  ['rewrite', '(?:rewrite|reword|rephrase|polish|improve|redo|clean up)' + O],
  ['rewrite', '(?:rewrite|reword|rephrase)'],
  ['rewrite', 'make' + O + '?(?:\\s+(?:sound|read))?\\s+better'],
].map(([style, body]) => [style, new RegExp(REWRITE_LEAD + '(?:' + body + ')' + REWRITE_TAIL, 'i')]);
// "make this sound more like me", "rewrite this so it sounds less pushy": the
// person's own words are the instruction.
const REWRITE_CUSTOM = new RegExp(REWRITE_LEAD + '(?:make' + O + '\\s+(?:sound|read)\\s+(?:more\\s+|less\\s+)?(?:like\\s+)?|(?:rewrite|reword|rephrase)' + O + '\\s+(?:to (?:sound|be|read)|so (?:it|that it) (?:sounds|reads|is)|as|in a|in an|like|for)\\s+)(.{2,80}?)' + REWRITE_TAIL, 'i');
// Whisper hears "rewrite this" as "we write this" (live 2026-11-03, in Word: the
// ask went to the guide, which said to select the text first).
const HEARD_AS_REWRITE = /\b(?:we|re|ree)[\s-]+(write|word|phrase)(?=\s+(?:this|that|it|these|the|my|what)\b)/i;
function rewriteAsk(text) {
  // "Rewrite this yourself to be shorter", "reword it for me please": the
  // politeness words carry nothing (live 2026-11-03: "yourself" sent it to the guide).
  const words = String(text || '').trim().replace(HEARD_AS_REWRITE, 're$1');
  const t = words.replace(/\b(?:yourself|for me|please|real quick|quickly)\b/gi, '').replace(/\s+/g, ' ').replace(/\s+([,.?!])/g, '$1').trim();
  if (!t || t.length > 140 || HOWTO.test(t)) return null;
  for (const [style, re] of REWRITE_RULES) if (re.test(t)) return { style, words };
  const m = REWRITE_CUSTOM.exec(t);
  if (m && m[1] && !/\b(?:and|then)\s+(?:send|post|submit|open|click)\b/i.test(m[1])) return { style: 'custom', words };
  return null;
}

// "Summarize this page", "what does this say about X", "read me the
// assignment": a question about the words of the front window, answered from
// its text (UI Automation) instead of a screenshot. -> { mode } or null, where
// mode is summarize, read or ask.
const PAGE_THING = '(?:this|that|it|the|my)\\s+(?:web ?page|page|site|website|article|doc|document|pdf|file|email|message|post|thread|assignment|instructions|prompt|syllabus|reading|chapter|paper|essay|text|announcement|rubric|screen|tab)';
const PAGE_OBJ = '(?:' + PAGE_THING + '|this|that|it)';
const PAGE_RULES = [
  ['summarize', new RegExp('^\\s*(?:(?:hey|ok|okay|so|please|nus|can you|could you|would you|just)[\\s,]+)*(?:summari[sz]e|sum up|give me (?:a |the )?(?:summary|gist|tl;?dr|rundown|main points|key points)(?: of)?|tl;?dr|recap|break down)\\s*' + PAGE_OBJ + '?(?:\\s+for me)?[\\s.!?]*$', 'i')],
  ['summarize', new RegExp('^\\s*(?:(?:hey|ok|okay|so|please|nus)[\\s,]+)*what(?:\'s| is| are)\\s+(?:' + PAGE_THING + '|this|it)\\s+(?:about|saying)\\s*\\??$', 'i')],
  ['summarize', new RegExp('^\\s*(?:(?:hey|ok|okay|so|please|nus)[\\s,]+)*what(?:\'s| are)\\s+the\\s+(?:main|key)\\s+(?:points|ideas|takeaways)(?:\\s+(?:of|in|on)\\s+' + PAGE_OBJ + ')?\\s*\\??$', 'i')],
  ['read', new RegExp('^\\s*(?:(?:hey|ok|okay|so|please|nus|can you|could you|would you|just)[\\s,]+)*read\\s+(?:me\\s+)?(?:' + PAGE_THING + '|this|that|it)(?:\\s+(?:to|for|out to)\\s+me|\\s+out(?:\\s+loud)?|\\s+aloud)?[\\s.!?]*$', 'i')],
  ['ask', new RegExp('\\bwhat\\s+(?:does|do)\\s+(?:' + PAGE_THING + '|this|it)\\s+say\\b', 'i')],
  ['ask', new RegExp('\\b(?:according to|in|on)\\s+' + PAGE_THING + '\\b.{0,80}\\?|\\b(?:does|do)\\s+' + PAGE_THING + '\\s+(?:say|mention|talk about|cover)\\b', 'i')],
];
function readsPage(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 200) return null;
  // "How do I ..." and "where is ..." are about where to click: the guide.
  if (/\b(?:how (?:do|can|would|should) i|where (?:is|are|do i|can i)|show me where|walk me|click)\b/i.test(t)) return null;
  for (const [mode, re] of PAGE_RULES) if (re.test(t)) return { mode };
  return null;
}

// A stand-in for the classifier client: same ready() and systemOne() surface.
function createRulesClient({ apps = () => [], sites = [], now = () => Date.now() } = {}) {
  return {
    ready: () => true,
    provider: 'rules',
    async systemOne({ state, questions }) {
      const t0 = now();
      const clause = state && (state.utterance != null ? state.utterance : state.text) || '';
      const appKeys = questions && questions.app && questions.app.criteria ? Object.keys(questions.app.criteria) : null;
      const list = (typeof apps === 'function' ? apps() : apps).filter((a) => !appKeys || appKeys.includes(a.key));
      const siteKeys = questions && questions.site && questions.site.criteria ? Object.keys(questions.site.criteria).filter((k) => k !== 'none' && k !== 'other') : sites;
      return { answers: ruleAnswers(clause, { apps: list, sites: siteKeys }), ms: now() - t0, model: 'rules' };
    },
  };
}

module.exports = { ruleAnswers, createRulesClient, needsScreen, asksAboutSelf, isTask, multistep, carriesText, namesTarget, bareLaunch, handsTakes, launchClause, rewriteAsk, asksDue, readsPage, greeting, messageAsk, fieldFollowUp, trimCutOff, endsMidPhrase, RULES };
