'use strict';
// The local half of the Companion's ask routing, run in plain Node: every step
// routeUtterance, routeUtteranceSlow and routeAnswer (companion/index.js) take
// before any model is called, in the same order, using the same modules. It
// stops at the first step that claims the ask and names where it went. Steps
// that need a live window or state (a card up, a guide running, the tour,
// settings by voice, the dashboard, memory corrections) are left out: none of
// them claims an ask from a fresh start.
//
// root: a companion/ folder (the working tree, or v0.1.19 unpacked), so the
// same simulation scores the code before and after a change. Modules that do
// not exist in that tree (src/guide/screen-ask.js before this branch) are
// simply skipped, the way the old index.js had no such step.
const path = require('path');
const fs = require('fs');

// A small catalog in the shape src/reflex/catalog.js builds from the Start menu.
const APPS = [
  { key: 'notepad', name: 'Notepad', describe: 'Notepad (notepad, note pad, notes)' },
  { key: 'spotify', name: 'Spotify', describe: 'Spotify' },
  { key: 'google_chrome', name: 'Google Chrome', describe: 'Google Chrome (chrome, the browser)' },
  { key: 'word', name: 'Word', describe: 'Word (microsoft word, word)' },
  { key: 'settings', name: 'Settings', describe: 'Settings (windows settings)' },
];

function load(root) {
  const req = (p) => require(path.join(root, p));
  const has = (p) => fs.existsSync(path.join(root, p + '.js'));
  delete process.env.TYPESAFE_API_KEY; // the shipped app has no Jev key: the rules answer
  const m = {
    voice: req('src/guide/voice'),
    rules: req('src/reflex/rules'),
    router: req('src/reflex/router'),
    lines: req('src/voice/lines'),
    reminders: req('src/reminders'),
    recall: req('src/recall/asks'),
    assignmentRouter: req('src/guide/assignment-router'),
    screenAsk: has('src/guide/screen-ask') ? req('src/guide/screen-ask') : null,
  };
  m.client = m.rules.createRulesClient({ apps: () => APPS });
  return m;
}

