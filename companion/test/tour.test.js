'use strict';
// The first-run tour (companion/src/tour.js and its wiring): eleven cards
// reworked after Pranav's live test (docs/tour-0115.md), a keyless path for
// every step, the name heard by doing, the sheet morphing in place, the voice
// download offered first, the real settings on cards 5 to 7, the dashboard
// walked at the end, and the old Get started steps and tutorial deck gone.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const T = require('../src/tour');
const root = path.resolve(__dirname, '../..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

const full = { whisper: true, source: true, cli: false, keyReady: false, hands: true, english: true, ptt: 'Control+Alt', device: 'Headset (USB)', island: false, hideFromCapture: false, captureForcedOff: false, voice: { installed: true } };
const bare = { whisper: false, source: false, cli: false, keyReady: false, hands: false, english: false, ptt: 'Control+Alt', device: '', island: false, hideFromCapture: false, captureForcedOff: false, voice: { installed: false } };
const all = (caps, name) => Array.from({ length: T.OF }, (_, i) => T.card(i + 1, { caps, name }));

test('a new install sees the tour once; an upgrade never; done or skipped it stays gone', () => {
  assert.deepEqual(T.onFirstWindow({}), { tour_pending: true });
  assert.deepEqual(T.onFirstWindow({ home_seen: true }), {});
  assert.equal(T.shouldShow({}), false);
  assert.equal(T.shouldShow({ tour_pending: true }), true);
  assert.equal(T.shouldShow({ tour_pending: true, tour_done: true }), false);
  const main = read('src/main-companion.js');
  const open = main.slice(main.indexOf('function openHome()'), main.indexOf('function publicSettings()'));
  assert.ok(open.indexOf('tourMod.onFirstWindow(') > 0 && open.indexOf('tourMod.onFirstWindow(') < open.indexOf("api.setPreference('home_seen', true)"), 'pending is written before home_seen');
  assert.match(main, /tourMod\.shouldShow\(api\.getPreferences\(\)\) \|\| SMOKE\) openHome\(\)/, 'a first window still on the tour opens again next launch');
});

test('ten cards in the planned order, one or two spoken sentences each, no em dashes, no "Home"', () => {
  const cards = all(full, 'Maya');
  assert.equal(T.OF, 10);
  assert.deepEqual(cards.map((c) => c.kind), ['mic', 'key', 'questions', 'home', 'sharing', 'ai', 'guide', 'hands', 'dashboard', 'done']);
  assert.deepEqual(Object.keys(T.STEP), ['hello'].concat(cards.map((c) => c.kind)), 'STEP names every card in order, the uncounted hello first');
  assert.deepEqual(cards.map((c) => c.title), ['Now, can I hear you?', 'This is how you talk to me', 'Three quick questions', 'Where should I live?', 'On a call or a recording', 'Who answers', 'I see what you see', 'I can use the mouse too', 'The dashboard', "That's it, Maya."]);
  assert.deepEqual(cards.map((c) => c.skip), [true, true, true, true, true, true, true, true, true, false]);
  for (const c of cards) {
    assert.equal(c.of, 10); assert.equal(c.progress, null, 'no download, no progress line');
    assert.ok(c.spoken && c.spoken.split(/[.!?]\s/).length <= 3, c.title + ': at most three sentences');
    assert.doesNotMatch(c.title + c.body + c.spoken + (c.note || ''), /—/, 'no em dashes');
    assert.doesNotMatch(c.title + c.body + c.spoken + (c.note || ''), /\bHome\b/, 'the window is the dashboard');
  }
  assert.deepEqual(cards[1].keys, ['Ctrl', 'Alt']);
  assert.equal(cards[1].chip, 'My name is ...');
  assert.equal(cards[1].status, 'Waiting for you');
  assert.deepEqual(cards[2].qa.map((r) => r.q), T.QUESTIONS.map((q) => q.q));
  assert.equal(cards[6].chip, 'What is this window for?', 'until the window in front is known');
  assert.match(cards[7].body, /Esc to stop me/);
  assert.deepEqual(cards[8].actions, T.continueActions(true), 'it comes up by itself, Continue lights when the walk ends');
  // The first win (plan 2026-11-06): real buttons, not text to read.
  assert.equal(cards[9].chips, undefined);
  assert.deepEqual(cards[9].actions.map((a) => a.id), T.firstWins(full).map((w) => 'tour-try-' + w.struggle).concat('tour-finish'));
  assert.deepEqual(T.card(T.STEP.done, { caps: { keyReady: true } }).actions.map((a) => a.id), ['tour-try-feeds', 'tour-try-homework_start', 'tour-try-find_in_apps', 'tour-finish'], 'with AI, the screen one');
  assert.equal(cards[9].actions.filter((a) => a.primary).length, 1);
  // Length is not the constraint (Pranav, 2026-11-02); still, the Knot's own
  // words stay under three minutes at a slow 150 a minute.
  const words = T.spokenLines(full).join(' ').split(/\s+/).length;
  assert.ok(words < 450, 'spoken words: ' + words);
  assert.equal(T.card(10, { caps: full }).title, "That's it.", 'no name, no name');
  for (const line of T.spokenLines(full).concat(T.DASHBOARD_STOPS.map((s) => s.line), [T.DASHBOARD_DONE_LINE, T.HOME_CHANGED_LINE, T.KEY_OK_LINE, T.KEY_BAD_LINE, T.KEY_FAILED_LINE])) assert.doesNotMatch(line, /—|\bHome\b/, line);
});

