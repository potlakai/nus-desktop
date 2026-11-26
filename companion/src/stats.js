// Anonymous usage stats for the standalone Companion. The contract lives in
// the vault: ventures/nus/growth-os/TELEMETRY-CONTRACT.md. One plain POST per
// event to the `track` function, no SDK, no auth header, no account: a random
// install id made on first launch is the only identity, and deleting it (or
// turning stats off) ends the link. Coursework and what the user types never
// leave the device; props are a fixed set of short enum values.
//
// Rules: default on, "Send anonymous usage stats" in Settings turns it off
// (one stats_off, then silence). NUS_STATS=0 disables it anywhere. An
// unpackaged dev run sends nothing unless NUS_STATS=1. Every send is fire and
// forget: 4 s timeout, one retry at most, every failure swallowed.
//
// Electron-free on purpose so it runs under node --test: the host passes the
// userData folder, a settings accessor, the version and fetch.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TRACK_URL = 'https://xnpkplcjurzwanotmwwt.supabase.co/functions/v1/track';
const PRODUCT = 'companion';
const EVENTS = new Set(['install', 'app_open', 'source_answer', 'first_ask', 'ask', 'key_connected', 'companion_session', 'stats_off',
  'feature_session', 'app_session', 'onboarding_step', 'first_run_end', 'crash', 'update_installed',
  'update_offered', 'notice_shown', 'notice_clicked',
  'first_win', 'engaged', 'ai_ready', 'hook_shown', 'hook_used',
  // Amendment (f), 2026-11-11: the sign-in door (Sign in with publik).
  'signin_shown', 'signin_clicked', 'signin', 'signin_closed', 'signin_unreachable', 'ai_source',
  // 0.1.38 (eighth edition on the server): how a run ended, see EXIT_REASONS.
  'app_exit']);
const PROP_KEYS = new Set(['acq_action_id', 'utm_source', 'utm_medium', 'utm_campaign', 'source', 'mode', 'provider', 'minutes', 'method', 'unit', 'reason', 'os_version', 'locale', 'dev',
  'feature', 'seconds', 'outcome', 'step', 'from', 'surface', 'notice', 'via',
  'hook', 'path', 'struggle', 'nudge_group', 'cohort', 'screen']);
const SOURCES = ['instagram', 'friend', 'reddit', 'x', 'youtube', 'search', 'other', 'skipped'];
const MODES = ['voice', 'text', 'guide'];
// Contract amendment 2026-10-17 (c): which feature answered (never what was
// asked), how it ended, and the first-run steps a new install reaches. Fixed
// lists; anything else is dropped before the send.
const FEATURES = ['reflex', 'hands', 'memory', 'focus_guard', 'reminder', 'guide', 'plan', 'chat', 'voice',
  // Amendment (e), 2026-11-06: a greeting ("hello") is its own feature so it can
  // never count as a first win; the rest name features that had no row before.
  'greeting', 'rewrite', 'page_read', 'recall', 'project',
  // 0.1.37 (ventures/nus/conditor/dictate-0137): hold Ctrl + Win and the words
  // are typed in. Its own name so engaged can be read with and without it. The
  // server learns it in the seventh edition; until then its rows are refused.
  'dictation'];
const OUTCOMES = ['ok', 'failed', 'no_provider', 'cancelled', 'timeout'];
const STEPS = ['welcome_seen', 'stats_notice_seen', 'key_prompt_seen', 'key_skipped', 'key_connected', 'first_window_closed',
  // Amendment (e): each tour card reached, the struggle picked on the first
  // card, and the start-with-Windows answer.
  'tour_voice', 'tour_mic', 'tour_key', 'tour_questions', 'tour_home', 'tour_sharing', 'tour_ai', 'tour_guide', 'tour_hands',
  'tour_dashboard', 'tour_done', 'tour_skipped', 'struggle_picked', 'autostart_on', 'autostart_off',
  // 0.1.37: the dictation card after the talk key's card (seventh edition on the server).
  'tour_dictate',
  // 0.1.40 (ninth edition): the choose screen publik showed (free use or a balance, a plan, none left),
  // the no-key check before "Use my own key", the tour's AI card first when nothing can answer, and
  // its "Get a free key" button.
  'door_balance', 'door_plan', 'door_empty', 'door_nokey_seen', 'tour_ai_first', 'tour_get_key'];
