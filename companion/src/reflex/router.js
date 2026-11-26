// The reflex router: one utterance clause in, one decided action out.
// Jev never generates anything. It picks an intent from a fixed registry, picks
// an app or site from a list, and picks the first and last word of any free
// text ("search norbert wiener") out of the words that were actually said.
// Code owns the policy: what may fire on a half-finished sentence, what waits,
// and what goes to the thinking model instead.
const { choice, noul } = require('./jev');
const { soundsLike } = require('./soundslike');
const { parseFocusCommand, looseFocusCommand } = require('./focus-guard');

// Every action here is reversible and local. Nothing sends, buys, deletes, or
// touches a credential field. Adding one that does is a policy change, not a
// one-line edit.
const INTENTS = {
  open_app: 'Launch, open, or switch to a desktop application by name',
  open_site: 'Open a specific named website or web app in the browser (x dot com, youtube, gmail)',
  web_search: 'Search the web or google for something',
  type_text: 'Type, write, or enter given words into the current app, including making a title say something',
  new_item: 'Create a new note, document, file, or window in the current app',
  new_tab: 'Open a new empty browser tab',
  close_tab: 'Close the current tab or document',
  next_tab: 'Switch to the next tab',
  snap_left: 'Snap or move the current window to the left half of the screen',
  snap_right: 'Snap or move the current window to the right half of the screen',
  maximize: 'Maximize or full-size the current window',
  minimize: 'Minimize or hide the current window',
  volume_up: 'Turn the volume up',
  volume_down: 'Turn the volume down',
  mute: 'Mute or unmute the sound',
  play_pause: 'Play, pause, or resume media',
  screenshot: 'Take a screenshot of the screen',
  brief: 'Ask what is on my plate, my day, my priorities, or my agenda',
  run_routine: 'Run, replay, or repeat a saved routine (run my routine, do my routine, do that again)',
  remember_note: 'Save a note or reminder for later (add a note, remember that, remind me)',
  focus_guard: 'Keep the speaker off a social feed for a while, or let them back on it (keep me off reels, no reels for 20 minutes, block tiktok until I close word, ok let me back)',
  guide: 'Ask for help doing something in an app: how do I, help me, show me where, walk me through',
  ask: 'A question that needs a thoughtful spoken or written answer, not an action on the computer',
  next: 'Tell the assistant to go to the next step',
  dismiss: 'Thank or dismiss the assistant: thanks, that is all, never mind, wind up',
  none: 'Filler, thinking out loud, praise, or an unfinished fragment with no command yet (alright, great, okay lets move on, and once you are there)'
};

const SITES = {
  x: ['https://x.com', 'X, formerly Twitter (x dot com, twitter)'],
  youtube: ['https://www.youtube.com', 'YouTube'],
  gmail: ['https://mail.google.com', 'Gmail, email inbox'],
  google: ['https://www.google.com', 'Google home page'],
  github: ['https://github.com', 'GitHub'],
  reddit: ['https://www.reddit.com', 'Reddit'],
  instagram: ['https://www.instagram.com', 'Instagram'],
  claude: ['https://claude.ai', 'Claude'],
  chatgpt: ['https://chatgpt.com', 'ChatGPT'],
  calendar: ['https://calendar.google.com', 'Google Calendar'],
  drive: ['https://drive.google.com', 'Google Drive'],
  docs: ['https://docs.google.com', 'Google Docs'],
  linkedin: ['https://www.linkedin.com', 'LinkedIn'],
  amazon: ['https://www.amazon.com', 'Amazon'],
  netflix: ['https://www.netflix.com', 'Netflix'],
  spotify_web: ['https://open.spotify.com', 'Spotify web player']
};

const POLICY = {
  // May fire while the sentence is still being spoken.
  earlyIntents: new Set(['open_app', 'open_site']),
  earlyIntent: 0.8,
  earlyTarget: 0.8,
  // A finished clause.
  finalIntent: 0.55,
  finalTarget: 0.5,
  // Below this on a finished clause, hand the words to the thinking model.
  brainBelow: 0.4,
  // Below this, the words were probably not meant for the assistant at all.
  addressedMin: 0.35,
  brainAddressedMin: 0.6,
  maxWords: 60
};