test('no voice card: the voice is not a step, and no card shows a download line', () => {
  assert.equal(T.STEP.voice, undefined, 'Pranav, 2026-11-11: no voice step');
  const going = Object.assign({}, full, { voice: { installed: false, downloading: { got: 35, total: 100 } } });
  for (let s = 0; s <= T.OF; s++) {
    const c = T.card(s, { caps: going });
    assert.notEqual(c.kind, 'voice'); assert.equal(c.progress, null, 'card ' + s + ' shows no download line');
    assert.doesNotMatch(c.title + c.body + (c.note || ''), /download|Fable/i, 'card ' + s + ' says nothing about the voice');
  }
  assert.ok(!T.spokenLines(full).includes(T.VOICE_LANDED_LINE), 'nothing announces the switch');
});

test('the settings cards: where the Knot lives, screen sharing, who answers', () => {
  const home = T.card(T.STEP.home, { caps: full });
  assert.deepEqual(home.choices, [{ id: 'tour-home-free', label: 'Free Knot', pic: 'free', on: true }, { id: 'tour-home-island', label: 'Island bar', pic: 'island', on: false }]);
  assert.equal(T.card(T.STEP.home, { caps: Object.assign({}, full, { island: true }) }).choices[1].on, true);
  assert.match(home.body, /Tap one and watch/);
  const share = T.card(T.STEP.sharing, { caps: full });
  assert.deepEqual(share.toggle, { id: 'tour-sharing', label: 'Hide me from screen sharing', on: false, disabled: false });
  assert.match(share.body, /^Off, people on your call see me too\. On, I am invisible/);
  assert.equal(T.card(T.STEP.sharing, { caps: Object.assign({}, full, { hideFromCapture: true }) }).toggle.on, true);
  const forced = T.card(T.STEP.sharing, { caps: Object.assign({}, full, { captureForcedOff: true }) });
  assert.equal(forced.toggle.disabled, true); assert.match(forced.note, /this session/);
  const ai = T.card(T.STEP.ai, { caps: full });
  assert.deepEqual(ai.input, { action: 'tour-key', placeholder: 'Gemini or Anthropic key', label: 'Save', secret: true });
  // 0.1.40: "Get a free key" opens AI Studio (own-key-0140.test.js).
  assert.deepEqual(ai.actions, [{ id: 'tour-get-key', label: 'Get a free key' }, { id: 'tour-next', label: 'Later' }]);
  assert.match(ai.body, /dashboard, under Settings, Keys/);
  const cli = T.card(T.STEP.ai, { caps: Object.assign({}, full, { cli: true }) });
  assert.match(cli.body, /Claude Code is installed/); assert.equal(cli.input, undefined); assert.deepEqual(cli.actions, T.continueActions(false));
  const key = T.card(T.STEP.ai, { caps: Object.assign({}, full, { keyReady: true }) });
  assert.match(key.body, /key is saved already/); assert.deepEqual(key.actions, T.continueActions(false));
  assert.equal(T.keyCheck('sk-ant-api03-' + 'x'.repeat(40)).kind, 'anthropic');
  assert.equal(T.keyCheck('AIza' + 'A'.repeat(35)).kind, 'gemini');
  assert.equal(T.keyCheck('AQ.' + 'A'.repeat(30)).kind, 'gemini', 'the newer Gemini keys count, by the dashboard\'s own check');
  assert.equal(T.keyCheck('  "AIza' + 'A'.repeat(35) + '" ').key, 'AIza' + 'A'.repeat(35), 'stray quotes come off');
  assert.equal(T.keyCheck('hello there').kind, ''); assert.equal(T.keyCheck('hello there').message, T.KEY_BAD_LINE);
  assert.equal(T.keyCheck('').kind, ''); assert.equal(T.keyCheck('sk-ant-short').kind, ''); assert.match(T.keyCheck('sk-ant-short').message, /cut off/);
});