// Amendment (e), 2026-11-06: the honest retention ladder. Each list is fixed;
// anything else is dropped before the send.
// hook: which retention loop was put in front of the person, or taken up.
const HOOKS = ['checkin', 'morning_line', 'continue_project', 'reminder_toast', 'autostart_offer', 'my_nus', 'knot_report', 'notice',
  'winback_d3', 'winback_d7', 'winback_d30', 'share_card', 'quiet_mode',
  // Amendment (f): the one ask for an email after a first win. Shown, saved
  // (hook_used contact_card) or turned down (hook_used contact_declined).
  'contact_card', 'contact_declined',
  // 0.1.38: one line telling an install that took the update that dictation exists
  // (the tour's dictation card is only seen by new installs).
  'dictation_news'];
// 0.1.38: how a run of Nūs ended. Half of the people who chose start with Windows
// are not seen the next day (read of 2026-11-23) and nothing said why. One row
// {reason} as the app goes: quit (the person chose Quit Nūs), shutdown (Windows
// is signing out or shutting down), update (closing to install one), uninstall
// (sent by the uninstaller's one run of the app), exam (a proctored exam is
// open), other. A crash or a killed process sends none; sleep is not an exit.
const EXIT_REASONS = ['quit', 'shutdown', 'update', 'uninstall', 'exam', 'other'];
// path: how answers are possible on this install, sent once after the key card.
// publik (amendment f): publik's AI answers and no key is on this computer.
const AI_PATHS = ['key', 'claude_code', 'none', 'publik'];
// Amendment (f), 2026-11-11: the sign-in door. Fixed lists; nothing from
// publik's files, no account, no email, ever.
// cohort: was a different version here before this one (update) or not (new).
// screen: where the door stood when it was closed. ai_source path: who answers
// once the person is through, publik or their own key.
const COHORTS = ['new', 'update'];
const GATE_SCREENS = ['sign_in', 'waiting', 'choose', 'unreachable'];
const AI_SOURCES = ['publik', 'own_key'];
// The door's rows wait on this computer until the server takes them: the door
// is where the app quits, and where the network is most often missing. A short
// list in stats-state.json, oldest first, tried again at the next launch.
const QUEUE_MAX = 30;
const QUEUE_MAX_AGE_MS = 14 * 24 * 3600 * 1000;
const QUEUE_MAX_TRIES = 8;
// struggle: the one tap on the first card ("What wastes your time?").
const STRUGGLES = ['homework_start', 'feeds', 'find_in_apps', 'writing', 'remember', 'other'];
// via: what started this process. login = Windows at sign-in (the --autostart
// argument), relaunch = the app restarted itself (after an update), manual = a person.
const VIAS = ['login', 'manual', 'relaunch'];
// One install in ten gets no proactive pop-ups at all, so the numbers can say
// whether the pop-ups help. Chosen once, on this computer, and kept.
const NUDGE_HOLDOUT = 0.1;
// Contract amendment 2026-11-04 (d): where a new version was offered, how it got
// installed, and which of our own numbered messages. The id is a number we assign
// in the signed channel file, so it cannot carry anything from the person.
const SURFACES = ['bubble', 'card'];
const NOTICE_ID = /^n[0-9]{1,6}$/;
const TIMEOUT_MS = 4000;
const DAY_CHECK_MS = 15 * 60 * 1000;
// A hello or an engaged that got no answer: asked again this soon, once, then at each day check.
const RETRY_MS = 45 * 1000;
const ENGAGED_RETRY_MS = 60 * 1000;
const PROPS_MAX_BYTES = 1024;
const CRASHES_PER_PROCESS = 3;
// Session length (contract amendment 2026-10-15 b, renamed app_session in (c)):
// once a minute, the minute counts as active when the system has not been idle
// for 5 minutes. The count goes out as one app_session {minutes} at quit and at
// each UTC day change, then resets. Only a number of minutes leaves; nothing
// about them.
const MINUTE_MS = 60 * 1000;
const IDLE_LIMIT_S = 5 * 60;
// Pranav's own machines: NUS_STATS_DEV=1 or <userData>/dev-install.txt marks
// every event dev: true and the server leaves those installs out of the numbers.
const DEV_FILE = 'dev-install.txt';

// Shown once, on the first window after install, with the switch beside it.
const NOTICE = 'Nūs sends anonymous usage stats (which features get used, never your coursework or what you type). Turn off in Settings.';

function utcDay(now) { return new Date(now).toISOString().slice(0, 10); }

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { return {}; } }
function writeJson(file, value) {
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2)); fs.renameSync(file + '.tmp', file); } catch { /* stats never break the app */ }
}