// "and" only splits when a command verb follows, so "salt and pepper" survives.
// Two quick actions in one breath split the same way ("move to the top right
// and turn it down a bit", "make yourself smaller and turn up the volume"):
// each clause is decided on its own, and the Knot's own clauses never reach
// the classifier (src/knot-moves.js selfCommands).
// A request for guidance after a launch ("open Word and teach me how to make a
// table") splits too, so the launch fires and the rest reaches the guide (live
// 2026-10-11: the whole sentence was one clause, Word opened, the ask was lost).
const VERBS = '(?:can you |could you |please |lets |let\'s |now )*(?:open|launch|start|search|google|look up|type|write|create|make|close|switch|snap|move|take|go to|play|pause|mute|turn|add|remember|remind|what|help|show|teach|walk me|guide me|explain|how do i|how can i|how to|where is|where\'s|where are|where do i|point|maximize|minimize|keep me off|block|let me back|shrink|grow|get smaller|get bigger|go back|come back|lower|raise)';
const SPLIT = new RegExp('\\s*(?:[,.;!?]+\\s+(?=' + VERBS + '\\b)|(?:,?\\s*\\band then\\b|,?\\s*\\bthen\\b|,?\\s*\\band\\b)\\s+(?=' + VERBS + '\\b))', 'i');

// keyed: the words came through the talk key or the keyboard. There, once a
// clause opens "type ...", everything after it is the text to type and is never
// cut again: a dictated sentence is full of command words ("... lets you speak
// and type at the speed of light" was cut at "and type", and whisper's full stop
// before "Make it count." made that a command; live 2026-11-20).
function splitClauses(text, opts) {
  const t = String(text || '');
  if (!(opts && opts.keyed)) return t.split(SPLIT).map((s) => s.trim()).filter(Boolean);
  const re = new RegExp(SPLIT.source, 'gi');
  const out = [];
  let at = 0;
  for (let m = re.exec(t); m; m = re.exec(t)) {
    if (!m[0].length) { re.lastIndex++; continue; }
    const piece = t.slice(at, m.index).trim();
    if (piece && plainDictation(piece)) break;
    if (piece) out.push(piece);
    at = m.index + m[0].length;
  }
  const rest = t.slice(at).trim();
  if (rest) out.push(rest);
  return out;
}

function words(text) {
  return String(text || '').split(/\s+/).map((w) => w.trim()).filter(Boolean).slice(0, POLICY.maxWords);
}

// "x dot com", "nus dot ai": spoken domains are exact, so code reads them.
function spokenDomain(text) {
  const m = /\b([a-z0-9][a-z0-9-]{0,40})\s+dot\s+(com|org|net|ai|io|dev|app|co|edu|gov)\b/i.exec(String(text || ''));
  if (m) return 'https://' + m[1].toLowerCase() + '.' + m[2].toLowerCase();
  const d = /\b((?:[a-z0-9-]+\.)+(?:com|org|net|ai|io|dev|app|co|edu|gov))\b/i.exec(String(text || ''));
  return d ? 'https://' + d[1].toLowerCase() : null;
}

function buildQuestions(clause, apps) {
  const ws = words(clause);
  const appCriteria = { none: 'No application is named, or the named application is not in this list, or the name is not finished yet' };
  for (const a of apps) appCriteria[a.key] = a.describe;
  const siteCriteria = { none: 'No website is named', other: 'A website is named but it is not in this list' };
  for (const k of Object.keys(SITES)) siteCriteria[k] = SITES[k][1];
  const wordCriteria = { none: 'There is no free text to search for, type, or save' };
  ws.forEach((w, i) => { wordCriteria['w' + i] = 'word ' + i + ': "' + w + '"'; });
  return {
    ws,
    questions: {
      intent: choice('What does the speaker in `utterance` want the computer to do right now? `context` says what just happened.', INTENTS),
      app: choice('Which application does `utterance` ask to open or switch to?', appCriteria),
      site: choice('Which website does `utterance` ask to open?', siteCriteria),
      slot_start: choice('`utterance` may contain free text to search for, to type, or to save as a note. Which word is the FIRST word of that free text itself, not of the command around it?', wordCriteria),
      slot_end: choice('`utterance` may contain free text to search for, to type, or to save as a note. Which word is the LAST word of that free text itself?', wordCriteria),
      complete: noul('`utterance` is a finished command: the thing to act on has been fully named and nothing essential is cut off.'),
      // An open mic hears the room. Live 2026-09-21 it heard a phone call and sent
      // "Sorry, yeah" to the thinking model as if it were a request.
      addressed: noul('`utterance` is a command or a question spoken TO a computer assistant. It is not part of a conversation with another person, not an apology or small talk, and not someone talking to themselves.')
    }
  };
}