test('card 9 walks the dashboard: four stops on the rail, the name "the dashboard" throughout', () => {
  assert.deepEqual(T.DASHBOARD_STOPS.map((s) => s.view), ['mynus', 'saved', 'map', 'folders', 'settings']);
  for (const s of T.DASHBOARD_STOPS) assert.match(s.line, /^(My Nūs|Saved|Map|Folders|Settings): /);
  assert.match(T.DASHBOARD_STOPS[4].line, /keys, my voice, where I live, and screen sharing/);
  assert.doesNotMatch(T.DASHBOARD_STOPS.map((s) => s.line).join(' '), /tidy/, 'Folders reads; it never tidies');
  assert.match(T.DASHBOARD_DONE_LINE, /^That is the dashboard\./);
  assert.equal(T.tuckLine(8, T.DASHBOARD_TUCK), 'Step 8 of 10. This is the dashboard.');
  const card = T.card(9, { caps: full });
  assert.equal(card.title, 'The dashboard'); assert.match(card.body, /beside this card/);
});

test('every step has a path with nothing set up, and the card says so', () => {
  const cards = all(bare);
  assert.equal(cards[0].note, 'Nūs speaks English for now.', 'a non-English locale gets one line, never a translation');
  assert.equal(T.card(1, { caps: full }).note, '');
  assert.match(cards[1].body, /type your name instead/);
  assert.deepEqual(cards[1].input, { action: 'tour-name', placeholder: 'Your name', label: 'Continue' });
  assert.match(cards[2].status, /Type your answer/);
  assert.match(cards[6].body, /No AI is set up yet, so I will show you on the dashboard/);
  assert.deepEqual(cards[6].actions, [{ id: 'tour-show', label: 'Show me', primary: true }]);
  assert.match(cards[7].body, /not available on this computer yet/);
  assert.equal(cards[7].actions[0].id, 'tour-next');
  assert.equal(T.englishLocale('en-US'), true); assert.equal(T.englishLocale('en'), true);
  assert.equal(T.englishLocale('mr-IN'), false); assert.equal(T.englishLocale('de'), false); assert.equal(T.englishLocale(''), false);
  // The lines kept as files cover every path, and none carries a name.
  const cached = T.cachedLines();
  assert.ok(cached.length >= 30, 'cached lines: ' + cached.length);
  for (const l of cached) assert.doesNotMatch(l, /Maya/);
  assert.ok(cached.includes(cards[6].spoken) && cached.includes(T.card(T.STEP.ai, { caps: Object.assign({}, full, { cli: true }) }).spoken));
});

