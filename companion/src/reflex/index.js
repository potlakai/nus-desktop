// The reflex engine: words in, actions out, at the speed of a classifier.
// Jev (System One) decides; this file sequences. It has no Companion code in
// it, so the same engine can sit behind the Knot, the desktop dashboard, or the
// vault's Telegram bridge. Anything it is not sure about is handed back to the
// caller's thinking model through onBrain.
//
//   const reflex = createReflex({ probe, shell, log, vaultDir, notesFile, onFire, onBrain, onVerb, onSpeak });
//   await reflex.start();
//   await reflex.handle('open notepad and type hello', { final: true });
//
// Streaming: call handle() with the utterance so far and final:false as often
// as partial transcripts arrive, then once with final:true. A clause is acted
// on at most once per utterance, however many partials mention it.
const fs = require('fs');
const path = require('path');
const jev = require('./jev');
const { createRulesClient } = require('./rules');
const PASS_FILLER = /^\s*(?:(?:alright|okay|ok|great|cool|nice|hmm+|uh+|um+|yeah|yes|no|right|so|well|hold on|one sec|wait|it's okay|its okay|never mind|nevermind|thanks|thank you)[\s.,!?]*)+$/i;
const { route, splitClauses, typePayload, plainDictation, POLICY } = require('./router');
const { loadCatalog } = require('./catalog');
const { createExecutor, browserExe } = require('./executor');
const routines = require('./routines');
const { createWarm } = require('../guide/assignment-watch');

// Words that open a request for guidance. Code can see this at once, with no
// model: such a clause is never cut at a command verb, and a caller that knows
// the words were meant for it (typed, or spoken with the talk key held) may
// start reading the screen before Jev has even answered.
const GUIDE_OPEN = /^(?:(?:hey|ok|okay|so|um|uh|please|nus|nus|can you|could you|would you)[\s,]+)*(?:how (?:do|can|would|should) (?:i|you|we)|how to|help me|show me|where is|where's|where are|where do i|where can i|walk me through|point (?:at|to|me to)|guide me|teach me)\b/i;
function opensLikeGuideAsk(text) { return GUIDE_OPEN.test(String(text || '').trim()); }

function createReflex({ probe, hands, shell, log, vaultDir, notesFile, onFire, onWillFire, onBrain, onVerb, onSpeak, onIntent, jevClient, spawnFn, routinesFile, onOffer, onOfferClosed, offerDelayMs, onUnavailable, onFocusGuard, refuseSite, rules = true }) {
  const say = log || (() => {});
  // With no classifier key the rules (src/reflex/rules.js) answer the same
  // questions, so the engine still runs: conservative, never a guess fired.
  const client = jevClient || (jev.ready() || !rules ? jev : createRulesClient({ apps: () => apps }));
  const exec = createExecutor({ probe, hands, shell, log: say, vaultDir, notesFile, spawnFn, refuseSite });
  const session = { lastApp: '', lastSite: '', lastAction: '' };
  const cache = new Map();
  let apps = [];
  // One state per utterance. Live 2026-09-21: the final transcript of sentence 1
  // arrived after sentence 2 had already fired early, found "clause 0 already
  // done" in the shared state, and was silently dropped. Nothing got typed.
  const utts = new Map();
  function getUtt(id) {
    if (!utts.has(id)) { utts.set(id, fresh()); if (utts.size > 12) utts.delete(utts.keys().next().value); }
    return utts.get(id);
  }
  let chain = Promise.resolve();
  let partialBusy = false;
  let partialRun = Promise.resolve();
  let pendingSettle = null;
  let unsafeUntil = 0;

  function fresh() { return { done: new Set(), early: new Map(), acted: new Set(), count: 0, startedAt: Date.now() }; }

  // Guard rails, added after a transcription loop opened 43 browser windows
  // (2026-09-21). However wrong the words are, the damage is bounded:
  //   one utterance never repeats an action, never runs more than MAX_ACTIONS,
  //   and the same app or site is not launched again within COOLDOWN_MS.
  const MAX_ACTIONS = 6;
  const COOLDOWN_MS = 4000;
  const lastLaunch = new Map();
  function actionKey(d) { return d.intent + '|' + (d.app ? d.app.key : d.url || String(d.text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()); }
  function blocked(d, utt) {
    const k = actionKey(d);
    if (utt.acted.has(k)) return 'already done in this sentence';
    if (utt.count >= MAX_ACTIONS) return 'more than ' + MAX_ACTIONS + ' actions in one sentence';
    const launches = d.intent === 'open_app' || d.intent === 'open_site' || d.intent === 'web_search';
    if (launches && Date.now() - (lastLaunch.get(k) || 0) < COOLDOWN_MS) return 'same launch ' + COOLDOWN_MS + ' ms ago';
    return null;
  }
  function record(d, utt) {
    const k = actionKey(d);
    utt.acted.add(k); utt.count++;
    lastLaunch.set(k, Date.now());
  }

  async function start() {
    if (!client.ready()) { say('[reflex] off: no TypeSafe key (env TYPESAFE_API_KEY or Settings)'); return false; }
    apps = await loadCatalog(probe, say);
    say('[reflex] ready, ' + apps.length + ' apps');
    warm();
    return true;
  }

  // Cold costs measured live 2026-09-21: the first Jev call on a fresh
  // connection is ~700 ms against ~180 ms warm, and the key-press sidecar takes
  // ~3 s to start. Pay both before the person speaks: at startup and whenever
  // the mic opens.
  let warmedAt = 0;
  const warmJev = createWarm({ client });
  function warm() {
    if (!enabled() || Date.now() - warmedAt < 3000) return;
    warmedAt = Date.now();
    if (hands) hands.request('ping', {}, 10000).catch(() => {});
    warmJev();
  }

  function enabled() { return client.ready() && process.env.NUS_REFLEX !== '0'; }

  async function decideClause(clause, final, keyed) {
    const key = (final ? 'F|' : 'P|') + (keyed ? 'K|' : '') + clause.toLowerCase();
    if (cache.has(key)) return Object.assign({}, cache.get(key), { ms: 0, cached: true });
    const d = await route(clause, { final, apps, context: session, jev: client, log: say, keyed });
    if (cache.size > 200) cache.clear();
    cache.set(key, d);
    return d;
  }

  function brief() {
    if (!vaultDir) return null;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(vaultDir, 'work', 'jev', 'brief-top3.json'), 'utf8'));
      return j && j.spoken ? j : null;
    } catch (_) { return null; }
  }

  // A run of three or more actions is worth keeping. When the person goes quiet
  // after one, the Knot asks once whether to save it; "yes" writes a real routine
  // to disk and "run my routine" replays it. Nothing is saved without a yes.
  const SEQ_GAP_MS = 20000;
  const OFFER_MIN_STEPS = 3;
  const OFFER_WINDOW_MS = 15000;
  let seq = { steps: [], lastAt: 0, offered: false };
  let pendingOffer = null;
  let offerTimer = null;

  function noteStep(d) {
    const step = d.replay ? null : routines.toStep(d);
    if (!step) return;
    if (Date.now() - seq.lastAt > SEQ_GAP_MS) seq = { steps: [], lastAt: 0, offered: false };
    seq.steps.push(step); seq.lastAt = Date.now();
  }

  function armOffer() {
    clearTimeout(offerTimer);
    if (!onOffer || !routinesFile || seq.offered || seq.steps.length < OFFER_MIN_STEPS) return;
    offerTimer = setTimeout(() => {
      if (seq.offered || seq.steps.length < OFFER_MIN_STEPS) return;
      seq.offered = true;
      pendingOffer = { steps: seq.steps.slice(), at: Date.now() };
      say('[reflex] offer: save ' + pendingOffer.steps.length + ' steps as a routine?');
      onOffer(pendingOffer.steps);
    }, offerDelayMs == null ? 1500 : offerDelayMs);
  }

  // The words right after the offer. Jev decides yes, no, or "that was not an
  // answer" (a new command goes on to be handled normally).
  async function answerOffer(text, offer) {
    let reply = { choice: 'other', confidence: 0 };
    try {
      const r = await client.systemOne({
        state: { asked: 'Want me to save that as a routine?', utterance: text },
        questions: { reply: { type: 'choice', instructions: 'The assistant just asked the question in `asked`. `utterance` is what the person said next. Which is it?', criteria: {
          yes: 'Agrees: yes, yeah, sure, save it, do it, okay, please',
          no: 'Declines: no, nope, nah, not now, do not, no thanks, I am good',
          other: 'Not an answer to the question: a new command, or talk about something else' } } },
        log: say
      });
      reply = r.answers.reply || reply;
    } catch (e) { say('[reflex] offer answer failed: ' + e.message); }
    if (reply.choice === 'yes' && reply.confidence >= 0.6) {
      const saved = routines.save(routinesFile, offer.steps);
      say('[reflex] routine saved: ' + (saved ? saved.name + ' (' + saved.steps.length + ' steps)' : 'nothing to save'));
      if (onOfferClosed) onOfferClosed('saved', saved);
      return { consumed: true, answer: 'yes' };
    }
    if (reply.choice === 'no' && reply.confidence >= 0.6) {
      say('[reflex] routine declined');
      if (onOfferClosed) onOfferClosed('declined', null);
      return { consumed: true, answer: 'no' };
    }
    if (onOfferClosed) onOfferClosed('ignored', null);
    return { consumed: false };
  }

  async function replayLatest(heardAt) {
    const r = routinesFile ? routines.latest(routinesFile) : null;
    if (!r) { if (onSpeak) onSpeak('No saved routine yet.'); return; }
    say('[reflex] replaying "' + r.name + '" (' + r.steps.length + ' steps)');
    for (const step of r.steps) {
      const d = routines.toDecision(step, apps);
      if (d) await fire(d, heardAt);
      else say('[reflex] routine step skipped, app not installed: ' + step.label);
    }
  }

  async function fire(d, heardAt) {
    const t0 = Date.now();
    // A launch from the clause before has to land before keys are sent at it.
    const pressesKeys = !['open_app', 'open_site', 'web_search', 'remember_note', 'brief', 'next', 'dismiss', 'run_routine', 'focus_guard'].includes(d.intent);
    // A launch failed to land a moment ago: the window in front is not the one
    // the person is talking to, so no keys go anywhere until a launch lands.
    // (Live 2026-09-21: the new note was skipped, then the text was typed 4 s
    // later into whatever happened to be in front.)
    if (pressesKeys && !pendingSettle && Date.now() < unsafeUntil) {
      say('[reflex] skip ' + d.intent + ': still no safe window after the failed launch');
      return { ok: false, error: 'no safe window' };
    }
    if (pendingSettle && pressesKeys) {
      const landed = await pendingSettle();
      pendingSettle = null;
      unsafeUntil = landed ? 0 : Date.now() + 8000;
      // The window we meant to type into never came to the front. Keys would
      // land in whatever the person has focused, so they are not sent.
      if (!landed) {
        say('[reflex] skip ' + d.intent + ': the launch before it did not come to the front');
        if (onFire) onFire({ intent: d.intent, label: 'waiting for the window', confidence: d.confidence, jevMs: d.ms, totalMs: Date.now() - heardAt, early: !d.final, ok: false, refused: null });
        return { ok: false, error: 'launch did not land' };
      }
    }
    pendingSettle = null;
    let result = { ok: true };
    if (d.intent === 'next' || d.intent === 'dismiss') { if (onVerb) onVerb(d.intent); }
    else if (d.intent === 'run_routine') { await replayLatest(heardAt); }
    else if (d.intent === 'focus_guard') {
      // The guard itself lives with the host (it owns the Knot and the
      // settings switch); the engine only hands over what was asked.
      if (onFocusGuard) onFocusGuard(d.focus || { kind: 'start', feeds: [], minutes: null, untilApp: null });
      else result = { ok: false, error: 'no focus guard' };
    }
    else if (d.intent === 'brief') {
      const b = brief();
      if (!b) return { ok: false, brain: true };
      if (onSpeak) onSpeak(b.spoken, b);
    } else {
      // A search or site goes to the browser named in the last two minutes, if any.
      if (session.lastBrowser && Date.now() - session.lastBrowserAt < 120000) d.browserApp = session.lastBrowser;
      // No "on it" in front of the focus guard's no: the executor below says the line.
      const refused = refuseSite && (d.intent === 'open_app' || d.intent === 'open_site') && refuseSite(d.app ? d.app.name : d.url);
      if (onWillFire && !refused) { try { onWillFire(d); } catch (_) { /* a hint, never a failure */ } }
      result = await exec.run(d);
      if (result.settle) pendingSettle = result.settle;
    }
    if (d.app) { session.lastApp = d.app.name; if (browserExe(d.app.name)) { session.lastBrowser = d.app.name; session.lastBrowserAt = Date.now(); } }
    if (d.url) session.lastSite = d.url;
    session.lastAction = d.intent;
    const total = Date.now() - heardAt;
    say('[reflex] fire ' + d.intent + ' "' + (d.label || '') + '" conf=' + d.confidence.toFixed(2) + ' jev=' + d.ms + 'ms act=' + (Date.now() - t0) + 'ms total=' + total + 'ms' + (d.final ? '' : ' EARLY') + (result.ok ? '' : ' FAILED ' + (result.refused || result.error || '')));
    if (onFire) onFire({ intent: d.intent, label: d.label || d.intent, confidence: d.confidence, jevMs: d.ms, totalMs: total, early: !d.final, ok: result.ok, refused: result.refused || null, line: result.line || '', text: d.text || '', clause: d.clause || '' });
    if (result.ok) noteStep(d);
    return result;
  }

  // People pause after the verb: "type ... hello from Nūs", "and search ...
  // Norbert Wiener" (live 2026-09-21). The listener ends a segment at the pause,
  // so the verb arrives alone. A verb with nothing after it is held for a few
  // seconds and glued to the front of whatever is said next.
  const DANGLING = /(?:^|[\s,.;])(?:(?:can|could|would) you |please |and |then |now |lets |let's )*(?:type|write|enter|search(?: for)?|google(?: search)?|look up|add a note|make a note|remember(?: that)?|remind me(?: to)?|open(?: up)?|go to|launch|make the title say|say|that says)[\s,.!?]*$/i;
  const CARRY_MS = 6000;
  // "Open Notepad and type" ... and then the sentence, once Notepad is up (live
  // 2026-11-20: 12 s later, the held "type" was gone and the sentence went to
  // the guide). A held "type" waits longer than a held "open" or "search": what
  // follows it can only be its text.
  const CARRY_TYPE_MS = 15000;
  let carry = { text: '', at: 0 };
  function withCarry(text) {
    if (carry.text && Date.now() - carry.at < (/^(?:type|write)\b/i.test(carry.text) ? CARRY_TYPE_MS : CARRY_MS)) return carry.text + ' ' + text;
    return text;
  }

  // Returns { handled, brainText }. handled:false means the caller should
  // treat the words exactly as it did before the reflex layer existed.
  function handle(text, opts) {
    const isFinal = !opts || opts.final !== false;
    clearTimeout(offerTimer);                      // the person is talking: do not interrupt
    if (isFinal && pendingOffer && Date.now() - pendingOffer.at < OFFER_WINDOW_MS && enabled()) {
      const offer = pendingOffer; pendingOffer = null;
      return answerOffer(String(text || ''), offer).then((res) => (res.consumed
        ? { handled: true, brainText: null, offer: res.answer }
        : handleWords(text, opts)));
    }
    if (pendingOffer && Date.now() - pendingOffer.at >= OFFER_WINDOW_MS) { pendingOffer = null; if (onOfferClosed) onOfferClosed('expired', null); }
    const out = handleWords(text, opts);
    return isFinal ? out.then((res) => { armOffer(); return res; }) : out;
  }

  function handleWords(text, opts) {
    const final = !opts || opts.final !== false;
    const heardAt = (opts && opts.heardAt) || Date.now();
    const uttId = opts && opts.uttId != null ? String(opts.uttId) : 'default';
    // The talk key or the keyboard, not the open room mic (see router.js decide).
    const keyed = Boolean(opts && opts.keyed);
    if (!enabled()) return Promise.resolve({ handled: false, brainText: final ? text : null });
    text = withCarry(String(text || ''));
    if (final) {
      carry = { text: '', at: 0 };
      const clauses = splitClauses(text, { keyed });
      const last = clauses[clauses.length - 1] || '';
      // A sentence being typed may end in any word ("type I love to write"):
      // its last word is text, not a verb waiting for more.
      const m = keyed && plainDictation(last) ? null : DANGLING.exec(last);
      // The verb is held; anything said before it in the same clause still runs:
      // "create a new note type" runs the new note now and keeps "type" for later.
      if (m) {
        const front = last.slice(0, m.index).trim();
        carry = { text: last.slice(m.index).replace(/^[\s,.;]+|[\s,.!?]+$/g, ''), at: Date.now() };
        say('[reflex] holding "' + carry.text + '" for what comes next');
        text = clauses.slice(0, -1).concat(front ? [front] : []).join(', ');
        if (!text) return Promise.resolve({ handled: true, brainText: null, held: carry.text });
      } else if (typePayload(last) === '') {
        // "Type in.", "Can you type in the notepad?": the verb and where, and
        // the words still to come (live 2026-11-20: "in" and "the notepad" were typed).
        carry = { text: 'type', at: Date.now() };
        say('[reflex] holding "type" for what comes next ("' + last.slice(0, 40) + '")');
        text = clauses.slice(0, -1).join(', ');
        if (!text) return Promise.resolve({ handled: true, brainText: null, held: carry.text });
      }
    }
    if (!final) {
      if (partialBusy) return Promise.resolve({ handled: false, brainText: null });
      partialBusy = true;
      partialRun = step(text, false, heardAt, getUtt(uttId), keyed).catch((e) => { say('[reflex] partial error: ' + e.message); return { handled: false, brainText: null }; }).finally(() => { partialBusy = false; });
      return partialRun;
    }
    // The final pass waits for a partial still in flight, so a clause that is
    // firing early right now is never fired a second time.
    chain = chain.then(() => partialRun).then(() => step(text, true, heardAt, getUtt(uttId), keyed)).catch((e) => { say('[reflex] error: ' + e.message); return { handled: false, brainText: text }; });
    const out = chain;
    chain = chain.then(() => { utts.delete(uttId); });
    return out;
  }

  // whisper often drops the comma: "create a new note type hello from nus"
  // arrives as one clause. Code proposes a cut before a command verb; the cut is
  // kept only if Jev says the part before it is a complete action of its own
  // that carries no free text. So "search how to type faster" stays whole (its
  // front half is a search), and "create a new note | type hello" splits.
  const VERB_AT = /^(?:open|launch|create|make|type|write|search|google|close|switch|snap|take|turn|mute|play|pause|add|remember|remind|maximize|minimize)$/i;
  const CARRIES_TEXT = new Set(['type_text', 'web_search', 'remember_note', 'ask', 'guide', 'none', 'brief', 'focus_guard']);
  // "help me make a pivot table": the "make" is part of the ask, not a second
  // command. A clause that opens like a request for guidance is never cut, which
  // also saves the Jev call that only existed to find that out.
  async function splitAtVerb(clause, keyed) {
    if (GUIDE_OPEN.test(clause.trim())) return null;
    if (keyed && plainDictation(clause)) return null;   // a sentence being typed is never cut
    const ws = clause.split(/\s+/).filter(Boolean);
    for (let k = 2; k < ws.length - 0; k++) {
      if (!VERB_AT.test(ws[k].replace(/[^a-z]/gi, ''))) continue;
      const front = ws.slice(0, k).join(' ');
      let d;
      try { d = await decideClause(front, true, keyed); } catch (_) { return null; }
      if (d.fire && !CARRIES_TEXT.has(d.intent) && d.confidence >= 0.8) return [front, ws.slice(k).join(' ')];
      return null;   // the first candidate decides: no fishing for a cut that works
    }
    return null;
  }

  // Every pass, partial or final, cuts the words into the SAME pieces before it
  // looks at what is already done. (First attempt cut inside the loop: the
  // partial pass marked piece 0 = "open notepad" done, the final pass saw piece
  // 0 = the whole uncut sentence, called it done, and ran nothing after it.)
  async function pieces(text, keyed) {
    const out = [];
    for (const clause of splitClauses(text, { keyed })) {
      let rest = clause;
      for (let guard = 0; guard < 6; guard++) {
        const cut = await splitAtVerb(rest, keyed);
        if (!cut) break;
        out.push(cut[0]); rest = cut[1];
      }
      out.push(rest);
    }
    return out;
  }

  const CHAIN_KEYS = new Set(['volume_up', 'volume_down', 'mute', 'play_pause', 'snap_left', 'snap_right', 'maximize', 'minimize', 'screenshot']);
  const CHAIN_MIN = 0.7;
  async function step(text, final, heardAt, utt, keyed) {
    const clauses = await pieces(text, keyed);
    const brain = [];
    let fired = 0;
    let down = false;
    for (let i = 0; i < clauses.length; i++) {
      if (utt.done.has(i)) continue;
      const last = i === clauses.length - 1;
      const clauseFinal = final || !last;
      // Fired early on its first words: nothing more to do for this piece.
      if (utt.early.has(i)) { if (clauseFinal) { utt.early.delete(i); utt.done.add(i); } fired++; continue; }
      let d;
      try { d = await decideClause(clauses[i], clauseFinal, keyed); }
      catch (e) {
        say('[reflex] jev failed: ' + e.message);
        // Jev being down is not a reason to wake the slow thinking model with a
        // plain command (live 2026-09-21: TypeSafe returned 503 for minutes and
        // every "open notepad" became a guide session). Say so, do nothing.
        if (clauseFinal) { utt.done.add(i); down = true; }
        continue;
      }
      // A request for guidance, heard early: the caller may start reading the
      // screen while the rest of the sentence is still being spoken. The same
      // bars the brain handoff uses, so room talk never triggers a screen read.
      if (onIntent && (d.intent === 'guide' || d.intent === 'ask') && d.confidence >= POLICY.finalIntent && (d.addressed == null || d.addressed >= POLICY.brainAddressedMin)) {
        try { onIntent({ intent: d.intent, confidence: d.confidence, final: clauseFinal, clause: clauses[i] }); } catch (_) { /* a hint, never a failure */ }
      }
      // Two actions in one sentence: each key-press clause must be a clear ask
      // on its own (0.7), or a half-heard second clause would press keys.
      if (d.fire && clauses.length > 1 && CHAIN_KEYS.has(d.intent) && d.confidence < CHAIN_MIN) {
        say('[reflex] chain clause too unsure: ' + d.intent + ' ' + d.confidence.toFixed(2) + ' "' + clauses[i].slice(0, 50) + '"');
        d = Object.assign({}, d, { fire: false, brain: (d.addressed == null || d.addressed >= POLICY.brainAddressedMin) });
      }
      if (d.fire) {
        const why = blocked(d, utt);
        if (why) {
          say('[reflex] BLOCKED ' + d.intent + ' "' + (d.label || '') + '": ' + why);
          if (clauseFinal) utt.done.add(i);
          continue;
        }
        record(d, utt);
        const r = await fire(d, heardAt);
        if (r && r.brain) brain.push(clauses[i]); else fired++;
        if (clauseFinal) utt.done.add(i); else utt.early.set(i, d);
      } else if (clauseFinal) {
        utt.done.add(i);
        // A clause the classifier is unsure of still came through the talk
        // key (live 2026-11-02: "Open YouTube" at open_site 0.54 was dropped and
        // nothing happened). Unless it is filler, it goes on to the model.
        if (d.brain || !PASS_FILLER.test(clauses[i])) { brain.push(clauses[i]); say('[reflex] pass "' + clauses[i].slice(0, 50) + '" -> ' + d.intent + ' ' + d.confidence.toFixed(2) + ', on to the model'); }
        else say('[reflex] pass "' + clauses[i].slice(0, 50) + '" -> ' + d.intent + ' ' + d.confidence.toFixed(2));
      }
    }
    if (down && onUnavailable) onUnavailable();
    const brainText = brain.join(', ');
    if (final && brainText && onBrain) onBrain(brainText);
    return { handled: fired > 0 || down || (final && !brainText), brainText: brainText || null, fired, down };
  }

  return { start, handle, warm, enabled, session, get apps() { return apps; } };
}

module.exports = { createReflex, opensLikeGuideAsk };