// The id lives in its own small file so a person can find it and delete it.
function loadInstallId(file) {
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(existing)) return existing;
  } catch { /* first run */ }
  const id = crypto.randomUUID();
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, id + '\n', { mode: 0o600 }); } catch { /* keep it for this process at least */ }
  return id;
}

function cleanProps(props) {
  const out = {};
  for (const [k, v] of Object.entries(props || {})) {
    if (!PROP_KEYS.has(k)) continue;
    if (typeof v === 'string') out[k] = v.slice(0, 200);
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'boolean') out[k] = v;
  }
  return Buffer.byteLength(JSON.stringify(out)) > PROPS_MAX_BYTES ? {} : out;
}

/**
 * @param {object} o
 * @param {string} o.userData        folder for install_id.txt and stats-state.json
 * @param {{get: () => object, set: (patch: object) => any}} o.settings  the companion settings store (sendStats flag)
 * @param {string} o.appVersion
 * @param {string} [o.platform]
 * @param {boolean} o.packaged       app.isPackaged
 * @param {object} [o.env]           process.env by default
 * @param {Function} [o.fetch]       global fetch by default
 * @param {() => number} [o.now]
 * @param {Function} [o.setInterval] for tests
 * @param {Function} [o.setTimeout]  for tests (the one short retry after a send that got no answer)
 * @param {() => number} [o.idleSeconds]  system idle time (powerMonitor.getSystemIdleTime); absent = every minute counts
 * @param {boolean} [o.dev]          force the dev flag (tests); otherwise NUS_STATS_DEV=1 or <userData>/dev-install.txt
 */