test('the name is heard by doing: "my name is Maya" and a bare name count, a sentence does not', () => {
  assert.equal(T.nameFrom('My name is Maya.'), 'Maya');
  assert.equal(T.nameFrom("my name's pranav"), 'Pranav');
  assert.equal(T.nameFrom("I'm Ana Lucia"), 'Ana Lucia');
  assert.equal(T.nameFrom('Maya'), 'Maya');
  assert.equal(T.nameFrom('hi, I am Jean-Luc'), 'Jean-Luc');
  assert.equal(T.nameFrom('call me Sam'), 'Sam');
  assert.equal(T.nameFrom('what is the weather like today'), '', 'a sentence is not a name');
  assert.equal(T.nameFrom('open chrome please'), '');
  assert.equal(T.nameFrom(''), '');
  assert.equal(T.nameFrom('my name is 12345'), '');
});

test('main runs the steps: the heard words go to the tour first, the demos have no model, the settings cards write the real settings, Esc stops Hands', () => {
  const main = read('companion/index.js');
  const route = main.slice(main.indexOf('async function routeUtterance('), main.indexOf('async function routeUtterance(') + 600);
  assert.match(route, /if \(tour && tour\.hear && String\(text \|\| ''\)\.trim\(\)\) \{ tourHeard\(text, source\); return; \}/, 'checked first, before greetings and the reflex layer');
  assert.doesNotMatch(main, /tryTalk|answerTryTalk|TRY_LINE/, 'the old talk key try is gone');
  const block = main.slice(main.indexOf('// ---- the first-run tour'), main.indexOf('async function routeUtterance('));
  assert.ok(block.length > 2000, 'the controller lives before routeUtterance');
  assert.doesNotMatch(block, /createLLM|guideLlm\(\)\.complete|desktopComplete|noteAsk\(/, 'no model and no ask counted inside the tour');
  assert.match(block, /getMemory\(\)\.add\('name\.full', name, 'tour'\)/, 'the name is kept');
  assert.match(block, /actions\.run\('open_app', \{ name: 'Notepad' \}, ctx\)/, 'the Hands demo opens Notepad through the actions module');
  assert.match(block, /for \(const line of report \? \[\] : Tour\.HANDS_LINES\)/);
  assert.match(block, /if \(t\.unverified\) unsure = true;/, 'words the action could not see land are never called done');
  assert.match(block, /unsure \? Tour\.HANDS_UNSURE_LINE : Tour\.HANDS_DONE_LINE/);
  assert.ok(block.indexOf("actions.run('press', { keys: 'ctrl+n' }, ctx)") > 0 && block.indexOf("actions.run('press', { keys: 'ctrl+n' }, ctx)") < block.indexOf("actions.run('type'"), 'a new tab first: Notepad restores its session, and the tab in front can be the person\'s own note');
  assert.match(block, /send\('hands:state', \{ active: true, waiting: true \}\)/, 'the card waits at half glow');
  assert.match(block, /kicker: 'ask first', text: Tour\.HANDS_CARD\.title, hint: Tour\.HANDS_CARD\.hint/, 'the consent card is the real one');
  assert.match(block, /region: rel\(t\.rail\)/, 'the guide demo marks the rail as the region');
  assert.match(block, /Tour\.englishLocale\(app\.getLocale\(\)\)/, 'the locale is read, never guessed');
  assert.doesNotMatch(block, /tour\.step === \d/, 'steps are named through Tour.STEP, never numbered');
  // The new cards.
  // The voice is equipped by itself, outside the tour, with nothing shown (voiceAutoEquip).
  assert.doesNotMatch(block, /getVoice\(\)\.install|tourVoiceGet|progressOf/, 'the tour neither starts nor shows the download');
  assert.match(main, /keep: \(line\) => LINES\.includes\(line\) \|\| TOUR_LINES\.has\(line\)/, 'the line cache keeps the tour\'s lines, or making them ahead does nothing');
  assert.match(main, /const onState = \(s\) => \{ send\('voice:state', s\); if \(tour\) tourVoiceState\(s\);/, 'the voice module reports to the tour');
  assert.match(block, /applySettingsPatch\(\{ knotIsland: island \}\)/, 'card 5 is the real island setting');
  assert.match(block, /applySettingsPatch\(\{ hideFromCapture: !captureHidden\(\) \}\)/, 'card 6 is the real capture switch');
  assert.match(block, /hooks\.tourSaveKey\(kind, value\)/, 'card 7 saves through the same door as the Keys card');
  assert.match(block, /\} else \{\n\s+save\(''\);/, 'a key that does not answer is taken out again');
  assert.match(block, /hooks\.tourTestKey\(kind\)/, 'and the host checks it');
  assert.match(block, /hooks\.tourAi\(\)/, 'who answers is asked of the host');
  assert.match(block, /hooks\.tourDashboard\(\{ side, narrow: island, views: Tour\.DASHBOARD_STOPS\.map/, 'card 10 opens the dashboard clear of the sheet');
  assert.match(block, /if \(tour\.step === Tour\.STEP\.dashboard\) setTimeout\(/, 'and it comes up by itself');
  assert.match(block, /for \(const stop of Tour\.DASHBOARD_STOPS\)/);
  assert.match(block, /quiet: true/, 'the walk points with the thread and no card at the tip');
  assert.match(block, /getLines\(\)\.prerender\(want\)/, 'the fixed lines are made ahead in the Knot\'s voice');
  assert.match(main, /if \(tour && tour\.handsRunning\) \{ tour\.handsAbort = true; return; \}/, 'Esc stops the demo');
  assert.match(main, /if \(p && p\.action && \/\^tour-\/\.test\(String\(p\.action\)\)\) \{ tourAction\(String\(p\.action\), String\(p\.text \|\| ''\)\); return; \}/);
  assert.match(main, /startTour: \(from\) => \{ forceShow\(\); tourStart\(from \|\| 'home'\); return companionStatus\(\); \}/);
  assert.match(main, /tourState: \(\) => tourPublicState\(\)/);
  assert.match(main, /tour\.step === Tour\.STEP\.guide && !tour\.shown && data && data\.task === 'guide'\) tourTargetShown\(\)/);
  assert.match(read('companion/preload.js'), /'tour:card', 'tour:update', 'tour:end'/);
  const host = read('src/main-companion.js');
  assert.match(host, /tourAi: async \(\) => \(\{ cli: !!\(await ai\.status\(\)\)\.cli, key: createLLM\(store\.getSettings\(\)\)\.ready, publik: !!\(publik && publik\.active\(\)\) \}\)/);
  assert.match(host, /tourTestKey: which => testKeys\(String\(which \|\| ''\)\)/);
  assert.match(host, /tourSaveKey: \(kind, key\) => settingsPatch\(\{ apiKeys: \{ \[kind\]: String\(key \|\| ''\) \} \}\)/);
  assert.match(host, /tourDashboard: async \(\{ side, narrow, views \} = \{\}\) => \{/);
  assert.match(host, /w\.setBounds\(\{ x, y, width, height \}\)/, 'the dashboard is placed clear of the Knot');
});

test('the sheet morphs in place, folds into the tuck in one motion, and never hides between cards', () => {
  const html = read('companion/renderer/index.html'), r = read('companion/renderer/renderer.js'), css = read('companion/renderer/styles.css');
  assert.doesNotMatch(html, /onboard-scrim|ob-next|ob-skip/, 'the old deck is gone');
  assert.match(html, /<div id="tour" class="glass no-drag hidden" role="dialog"/);
  for (const id of ['tr-kicker', 'tr-dots', 'tr-progress', 'tr-title', 'tr-body', 'tr-mid', 'tr-status', 'tr-actions', 'tr-skip', 'tour-tuck']) assert.match(html, new RegExp('id="' + id + '"'), id);
  assert.doesNotMatch(r, /showOnboard|obSteps|finishOnboard/, 'no deck code');
  const block = r.slice(r.indexOf('// ---- the first-run tour'), r.indexOf("window.__nusTour = "));
  assert.match(block, /function morphTour\(apply\)/);
  assert.match(block, /\} else morphTour\(\(\) => renderTourCard\(card\)\);/, 'a card after the first morphs, it never re-opens');
  assert.doesNotMatch(block.slice(block.indexOf('function showTourCard')), /hideSurface\(tourEl[^\n]*\n[^\n]*openSlotSurface/, 'no hide then show on a card change');
  assert.match(block, /const ghost = trGhost\(\);\n\s+apply\(\);\n\s+placeTour\(\);/, 'the old words are cloned before the new ones land');
  assert.match(block, /tourEl\.animate\(\[\{ height: r0\.height \+ 'px'/, 'the frame\'s height eases');
  assert.match(block, /a\.onfinish = end; trTimers\.push\(setTimeout\(end, ms \+ 80\)\);/, 'a stopped fold never finishes: its timer would hide a sheet that came back');
  assert.match(block, /for \(const t of trTimers\) clearTimeout\(t\);/);
  assert.match(block, /function tuckTour\(text, actions\)/); assert.match(block, /function untuckTour\(card\)/);
  assert.match(block, /flipFrom\(tourTuck, rs, rt, TR\.fold, true\);\n\s+flipInto\(tourEl, rs, rt/, 'the sheet folds into the line as the line grows out of it');
  assert.match(block, /flipFrom\(tourEl, rt, rs, TR\.fold, true\);\n\s+flipInto\(tourTuck, rt, rs/, 'and unfolds the same way');
  assert.match(block, /function tourFollowKnot\(r0\)/, 'the sheet glides after an island switch, from where it was');
  assert.match(block, /function easeTour\(apply\)/, 'new words on a card ease the frame');
  assert.match(block, /trMid\.querySelector\('\.tr-switch'\)/, 'the switch stays the same element, so it slides');
  assert.match(r, /tourCard && isShown\(tourEl\) && knot3d && !reducedMotion\(\)\) tourIslandSwitch\(on\); else setIsland\(on\);/, 'on a card the Knot flies to its new home');
  assert.match(block, /moveKnotTo\(dock, \{ persist: false, keepGuide: true/);
  assert.match(block, /function placeTour\(\) \{ if \(isShown\(tourEl\) && tourIslandWant === null\) placeSlot\(tourEl\); \}/, 'the sheet holds still while the Knot flies');
  assert.match(r, /if \(tourIslandWant === null\) placeByKnot\(\$\('#tour'\)\);/);
  assert.ok(r.indexOf('let tourIslandWant = null') < r.indexOf('function syncKnotUi()'), 'declared before the first layout reads it');
  assert.match(r, /function applyKnotPayload\(p\) \{[^}]*if \(tourHomeHold\) \{ const hold = tourHomeHold; tourHomeHold = null; hold\(p\); return; \}/, 'back to free it flies to its spot, not jumps');
  assert.match(block, /if \(speakingNow\) \{ tourHeardMs = 0; tourLevelAt = 0; return; \}/, 'the Knot\'s own line never passes the mic check');
  assert.match(block, /function tourMicAfterMotion\(card\)/, 'the mic waits for the sheet to stop moving');
  assert.match(r, /guideState === 'winding' && tourCard \? 'ready'/, 'the Knot holds its state through a demo\'s return');
  assert.ok(r.indexOf('let tourCard = null') < r.indexOf('function syncKnotUi()'), 'declared before the first paint reads it');
  assert.match(r, /\(panelOpen \|\| quickOpen \|\| tourCard\) \? 'ready' : 'idle'/, 'the Knot stays attentive across cards');
  assert.match(r, /const silent = task === 'hands' \|\| !!p\.quiet;/, 'a quiet target gets the thread and no card');
  assert.match(block, /function trMark\(what\) \{\n\s+if \(!tourTrace\.on\) return;/, 'the trace costs nothing unless asked for');
  assert.match(block, /if \(card\.trace\) tourTrace\.on = true;/);
  assert.match(read('companion/index.js'), /process\.env\.NUS_TOUR_TRACE === '1' \? \{ trace: true \} : \{\}/);
  assert.match(block, /function trMark\(what\)/); assert.match(r, /if \(on && typeof trMark === 'function'\) trMark\('speech'\);/, 'the trace marks click, card, paint and speech');
  assert.match(block, /inp\.type = card\.input\.secret \? 'password' : 'text'/, 'a key is never shown');
  assert.match(block, /class="tr-switch-track"/); assert.match(block, /b\.className = 'tr-choice'/);
  assert.match(block, /'Microphone: ' \+ \(card\.device \|\| micLabel\(\) \|\| 'the Windows default'\)/, 'the mic card names the device once the stream is up');
  assert.match(block, /nus\.on\('tour:card', showTourCard\);/);
  assert.match(block, /nus\.on\('tour:update', updateTourCard\);/);
  assert.match(block, /nus\.on\('tour:end', endTourCard\);/);
  assert.match(r, /else if \(tourMic\) \{ tourLevel\(e\.data\.level\); return; \}/, 'the mic feeds the bars while the mic card is up');
  assert.match(block, /tourSend\('tour-mic-heard'\)/);
  assert.match(block, /cues\.play\('tick'\)/, 'the card tick');
  assert.match(block, /cues\.play\('done-notes'\)/, 'the two notes at the end');
  assert.match(r, /else if \(a\.id === 'tour'\) \{ clearTimeout\(introTimer\); dismissGuide\('tour'\); tourSend\('tour-start'\); \}/, 'the hello bubble leads into the tour');
  assert.doesNotMatch(css, /#onboard/);
  for (const sel of ['#tour {', '#tour-tuck {', '#tour.is-morphing {', '.tr-ghost {', '.tr-progress {', '.tr-choices {', '.tr-switch {']) assert.ok(css.includes(sel), sel);
});

test('the dashboard\'s Get started is one card that starts the tour, and the window is the dashboard everywhere a person reads it', () => {
  const home = read('companion/home/index.html'), hjs = read('companion/home/home.js'), pre = read('companion/home/preload.js'), main = read('src/main-companion.js');
  assert.match(home, /<article class="glass card tour-card" id="tour-card">/);
  assert.match(home, /A few minutes with the Knot: your mic, the talk key, three questions, where it lives, screen sharing, who answers, two demos on your screen, and this dashboard\./);
  for (const id of ['tour-start', 'tour-skip', 'tour-state', 'start-foot']) assert.match(home, new RegExp('id="' + id + '"'), id);
  assert.doesNotMatch(home, /start-use-claude|start-gemini-key|start-try|start-ask/, 'the three steps are gone');
  assert.doesNotMatch(home.slice(home.indexOf('id="view-start"'), home.indexOf('id="view-saved"')), /—/);
  assert.match(hjs, /api\.tourState\(\)/); assert.match(hjs, /api\.tourStart\(\)/); assert.match(hjs, /api\.tourSkip\(\)/);
  assert.match(hjs, /step '\+st\.step\+' of '\+\(st\.of\|\|11\)/, 'the dashboard\'s count follows the tour');
  assert.doesNotMatch(hjs, /startState|startTry|startAsk|startClaude|startGemini/);
  for (const ch of ['tour:state', 'tour:start', 'tour:skip']) { assert.match(pre, new RegExp("invoke\\('" + ch + "'"), ch); assert.match(main, new RegExp("handle\\('home:" + ch + "'"), ch); }
  assert.match(pre, /'home:tour'/);
  assert.doesNotMatch(main, /home:start:|getStarted\.pageState|getStarted\.FIRST_ASK|onTryHeard/, 'the old handlers are gone');
  assert.match(main, /tourHomeTarget: async \(\) => \{/, 'main can measure its own Settings button for the keyless guide demo');
  assert.match(main, /tourPrefs: \{ get: \(\) => api\.getPreferences\(\), set: \(k, v\) => api\.setPreference\(k, v\) \}/);
  assert.match(main, /title: 'Nūs Dashboard'/);
  assert.match(home, /<title>Nūs Dashboard<\/title>/, 'the page title would overwrite the window\'s');
  assert.doesNotMatch(read('companion/renderer/index.html'), /Nūs Companion window/);
  // Strings a person reads: the window is the dashboard, never Home.
  const recall = read('companion/src/recall/recall.js'), idx = read('companion/index.js');
  assert.match(recall, /On the dashboard, under What Nūs knows about you, press Import chats\./);
  assert.match(recall, /On the dashboard, under What Nūs knows about you, choose your notes folder\./);
  assert.doesNotMatch(recall, /In Home/);
  assert.match(idx, /const NO_KEY_COPY = 'No AI is set up yet\. Add a free Gemini key or an Anthropic key on the dashboard, under Settings, Keys/);
  assert.match(idx, /label: 'Open the dashboard'/);
  const strings = (s) => (s.match(/'[^'\n]*'|"[^"\n]*"/g) || []).filter((q) => /\bHome\b/.test(q) && !/'Home'|"Home"|home_seen|Home: 'Home'/.test(q));
  assert.deepEqual(strings(read('companion/src/tour.js')), []);
  assert.deepEqual(strings(idx), []);
  assert.deepEqual(strings(read('companion/renderer/renderer.js')), []);
  assert.deepEqual(strings(hjs), []);
  assert.doesNotMatch(home.replace(/<!--[\s\S]*?-->/g, ''), />[^<]*\bHome\b[^<]*</, 'nothing on the dashboard calls itself Home');
});

test('no new telemetry from the tour', () => {
  assert.doesNotMatch(read('companion/src/tour.js'), /track\(|onboardingStep\(|fetch\(/);
  const main = read('companion/index.js');
  const block = main.slice(main.indexOf('// ---- the first-run tour'), main.indexOf('async function routeUtterance('));
  assert.doesNotMatch(block, /onboardingStep|stats\./);
});

test('card 8 suggests a question that fits the window in front', () => {
  const cases = [
    [{ process: 'chrome', title: 'Lofi beats - YouTube - Google Chrome' }, 'Where is the address bar?'],
    [{ process: 'firefox.exe', title: 'ChatGPT - Mozilla Firefox' }, 'Where is the address bar?'],
    [{ process: 'chrome', title: 'Compose Mail - me@gmail.com - Gmail - Google Chrome' }, 'Where do I attach a file?'],
    [{ process: 'OUTLOOK', title: 'Inbox - Outlook' }, 'Where do I attach a file?'],
    [{ process: 'WINWORD', title: 'Document1 - Word' }, 'Where do I change the font?'],
    [{ process: 'Notepad', title: 'Untitled - Notepad' }, 'Where do I save this?'],
    [{ process: 'SystemSettings', title: 'Settings' }, 'Where do I turn on dark mode?'],
    [{ process: 'ApplicationFrameHost', title: 'Settings' }, 'Where do I turn on dark mode?'],
    [{ process: 'ApplicationFrameHost', title: 'Calculator' }, 'What is this window for?'],
    [{ process: 'obs64', title: 'OBS 33.0.1 - Profile: Untitled' }, 'What is this window for?'],
    [null, 'What is this window for?'],
  ];
  for (const [front, chip] of cases) assert.equal(T.guideChip(front), chip, JSON.stringify(front));
  const main = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.match(main, /if \(tour\.step === Tour\.STEP\.guide && tour\.caps\.source\) tourWatchFront\(\);/);
  assert.match(main, /send\('tour:update', \{ chip \}\)/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8'), /if \(p\.chip != null\) \{ tourCard\.chip = p\.chip;/);
});

test('with no AI set up, the last card offers only first wins that work offline', () => {
  const T = require('../src/tour');
  const card = T.card(T.STEP.done, { caps: { keyReady: false, cli: false } });
  const ids = card.actions.map((a) => a.id);
  assert.deepEqual(ids, ['tour-try-feeds', 'tour-try-homework_start', 'tour-try-remember', 'tour-finish']);
  for (const w of T.FIRST_WINS) if (w.ai) assert.ok(!ids.includes('tour-try-' + w.struggle), w.struggle + ' needs AI');
  const { STRUGGLES } = require('../src/stats');
  for (const w of T.FIRST_WINS) assert.ok(STRUGGLES.includes(w.struggle), w.struggle + ' is a stats struggle');
});