// The reflex layer's clause loop (src/reflex/index.js step()), decisions only:
// nothing is ever fired. -> { fired: [intent], brain: 'text' | '' }
async function reflexPass(m, text) {
  const GUIDE_OPEN = /^(?:(?:hey|ok|okay|so|um|uh|please|nus|can you|could you|would you)[\s,]+)*(?:how (?:do|can|would|should) (?:i|you|we)|how to|help me|show me|where is|where's|where are|where do i|where can i|walk me through|point (?:at|to|me to)|guide me|teach me)\b/i;
  const VERB_AT = /^(?:open|launch|create|make|type|write|search|google|close|switch|snap|take|turn|mute|play|pause|add|remember|remind|maximize|minimize)$/i;
  const CARRIES = new Set(['type_text', 'web_search', 'remember_note', 'ask', 'guide', 'none', 'brief', 'focus_guard']);
  const PASS_FILLER = /^\s*(?:(?:alright|okay|ok|great|cool|nice|hmm+|uh+|um+|yeah|yes|no|right|so|well|hold on|one sec|wait|it's okay|its okay|never mind|nevermind|thanks|thank you)[\s.,!?]*)+$/i;
  const decide = (clause) => m.router.route(clause, { final: true, apps: APPS, context: {}, jev: m.client, log: () => {} });
  const pieces = [];
  for (const clause of m.router.splitClauses(text)) {
    let rest = clause;
    for (let g = 0; g < 6; g++) {
      if (GUIDE_OPEN.test(rest.trim())) break;
      const ws = rest.split(/\s+/).filter(Boolean);
      let cut = null;
      for (let k = 2; k < ws.length; k++) {
        if (!VERB_AT.test(ws[k].replace(/[^a-z]/gi, ''))) continue;
        const d = await decide(ws.slice(0, k).join(' '));
        if (d.fire && !CARRIES.has(d.intent) && d.confidence >= 0.8) cut = [ws.slice(0, k).join(' '), ws.slice(k).join(' ')];
        break;
      }
      if (!cut) break;
      pieces.push(cut[0]); rest = cut[1];
    }
    pieces.push(rest);
  }
  const fired = [], brain = [];
  for (const p of pieces) {
    const d = await decide(p);
    if (d.fire) fired.push(d.intent);
    else if (d.brain || !PASS_FILLER.test(p)) brain.push(p);
  }
  return { fired, brain: brain.join(', ') };
}

// -> { route, why } where route is one of: dismiss, reminder, recall, rewrite,
// page, screen-answer, assignment, reflex, not-caught, hands, clarify, plain, guide.
async function simulate(m, input, { hands = false } = {}) {
  let text = String(input || '').trim();
  const { classifyUtterance } = m.voice;
  const R = m.rules;
  const handsApps = APPS.map((a) => a.name);
  const handsClaims = (t) => R.handsTakes(t, { hands, apps: handsApps });
  const screen = m.screenAsk ? m.screenAsk.screenAsk : () => null;
  const vague = m.screenAsk ? m.screenAsk.vagueAsk : () => false;
  // routeUtterance
  const g = R.greeting(text); if (g) { if (!g.rest) return { route: 'hello' }; text = g.rest; }
  const st = m.lines.smallTalk(text); if (st) { if (!st.rest) return { route: 'small talk' }; text = st.rest; }
  if (classifyUtterance(text).kind === 'dismiss') return { route: 'dismiss' };
  const ownPath = (t) => Boolean(R.rewriteAsk(t) || m.reminders.parseReminder(t) || R.readsPage(t) || screen(t) || m.recall.parseRecallAsk(t));
  let skipReflex = ownPath(text) || handsClaims(text);
  if (!skipReflex) {
    // assignment mode, off: only its own commands ("homework mode") claim an ask.
    const local = m.assignmentRouter.obvious(text, false, false);
    if (local && local !== 'where_is') return { route: 'assignment', why: local };
    const out = await reflexPass(m, text);
    if (out.fired.length && !out.brain) return { route: 'reflex', why: out.fired.join('+') };
    if (!out.fired.length && !out.brain) return { route: 'not-caught', why: 'reflex dropped it' };
    if (out.fired.length) return { route: 'reflex', why: out.fired.join('+') + ', rest "' + out.brain + '"' };
    text = out.brain;
  }
  // routeUtteranceSlow
  const kind = classifyUtterance(text);
  if (kind.kind === 'dismiss') return { route: 'dismiss' };
  if (kind.kind === 'next') return { route: 'next' };
  if (m.reminders.parseReminder(kind.text)) return { route: 'reminder' };
  if (m.recall.parseRecallAsk(kind.text)) return { route: 'recall' };
  if (R.rewriteAsk(kind.text)) return { route: 'rewrite' };
  const sa = screen(kind.text);
  if (sa) return { route: sa.page ? 'page' : 'screen-answer', why: sa.mode };
  const pg = R.readsPage(kind.text);
  if (pg) return { route: 'page', why: pg.mode };
  // routeAnswer
  if (hands && R.isTask(kind.text)) return { route: 'hands' };
  const t = kind.text.trim();
  if (/^[a-z]{2,14}[.,!?]*$/i.test(t) && !/^(?:what|who|when|why|how|where|define|explain|help|yes|no|stop|next|continue|hi|hello|hey|thanks|ok|okay)$/i.test(t.replace(/[.,!?]+$/, ''))) return { route: 'not-caught', why: 'one unknown word' };
  if (vague(t)) return { route: 'clarify' };
  if (!R.needsScreen(t)) return { route: 'plain' };
  return { route: 'guide' };
}

// What each route means to the person.
const BEHAVIOUR = {
  page: 'screen', 'screen-answer': 'screen', plain: 'general', guide: 'guide',
  hands: 'do', reflex: 'do', clarify: 'clarify', 'not-caught': 'clarify',
};
function behaviourOf(route) { return BEHAVIOUR[route] || route; }

module.exports = { load, simulate, behaviourOf, APPS };