function createStats(o) {
  const env = o.env || process.env;
  const fetchFn = o.fetch || globalThis.fetch;
  const now = o.now || Date.now;
  const timers = { setInterval: o.setInterval || setInterval, clearInterval: o.clearInterval || clearInterval,
    setTimeout: o.setTimeout || setTimeout, clearTimeout: o.clearTimeout || clearTimeout };
  const platform = o.platform || process.platform;
  const idFile = path.join(o.userData, 'install_id.txt');
  const stateFile = path.join(o.userData, 'stats-state.json');
  const url = o.url || TRACK_URL;
  const dev = o.dev === true || String(env.NUS_STATS_DEV || '') === '1' || fs.existsSync(path.join(o.userData, DEV_FILE));
  let installId = null;
  let state = null;
  let dayTimer = null;
  let minuteTimer = null;
  let lastOpenDay = '';
  let activeMinutes = 0;
  let firstAskInFlight = false;
  let firstWinInFlight = false;
  // Rows that got no answer and are still owed today (see open and engaged).
  let openOwed = null;
  let engagedOwed = '';
  let engagedTriedAt = 0;
  let engagedInFlight = false;
  let retryTimer = null;
  let crashesSent = 0;
  // The sign-in door in this process, and the rows the server refused this run.
  let gate = null;
  let flushing = null;
  const refused = new Set();
  const stepsTried = new Set();
  // Open feature timers (a guide walking, Hands running, the focus guard on):
  // each is a stopper that sends feature_session {feature, seconds} once.
  const openFeatures = new Set();

  function id() { if (!installId) installId = loadInstallId(idFile); return installId; }
  function st() { if (!state) state = readJson(stateFile); return state; }
  function remember(patch) { state = { ...st(), ...patch }; writeJson(stateFile, state); }

  // The pop-up holdout, chosen once per install and kept in stats-state.json.
  // Pranav's own machines always count as 'on' so he sees what users see.
  function nudgeGroup() {
    const s = st();
    let g = s.nudgeGroup;
    if (g !== 'on' && g !== 'off') { g = (o.random || Math.random)() < NUDGE_HOLDOUT ? 'off' : 'on'; remember({ nudgeGroup: g }); }
    return dev ? 'on' : g;
  }

  function switchedOn() { const s = o.settings.get() || {}; return s.sendStats !== false; }
  // Everything that has to be true for one byte to leave the machine.
  function enabled() {
    if (String(env.NUS_STATS || '') === '0') return false;
    if (!o.packaged && String(env.NUS_STATS || '') !== '1') return false;
    return switchedOn() && typeof fetchFn === 'function';
  }

  async function post(body) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetchFn(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal });
      return { status: Number(res && res.status) || 0 };
    } finally { clearTimeout(timer); }
  }

  // Resolves to { sent, status } and never rejects. Callers do not await it.
  async function track(name, props) {
    try {
      if (!EVENTS.has(name) || !enabled()) return { sent: false, status: 0 };
      const body = { install_id: id(), product: PRODUCT, name, app_version: String(o.appVersion || ''), platform,
        props: cleanProps(dev ? { ...(props || {}), dev: true } : props) };
      // One retry at most, and only for a dropped connection, a timeout or a
      // 5xx. A 4xx is the server saying no; asking again changes nothing.
      let r = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try { r = await post(body); } catch { r = null; }
        if (r && r.status < 500) break;
      }
      const sent = !!r && r.status > 0 && r.status < 500;
      return { sent, status: r ? r.status : 0 };
    } catch { return { sent: false, status: 0 }; }
  }

  // ---- rows that must not be lost (amendment f) ----
  // Written to stats-state.json before the send and removed only once the
  // server took the row (2xx). No answer at all: stop, the next launch goes on
  // from here. A refusal (a server that does not know the name yet says 400):
  // the row stays, is tried once per launch, and is dropped after 8 refusals
  // or 14 days. Stats off: nothing is kept.
  const none = () => Promise.resolve({ sent: false, status: 0 });
  function queued() { const q = st().queue; return Array.isArray(q) ? q : []; }
  function durable(name, props) {
    if (!EVENTS.has(name) || !enabled()) return none();
    const item = { k: now() + '-' + Math.random().toString(36).slice(2, 8), name, props: cleanProps(props), at: now(), tries: 0 };
    remember({ queue: queued().concat(item).slice(-QUEUE_MAX) });
    return flush();
  }
  function flush() {
    if (flushing) return flushing;
    flushing = (async () => {
      let last = { sent: false, status: 0 };
      for (;;) {
        const live = queued().filter(i => i && EVENTS.has(i.name) && now() - (Number(i.at) || 0) < QUEUE_MAX_AGE_MS && (Number(i.tries) || 0) < QUEUE_MAX_TRIES);
        if (live.length !== queued().length) remember({ queue: live });
        const item = live.find(i => !refused.has(i.k));
        if (!item || !enabled()) break;
        const r = await track(item.name, item.props);
        last = r;
        if (r.status >= 200 && r.status < 300) remember({ queue: queued().filter(i => i.k !== item.k) });
        else if (r.status >= 400 && r.status < 500) { refused.add(item.k); remember({ queue: queued().map(i => (i.k === item.k ? { ...i, tries: (Number(i.tries) || 0) + 1 } : i)) }); }
        else break;
      }
      return last;
    })().finally(() => { flushing = null; });
    return flushing;
  }

  // ---- the sign-in door (amendment f) ----
  // The host says which of publik's screens is on the glass, which button was
  // pressed, and when the door let the person through. Counts only: the install
  // id and a name, never anything publik knows.
  // new or update, decided once: was a different version here before this one.
  function cohort() {
    const s = st();
    if (!COHORTS.includes(s.cohort)) remember({ cohort: s.lastVersion && String(s.lastVersion) !== String(o.appVersion || '') ? 'update' : 'new' });
    return st().cohort;
  }
  function gateScreen(screen) {
    if (!GATE_SCREENS.includes(screen)) return none();
    const t = now();
    if (!gate) gate = { shownAt: t, signShownAt: 0, shown: false, clicked: false, unreachable: false };
    gate.screen = screen;
    // The mark a killed process leaves behind, so the next launch can say it closed.
    remember({ gate: { screen, shownAt: gate.shownAt, at: t } });
    if (screen === 'choose') return signedIn();
    if (screen === 'unreachable') { if (gate.unreachable) return none(); gate.unreachable = true; return durable('signin_unreachable'); }
    if (gate.shown) return none();
    gate.shown = true; gate.signShownAt = t;
    return durable('signin_shown', { cohort: cohort() });
  }
  function gatePress(action) {
    if (action !== 'sign_in' || !gate || gate.clicked) return none();
    gate.clicked = true;
    return durable('signin_clicked');
  }
  // Signed in to publik: once per install. seconds only when the window was up.
  function signedIn() {
    if (st().signinDone || !enabled()) return none();
    remember({ signinDone: true });
    const seconds = gate && gate.signShownAt ? Math.max(0, Math.round((now() - gate.signShownAt) / 1000)) : null;
    return durable('signin', { method: 'publik', ...(seconds != null ? { seconds } : {}) });
  }
  // Who answers: sent when it is first known, and again only when it changes.
  function aiSource(p) {
    if (!AI_SOURCES.includes(p) || st().aiSource === p || !enabled()) return none();
    remember({ aiSource: p });
    return durable('ai_source', { path: p });
  }
  // The door let the person through.
  function gatePassed(choice) {
    const a = signedIn();
    gate = null;
    if (st().gate) remember({ gate: null });
    return Promise.all([a, aiSource(choice)]).then(rs => rs[0]);
  }
  // The window was closed, or the app quit, with the door still shut.
  function gateClosed() {
    const g = st().gate;
    if (!g) return none();
    gate = null;
    remember({ gate: null });
    return durable('signin_closed', { screen: GATE_SCREENS.includes(g.screen) ? g.screen : 'sign_in', seconds: Math.max(0, Math.round((now() - (Number(g.shownAt) || now())) / 1000)) });
  }

  // Once per boot: install on the very first run, then this process's app_open,
  // then a 15 minute check so a Companion left in the tray says hello once a day.
  // The host calls this BEFORE the sign-in door (amendment f), so an install
  // that never gets through is still an install.
  async function boot(opts = {}) {
    const s = st();
    nudgeGroup();
    cohort();
    // The last process ended with the door still shut and never said so (it was
    // killed, or the PC went down): say it now, up to the last screen it showed.
    if (s.gate && !gate) {
      remember({ gate: null });
      durable('signin_closed', { screen: GATE_SCREENS.includes(s.gate.screen) ? s.gate.screen : 'sign_in', seconds: Math.max(0, Math.round(((Number(s.gate.at) || 0) - (Number(s.gate.shownAt) || 0)) / 1000)) });
    } else flush();
    // The clock first_run_end reads from: the first launch on this install.
    if (!s.firstLaunchAt) remember({ firstLaunchAt: now() });
    if (!s.installed) {
      const r = await track('install');
      // Settled only by an answer from the server (204, 400, 429). A network
      // miss, or stats being off, leaves the flag down so the first launch that
      // can send is the one that says install; until then no id exists at all.
      if (r.sent) remember({ installed: true });
    }
    // A different version than last launch: the update took. The previous
    // version string is the only thing that travels.
    const version = String(o.appVersion || '');
    if (s.lastVersion && version && s.lastVersion !== version) await track('update_installed', { from: String(s.lastVersion).slice(0, 40), ...(s.oneClickFor === version ? { via: 'oneclick' } : {}) });
    if (s.oneClickFor) remember({ oneClickFor: null });
    if (version && s.lastVersion !== version) remember({ lastVersion: version });
    // The one-click installer restarted us onto this version: a relaunch, not a person.
    const relaunched = !!s.oneClickFor && s.oneClickFor === version;
    await open(relaunched ? 'relaunch' : VIAS.includes(opts.via) ? opts.via : 'manual');
    if (!dayTimer) { dayTimer = timers.setInterval(() => { tick(); }, DAY_CHECK_MS); if (dayTimer && typeof dayTimer.unref === 'function') dayTimer.unref(); }
    if (!minuteTimer) { minuteTimer = timers.setInterval(() => { minute(); }, MINUTE_MS); if (minuteTimer && typeof minuteTimer.unref === 'function') minuteTimer.unref(); }
  }
  async function open(via) {
    const day = utcDay(now());
    lastOpenDay = day;
    // A first ask that never reached the server (offline at the time) is
    // tried again by the next ask, so nothing to do here; first_run_end and
    // the steps retry the same way, at their own next trigger.
    // The day check's hello carries no via: nothing was launched.
    const r = await track('app_open', { ...(via ? { via } : {}), nudge_group: nudgeGroup() });
    // No answer from the server (a lid just opened and Wi-Fi is not back, a
    // start at sign-in before the network): today's hello is still owed. Until
    // 0.1.29 the day was marked done here and never said again, so such a day
    // read as "the app was not running". Asked again shortly, then at each day
    // check, with the same via.
    if (r.sent || !enabled()) openOwed = null;
    else { openOwed = { day, via }; retrySoon(); }
    return r;
  }
  // One short timer after a miss: the network is usually back within seconds,
  // and a short session can end before the 15 minute check comes round.
  function retrySoon() {
    if (retryTimer) return;
    retryTimer = timers.setTimeout(() => { retryTimer = null; tick(); }, RETRY_MS);
    if (retryTimer && typeof retryTimer.unref === 'function') retryTimer.unref();
  }
  // A new UTC day: report the minutes so far under the old day, then say hello.
  // The same day: only what is still owed (a hello or an engaged that got no answer).
  async function tick() {
    const day = utcDay(now());
    if (day !== lastOpenDay) { await flushSession(); const r = await open(); owedEngaged(day); return r; }
    owedEngaged(day);
    if (openOwed && openOwed.day === day) return open(openOwed.via);
    return { sent: false, status: 0 };
  }
  function minute() {
    let idle = 0;
    try { idle = typeof o.idleSeconds === 'function' ? Number(o.idleSeconds()) || 0 : 0; } catch { idle = 0; }
    if (idle < IDLE_LIMIT_S) activeMinutes += 1;
  }
  // One app_session for the active minutes so far, then the counter restarts.
  // Under a minute is nothing to report.
  function flushSession() {
    const minutes = activeMinutes;
    activeMinutes = 0;
    if (minutes < 1) return Promise.resolve({ sent: false, status: 0 });
    return track('app_session', { minutes });
  }

  // An answered ask: the mode it came in, the feature that answered, how it
  // ended. first_ask is marked done only once the server took it, so an
  // offline first ask is the next ask that can send; one at a time, so two
  // quick asks cannot both be the first.
  function ask(mode, feature, outcome) {
    const props = { mode: MODES.includes(mode) ? mode : 'text', outcome: OUTCOMES.includes(outcome) ? outcome : 'ok' };
    if (FEATURES.includes(feature)) props.feature = feature;
    // Launch to first ask, kept on this computer only (stats-state.json beside
    // firstLaunchAt), whether or not stats are on. Nothing new is sent: the
    // server reads the same gap from the install and first_ask rows.
    if (!st().firstAskAt && !st().firstAskSent) { const at = now(); remember({ firstAskAt: at, ...(st().firstLaunchAt ? { firstAskSeconds: Math.max(0, Math.round((at - st().firstLaunchAt) / 100) / 10) } : {}) }); }
    if (!st().firstAskSent && !firstAskInFlight) {
      firstAskInFlight = true;
      return track('first_ask', props).then(r => { firstAskInFlight = false; if (r.sent) remember({ firstAskSent: true }); return r; });
    }
    return track('ask', props);
  }
  // A dictation (Ctrl + Win): an ask row under its own feature name, spoken. It
  // is never a first ask and never a first win, so the ladder's activation rungs
  // mean what they meant before 0.1.37 in both halves of the test. The host
  // marks the day engaged on its own (a dictation is a real use).
  function dictation(outcome) {
    return track('ask', { mode: 'voice', feature: 'dictation', outcome: OUTCOMES.includes(outcome) ? outcome : 'ok' });
  }
  // The first win: the first task that really worked (the host calls this
  // only once the guide pointed, an answer finished, a reminder was set...),
  // never a hello. Its time is kept on this computer whatever stats say (My
  // Nus reads it); first_win goes out once, marked done only after the server took it.
  function win(feature) {
    if (!FEATURES.includes(feature) || feature === 'greeting') return Promise.resolve({ sent: false, status: 0 });
    if (!st().firstWinAt) remember({ firstWinAt: now(), firstWinFeature: feature });
    if (st().firstWinSent || firstWinInFlight) return Promise.resolve({ sent: false, status: 0 });
    firstWinInFlight = true;
    return track('first_win', { feature }).then(r => { firstWinInFlight = false; if (r.sent) remember({ firstWinSent: true }); return r; });
  }
  // The person did something with Nus today (an ask, the talk key, the tray,
  // the dashboard): once per UTC day. Unlike app_open, a Knot left running and
  // untouched never says this. One at a time. A miss (no answer from the
  // server) is owed: the next action or the day check says it, at most once a
  // minute. Until 0.1.29 a miss used up the day's one try, so a first action
  // made offline lost the whole day.
  function engaged() {
    const day = utcDay(now());
    if (st().engagedDay === day || engagedInFlight || !enabled()) return Promise.resolve({ sent: false, status: 0 });
    if (engagedOwed === day && now() - engagedTriedAt < ENGAGED_RETRY_MS) return Promise.resolve({ sent: false, status: 0 });
    engagedInFlight = true;
    engagedTriedAt = now();
    return track('engaged').then(r => {
      engagedInFlight = false;
      if (r.sent) { engagedOwed = ''; remember({ engagedDay: day }); } else { engagedOwed = day; retrySoon(); }
      return r;
    });
  }
  // The day check's part: an engaged that got no answer today is said again.
  // Never on its own: only a day the person really acted on is owed.
  function owedEngaged(day) { if (engagedOwed === day) engaged(); else if (engagedOwed) engagedOwed = ''; }
  // How answers are possible here, once per install.
  function aiReady(p) {
    if (!AI_PATHS.includes(p) || st().aiReadySent) return Promise.resolve({ sent: false, status: 0 });
    // publik is new to the server's list (amendment f): it waits in the queue until taken.
    if (p === 'publik') { if (!enabled()) return none(); remember({ aiReadySent: true }); return durable('ai_ready', { path: p }); }
    return track('ai_ready', { path: p }).then(r => { if (r.sent) remember({ aiReadySent: true }); return r; });
  }
  // A retention loop put in front of the person, or taken up. Counts only.
  // The contact card's rows are new to the server's list (amendment f), so they wait in the queue.
  function hook(name, h) { return !HOOKS.includes(h) ? none() : h.startsWith('contact_') ? durable(name, { hook: h }) : track(name, { hook: h }); }
  const hookShown = h => hook('hook_shown', h);
  const hookUsed = h => hook('hook_used', h);
  // A long-running mode started: the stopper sends feature_session with the
  // seconds it ran, once. With `seconds` given (the host already timed it,
  // as with a voice capture) the row goes out at once.
  function featureSession(feature, seconds) {
    const none = () => Promise.resolve({ sent: false, status: 0 });
    if (!FEATURES.includes(feature)) return seconds != null ? none() : none;
    if (seconds != null) { const n = Math.round(Number(seconds)); return n >= 1 ? track('feature_session', { feature, seconds: n }) : none(); }
    const startedAt = now();
    let done = false;
    const stop = () => {
      if (done) return none();
      done = true;
      openFeatures.delete(stop);
      const n = Math.round((now() - startedAt) / 1000);
      return n >= 1 ? track('feature_session', { feature, seconds: n }) : none();
    };
    openFeatures.add(stop);
    return stop;
  }
  // The first-run steps, each once per install, marked done only after a 204.
  function onboardingStep(step, extra) {
    if (!STEPS.includes(step)) return Promise.resolve({ sent: false, status: 0 });
    const more = step === 'struggle_picked' && extra && STRUGGLES.includes(extra.struggle) ? { struggle: extra.struggle } : {};
    const steps = st().steps || {};
    // Once per install, and one try per process: a miss is retried the next
    // time the step is reached in a later launch.
    if (steps[step] || stepsTried.has(step)) return Promise.resolve({ sent: false, status: 0 });
    stepsTried.add(step);
    remember({ lastStep: step });
    return track('onboarding_step', { step, ...more }).then(r => { if (r.sent) remember({ steps: { ...(st().steps || {}), [step]: true } }); return r; });
  }
  // Quit before any ask ever: how far the first run got and how long since the
  // first launch. Once per install.
  function firstRunEnd() {
    const s = st();
    if (s.firstAskSent || s.firstRunEnded) return Promise.resolve({ sent: false, status: 0 });
    const props = { seconds: Math.max(0, Math.round((now() - (s.firstLaunchAt || now())) / 1000)) };
    if (STEPS.includes(s.lastStep)) props.step = s.lastStep;
    return track('first_run_end', props).then(r => { if (r.sent) remember({ firstRunEnded: true }); return r; });
  }
  // A crash happened. A count, nothing about it, and a few per process at most.
  function crash() {
    if (crashesSent >= CRASHES_PER_PROCESS) return Promise.resolve({ sent: false, status: 0 });
    crashesSent += 1;
    return track('crash');
  }
  function keyConnected(provider) {
    onboardingStep('key_connected');
    return track('key_connected', { provider: String(provider || '').slice(0, 40) });
  }
  function sourceAnswer(source) {
    const s = SOURCES.includes(source) ? source : 'skipped';
    remember({ sourceAnswered: true });
    return track('source_answer', { source: s });
  }
  // A new version put in front of the person: once per version per surface,
  // remembered here so a dashboard repainting does not count twice.
  function updateOffered(surface, version) {
    const v = String(version || '').slice(0, 40);
    if (!SURFACES.includes(surface) || !v) return Promise.resolve({ sent: false, status: 0 });
    const seen = st().offered || {};
    if (seen[surface] === v) return Promise.resolve({ sent: false, status: 0 });
    remember({ offered: { ...seen, [surface]: v } });
    return track('update_offered', { surface });
  }
  function noticeEvent(name, id) { return NOTICE_ID.test(String(id || '')) ? track(name, { notice: String(id) }) : Promise.resolve({ sent: false, status: 0 }); }
  const noticeShown = id => noticeEvent('notice_shown', id);
  const noticeClicked = id => noticeEvent('notice_clicked', id);
  // The one-click installer is about to run for this version: the next launch on
  // it reports update_installed with via oneclick.
  function noteOneClick(version) { remember({ oneClickFor: String(version || '').slice(0, 40) }); }

  // Off: say goodbye once while still allowed to, then flip the switch. On: flip
  // it. track() reads the switch before its first await, so the flag can turn
  // at once and the caller sees the new state synchronously.
  function setEnabled(value) {
    const want = value !== false;
    let last = Promise.resolve();
    if (!want && switchedOn()) { last = track('stats_off'); o.settings.set({ sendStats: false }); if (queued().length) remember({ queue: [] }); }
    else if (want && !switchedOn()) o.settings.set({ sendStats: true });
    return last.then(status);
  }
  function status() { return { enabled: switchedOn(), active: enabled(), firstRun: !st().sourceAnswered, asked: !!st().firstAskSent, firstAskSeconds: Number.isFinite(st().firstAskSeconds) ? st().firstAskSeconds : null, lastStep: st().lastStep || null, notice: NOTICE, dev,
    firstWinAt: st().firstWinAt || null, firstWinFeature: st().firstWinFeature || null, nudgeGroup: nudgeGroup(),
    cohort: COHORTS.includes(st().cohort) ? st().cohort : null, signedIn: !!st().signinDone, aiSource: st().aiSource || null, waiting: queued().length }; }
  // Quit: stop the clocks, close the open feature timers, send the session's
  // minutes and, on a first run that never asked, first_run_end. Resolves
  // within about a second whatever the network does, so the host can wait.
  // The exit row is written to disk before the send (durable), so a quit with no
  // network is told at the next start. Once per run.
  let exitNoted = false;
  function exit(reason) {
    if (exitNoted) return none();
    exitNoted = true;
    return durable('app_exit', { reason: EXIT_REASONS.includes(reason) ? reason : 'other' });
  }
  function stop(reason) {
    if (dayTimer) { timers.clearInterval(dayTimer); dayTimer = null; }
    if (minuteTimer) { timers.clearInterval(minuteTimer); minuteTimer = null; }
    if (retryTimer) { timers.clearTimeout(retryTimer); retryTimer = null; }
    const settle = new Promise(resolve => { const t = setTimeout(resolve, 1200, { sent: false, status: 0 }); if (t && typeof t.unref === 'function') t.unref(); });
    const sends = [...openFeatures].map(stopper => stopper());
    // Quit with the sign-in door still shut: that is signin_closed, written to
    // disk before the send so a slow network cannot lose it. first_run_end
    // keeps its meaning (a first run that got in and never asked), so it waits.
    if (reason) sends.push(exit(reason));
    sends.push(flushSession(), st().gate ? gateClosed() : firstRunEnd());
    return Promise.race([Promise.all(sends).then(rs => rs[rs.length - 2]), settle]);
  }

  return { track, boot, tick, minute, flushSession, activeMinutes: () => activeMinutes, ask, dictation, featureSession, onboardingStep, firstRunEnd, crash,
    keyConnected, sourceAnswer, setEnabled, status, stop, exit, installId: id, enabled, dev: () => dev, updateOffered, noticeShown, noticeClicked, noteOneClick,
    win, engaged, aiReady, hookShown, hookUsed, nudgeGroup,
    gateScreen, gatePress, gatePassed, gateClosed, aiSource, cohort, flush, queued: () => queued().slice() };
}

module.exports = { createStats, TRACK_URL, EVENTS, PROP_KEYS, SOURCES, MODES, FEATURES, OUTCOMES, STEPS, EXIT_REASONS, SURFACES, NOTICE_ID, NOTICE, IDLE_LIMIT_S, DEV_FILE, utcDay,
  HOOKS, AI_PATHS, STRUGGLES, VIAS, NUDGE_HOLDOUT, COHORTS, GATE_SCREENS, AI_SOURCES, QUEUE_MAX, QUEUE_MAX_AGE_MS, QUEUE_MAX_TRIES };