// Command words that are never part of the payload. When one of these opens
// the clause, code knows exactly where the free text starts (measured live
// 2026-09-21: Jev's END word is reliable, its START word wavers between
// neighbours on notes, e.g. "akrit" 0.53 over "call").
const POLITE = '(?:(?:can|could|would) you |please |lets |let\'s |now |and |then |just )*';
// Whisper writes the breath after the verb as a comma, a full stop or a question
// mark: "Type, I just built an app.", "Can you type? I just wrote an app." (live
// 2026-11-20: with only a space allowed here the comma form missed the prefix, the
// ask hung on the classifier's mood and mostly went to the guide, which said
// "Let me look" and pointed at the text box).
const AFTER_VERB = '(?:\\s*[,.:;!?]+\\s*|\\s+)';
// "write this down", "write these down", "type it out": the verb's own words,
// never the text.
const IT_DOWN = '(?:type|write)\\s+(?:this|that|these|those|it)\\s+(?:down|out|in|up)';
const TYPE_VERB = '(?:' + IT_DOWN + '|type(?:\\s+(?:out|in))?|write(?:\\s+(?:down|out))?|enter)';
const PREFIX = {
  remember_note: new RegExp('^' + POLITE + '(?:add (?:a |another )?(?:quick )?note(?: that| to| saying|:)?|make a note(?: that| to| of)?|take a note(?: that| to)?|remember(?: that| to)?|remind me(?: that| to)?|note(?: down)?(?: that)?)\\s+', 'i'),
  type_text: new RegExp('^' + POLITE + TYPE_VERB + AFTER_VERB + '(?!a title|the title)', 'i'),
  web_search: new RegExp('^' + POLITE + '(?:(?:google |web )?search(?: the web| google| online)?(?: for)?|google|look up|look for)\\s+', 'i')
};
// "Type in Notepad. I just built an app": where to type is not what to type (live
// 2026-11-20: "Notepad, I just built an app" went into Notepad). A place that can
// only be a place goes on sight; a name that is also a word ("word", "code", "x",
// "docs") goes only with the pause whisper writes after it ("in Word, hello"), so
// "type in the word hello" keeps its words.
const PLACE_SURE = '(?:(?:this|the|my)\\s+)?(?:notepad|note pad|chrome|firefox|edge|discord|slack|excel|powerpoint|outlook|onenote|google docs|vs ?code|gmail|whatsapp|telegram)|(?:this|the|my)\\s+(?:document|doc|text (?:box|field|area|editor)|search (?:box|bar)|box|field)';
const PLACE_MAYBE = '(?:(?:this|the|my)\\s+)?(?:word|docs|sheets|slides|code|teams|mail|terminal|powershell|canvas|x|twitter|reddit|youtube|chatgpt|claude|instagram|linkedin|github|zoom|paint|browser|chat|note|file|window|app|page|tab|here|there)';
const PLACE = '(?:(?:' + PLACE_SURE + ')\\b(?:\\s*[,.:;!?]+\\s*|\\s+|$)|(?:' + PLACE_MAYBE + ')\\b(?:\\s*[,.:;!?]+\\s*|\\s*$))';
// "type in notepad ...": the verb took the "in". "write in notepad ...", "type
// into the document ...": the place brings its own. Without a place after it the
// word stays in the text ("type on my way").
const VERB_TOOK_IN = /\bin[\s,.:;!?]*$/i;
const PLACE_LEAD = new RegExp('^' + PLACE, 'i');
const PLACE_LEAD_PREP = new RegExp('^(?:in|into|inside|on|onto)\\s+' + PLACE, 'i');
// The words after a "type ..." opening, with the verb and any place cut off: ''
// when the verb (and place) is all there is, null when the clause does not open
// that way. Code reads this; no model is asked.
function typePayload(clause) {
  const text = String(clause || '').trim();
  const pre = PREFIX.type_text.exec(text);
  if (!pre) return null;
  let rest = text.slice(pre[0].length);
  const place = (VERB_TOOK_IN.test(pre[0]) ? PLACE_LEAD : PLACE_LEAD_PREP).exec(rest);
  if (place) rest = rest.slice(place[0].length);
  return tidy(rest);
}
// A clause that plainly opens with "type" is dictation whatever the classifier
// makes of the words after it: they are the person's sentence, not a request, and
// the classifier reads "I just built an app ..." as chat (live 2026-11-20: the same
// sentence fired on one press and went to the guide on the next). "Write" is the
// same unless it asks for something to be composed ("write an email", "write me a
// poem", "write the report"), which is the model's job. Never "type of ...".
const DICTATE_TYPE = new RegExp('^' + POLITE + 'type\\b(?!\\s+of\\b)', 'i');
const DICTATE_WRITE = new RegExp('^' + POLITE + 'write\\b', 'i');
const WRITE_IT_DOWN = new RegExp('^' + POLITE + 'write\\s+(?:(?:this|that|these|those|it)\\s+)?(?:down|out)\\b', 'i');
const COMPOSE = /^(?:(?:me|us|him|her|them|up|about|to|for)\b|(?:an?|the|my|our|your|some|another)\s+\S)/i;
function plainDictation(clause) {
  const text = String(clause || '').trim();
  const payload = typePayload(text);
  if (!payload) return false;
  if (DICTATE_TYPE.test(text)) return true;
  if (!DICTATE_WRITE.test(text)) return false;
  // "write this down, the demo is Thursday" names its own text; "write the report" does not.
  return WRITE_IT_DOWN.test(text) || !COMPOSE.test(payload);
}
const SAYS = /\b(?:say|says|saying|to say|that says|called|named)\s+(.+)$/i;
const TRAIL = { web_search: /\s+(?:on|in|with|using) (?:google|the web|chrome|the browser)\s*$/i };
// "search YouTube for lofi beats", "search on Amazon for a desk lamp", "look up
// cheap desks on Amazon": the search runs on that site, not on Google (live
// 2026-11-02: "search on YouTube for music" googled the words "on YouTube. For
// music"). The site name is cut out of the query either side of it.
const SITE_SEARCH = {
  youtube: 'https://www.youtube.com/results?search_query=',
  amazon: 'https://www.amazon.com/s?k=',
  reddit: 'https://www.reddit.com/search/?q=',
  github: 'https://github.com/search?q=',
  linkedin: 'https://www.linkedin.com/search/results/all/?keywords=',
  x: 'https://x.com/search?q=',
  twitter: 'https://x.com/search?q=',
  netflix: 'https://www.netflix.com/search?q=',
  spotify: 'https://open.spotify.com/search/',
  wikipedia: 'https://en.wikipedia.org/w/index.php?search=',
  google: 'https://www.google.com/search?q=',
};
const SITE_WORD = Object.keys(SITE_SEARCH).join('|');
// A bare site word at the front counts only with a connector after it
// ("youtube for lofi beats"): "youtube downloader for windows" is a Google search.
const SITE_LEAD = new RegExp('^\\s*(?:(?:on|in|at|through|using)\\s+(' + SITE_WORD + ')\\b[.,]?\\s*(?:for|about)?|(' + SITE_WORD + ')\\b[.,]?\\s*(?:for|about))\\s*', 'i');
const SITE_TAIL = new RegExp('\\s*[.,]?\\s*(?:on|in|at|through|using)\\s+(' + SITE_WORD + ')\\b[.,!?\\s]*$', 'i');
const SITE_ONLY = new RegExp('^\\s*(' + SITE_WORD + ')[.!?\\s]*$', 'i');
function siteSearch(text) {
  let t = String(text || '').trim();
  let site = null;
  // "search amazon" with nothing else: the site itself.
  const only = SITE_ONLY.exec(t);
  if (only) { site = only[1].toLowerCase(); return { site, url: SITES[site] ? SITES[site][0] : SITE_SEARCH[site].replace(/[/?][^/]*$/, '') }; }
  let m = SITE_LEAD.exec(t);
  if (m) { site = (m[1] || m[2]).toLowerCase(); t = t.slice(m[0].length); }
  else { m = SITE_TAIL.exec(t); if (m) { site = m[1].toLowerCase(); t = t.slice(0, m.index); } }
  if (!site) return null;
  const query = tidy(t);
  if (!query) return { site, url: SITES[site] ? SITES[site][0] : SITE_SEARCH[site].replace(/[/?][^/]*$/, '') };
  return { site, query, url: SITE_SEARCH[site] + encodeURIComponent(query) };
}
const tidy = (t) => String(t || '').replace(/^["'“”:,\s]+|["'“”.,!?\s]+$/g, '');

function slotText(ws, answers, minConf, intent, clause) {
  const text = String(clause || ws.join(' '));
  // A clause that opens "type ..." is its own text to the end: "type my app is
  // called Nūs" types all of it, where the "called" rule below would keep "Nūs".
  if (intent === 'type_text') {
    const typed = typePayload(text);
    if (typed != null) return typed;
    const says = SAYS.exec(text);
    if (says) return tidy(says[1]);
  }
  const pre = PREFIX[intent] && PREFIX[intent].exec(text);
  if (pre) return tidy(text.slice(pre[0].length).replace(TRAIL[intent] || /$^/, ''));

  const s = answers.slot_start; const e = answers.slot_end;
  if (!s || s.choice === 'none' || (s.confidence || 0) < minConf) return '';
  let a = Number(String(s.choice).slice(1));
  // The earliest word Jev gave real weight to: the payload starts there.
  const probs = s.probabilities || {};
  for (const k of Object.keys(probs)) {
    const i = Number(k.slice(1));
    if (k !== 'none' && Number.isInteger(i) && i < a && probs[k] >= 0.2) a = i;
  }
  let b = e && e.choice !== 'none' && (e.confidence || 0) >= 0.6 ? Number(String(e.choice).slice(1)) : ws.length - 1;
  if (!Number.isInteger(a) || !Number.isInteger(b) || b < a) b = ws.length - 1;
  if (!Number.isInteger(a) || a > b) return '';
  return tidy(ws.slice(a, b + 1).join(' ').replace(TRAIL[intent] || /$^/, ''));
}

const TEXT_INTENTS = new Set(['type_text', 'web_search', 'remember_note']);

// Turn Jev's answers into a decision. Pure: no I/O, easy to test.
const CAREFUL = new Set(['new_item', 'new_tab', 'close_tab', 'next_tab']);
const CAREFUL_MIN = 0.7;         // the rules client gives 0.7 to a plain "new tab"; Jev's half-guesses sit lower
const ASK_WORDS = /\b(?:how|where|why|what|teach|show me|help me|walk me|explain|insert)\b/i;

function decide(clause, answers, { final, apps, keyed }) {
  const intent = answers.intent || {};
  let name = intent.choice || 'none';
  let conf = Number(intent.confidence || 0);
  // Absent in unit tests and older callers: treated as addressed.
  let addressed = answers.addressed && typeof answers.addressed.noul === 'number' ? answers.addressed.noul : 1;
  // "Type, I just built an app": code reads the opening, so the classifier's
  // guess about the sentence after it does not decide whether it is typed. Only
  // for words that came through the talk key or the keyboard (keyed): the open
  // mic hears the room, and there the classifier still has its say.
  if (final && keyed && plainDictation(clause)) { name = 'type_text'; conf = Math.max(conf, POLICY.finalIntent); addressed = 1; }
  const out = { clause, intent: name, confidence: conf, fire: false, brain: false, final: !!final };
  out.addressed = addressed;
  // Words meant for someone else in the room are never acted on and never sent on.
  if (final && addressed < POLICY.addressedMin) return out;

  if (!final) {
    if (!POLICY.earlyIntents.has(name) || conf < POLICY.earlyIntent) return out;
  } else if (CAREFUL.has(name) && (conf < CAREFUL_MIN || ASK_WORDS.test(clause))) {
    // One-key actions that change the person's document or tabs need a clear
    // ask: live 2026-10-11 a clipped "I insert a table" fired new_item at 0.57
    // and opened a new Word document. A wavering guess, or anything that reads
    // like a question or a how-to, goes to the thinking model instead.
    out.brain = conf >= POLICY.brainBelow && addressed >= POLICY.brainAddressedMin;
    return out;
  } else if (conf < POLICY.finalIntent && !(TEXT_INTENTS.has(name) && conf >= POLICY.brainBelow && PREFIX[name] && PREFIX[name].test(clause))
    && !(name === 'focus_guard' && conf >= POLICY.brainBelow && parseFocusCommand(clause))) {
    // (A clause that plainly reads "keep me off reels ..." rescues a wavering
    // focus_guard the same way a "type ..." prefix rescues type_text.)
    // (A clause that plainly starts "type ...", "search ..." or "add a note ..."
    // is rescued above: Jev gave "type second run" 0.54 live, a hair under the bar.)
    // "Open node path": Jev half-believes it is an app launch (0.52 live) because
    // the name is garbled. If the sound is clearly one app, that settles it.
    if (name === 'open_app' && conf >= POLICY.brainBelow) {
      const heard = soundsLike(clause, apps);
      if (heard) return Object.assign(out, { fire: true, app: heard.app, label: heard.app.name, targetConfidence: heard.score, heardAs: heard.heard });
    }
    // Unsure what it is: only worth the thinking model's time if it is a real
    // sentence that was clearly meant for the assistant.
    out.brain = words(clause).length >= 4 && addressed >= POLICY.brainAddressedMin;
    return out;
  }

  const targetMin = final ? POLICY.finalTarget : POLICY.earlyTarget;
  if (name === 'open_app') {
    const a = answers.app || {};
    const app = apps.find((x) => x.key === a.choice);
    if (!app || (a.confidence || 0) < targetMin) {
      // Jev is sure an app is wanted but cannot name it: try the sound of it.
      const heard = final ? soundsLike(clause, apps) : null;
      if (heard) return Object.assign(out, { fire: true, app: heard.app, label: heard.app.name, targetConfidence: heard.score, heardAs: heard.heard });
      out.brain = !!final && !app && addressed >= POLICY.brainAddressedMin;
      return out;
    }
    return Object.assign(out, { fire: true, app, label: app.name, targetConfidence: a.confidence });
  }
  if (name === 'open_site') {
    const spoken = spokenDomain(clause);
    const s = answers.site || {};
    if (spoken && (final || (answers.complete && answers.complete.noul >= 0.6))) return Object.assign(out, { fire: true, url: spoken, label: spoken.replace('https://', '') });
    if (SITES[s.choice] && (s.confidence || 0) >= targetMin) return Object.assign(out, { fire: true, url: SITES[s.choice][0], label: s.choice, targetConfidence: s.confidence });
    return out;
  }
  if (!final) return out;
  if (name === 'web_search' || name === 'type_text' || name === 'remember_note') {
    const ws = words(clause);
    const text = slotText(ws, answers, 0.3, name, clause);
    if (!text) { out.brain = name !== 'type_text' && addressed >= POLICY.brainAddressedMin; return out; }
    if (name === 'web_search') { const on = siteSearch(text); if (on) return Object.assign(out, { fire: true, text: on.query || '', url: on.url, label: (on.query ? 'Search ' + on.site + ': ' + on.query : 'Open ' + on.site).slice(0, 44) }); }
    return Object.assign(out, { fire: true, text, label: (name === 'web_search' ? 'Search: ' : name === 'type_text' ? 'Type: ' : 'Note: ') + text.slice(0, 32) });
  }
  // The focus guard: code reads the feed, the duration or the end condition
  // out of the words. Jev only says that this is what the sentence is; with no
  // readable condition the guard runs for its default (20 minutes), and with no
  // feed it can read, on every configured feed. Never on a half sentence.
  if (name === 'focus_guard') {
    const focus = parseFocusCommand(clause) || looseFocusCommand(clause);
    return Object.assign(out, { fire: true, focus, label: focus.kind === 'back' ? 'Letting you back' : 'Focus guard' });
  }
  // The thinking model costs seconds and takes over the Knot: only for words
  // that were clearly meant for it ("what did she say about the appointment"
  // scored 0.40 live and must not get through).
  if (name === 'guide' || name === 'ask') { out.brain = addressed >= POLICY.brainAddressedMin; return out; }
  if (name === 'none') return out;
  return Object.assign(out, { fire: true, label: name.replace(/_/g, ' ') });
}

async function route(clause, { final, apps, context, jev, log, keyed }) {
  const { ws, questions } = buildQuestions(clause, apps);
  if (!ws.length) return { clause, intent: 'none', confidence: 0, fire: false, brain: false, final: !!final, ms: 0 };
  // Plain dictation through the talk key needs no classifier at all: nothing it
  // could answer changes what is typed, and the words land that much sooner.
  if (final && keyed && plainDictation(clause)) {
    const d = decide(clause, { intent: { choice: 'type_text', confidence: 1 } }, { final, apps, keyed });
    d.ms = 0; d.model = 'code';
    return d;
  }
  const res = await jev.systemOne({ state: { utterance: clause, context: context || {} }, questions, log });
  const d = decide(clause, res.answers, { final, apps, keyed });
  d.ms = res.ms;
  d.model = res.model;
  return d;
}

module.exports = { route, decide, splitClauses, spokenDomain, slotText, siteSearch, words, buildQuestions, typePayload, plainDictation, INTENTS, SITES, POLICY };
