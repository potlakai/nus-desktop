'use strict';
// The Companion's window for Publik's sign-in gate (publik.js ensureSignedIn). Publik's own
// titles, words and button labels are drawn exactly as the module gives them. Around them go
// Nūs's own lines: what is about to happen, that it is free to start, that publik's plans page
// can be skipped, and, once signed in, what the person got for free.
//
// What this window does that the bare module does not, and none of it skips the gate:
// - When publik does not answer at start (Windows sign-in often beats Wi-Fi), it answers Retry by
//   itself every 5 seconds for up to 60 seconds before it shows "publik is not reachable". The
//   module still decides; this only waits before drawing the same screen.
//   Only when publik gave no answer. When publik answered with a reason, its screen is drawn at
//   once, in publik's own words. (On 2026-11-21 publik answered every new computer "This app has
//   reached its daily provisioning cap"; a new person saw nothing for a minute, started Nūs again,
//   and that second start ended the first one: main-companion.js, second-instance. 0.1.34 gave that
//   answer its own "Full for today" screen; publik removed the cap the same day, so the screen is
//   gone again.)
// - Starting Nūs again while this window is up brings it to the front (front()).
// - Closing the window quits the Companion: there is no way past the gate but signing in.
// - The moment the module sees the sign-in in the browser (it polls every 3 seconds), the window
//   comes back to the front: restored, on top, focused if Windows allows it, and its taskbar
//   button flashing if not. It stays on top until the person touches it.
const path = require('path');
// Electron is loaded when the window is made, so the words below can be tested in plain Node.

const QUIET_RETRY_MS = 60_000, QUIET_STEP_MS = 5_000;

// Measured 2026-11-11 (conditor/publik-setup/README.md): a screen ask on publik-fast costs about
// $0.00043, so the free $0.05 is about 117 screen asks. Plain asks cost less. A guess for any
// other balance, rounded down so the window never promises more than it gives.
// From 0.1.22 the window never shows an amount of money (publik's rule, developers page read
// 2026-11-15): the balance is only ever said as a number of asks.
const SCREEN_ASK_USD = 0.00043;
// 0.1.39: publik gives every new Nūs account $0.20 once at its first sign-in (2026-11-21). Until now a
// new account read "About 450 asks on your publik balance" with "Starts Nūs." under Connect your plan,
// which reads like paying; a third of new installs picked their own key instead. A balance up to the
// grant is the free start: "for free. Nothing to buy." and "Free. Starts Nūs."
const FREE_START_USD = 0.20;

// The words, short and large (Pranav, 2026-11-11: "increase the font and the readability and make
// it concise"). He picked A, with his own line, and then: the "no plan needed" message must not be
// small print; it names publik's plan, in big clear type, right on the sign-in screen ("make it clear
// that they don't need to buy PUBLIK's plan right there"), and again while they are in the browser,
// which is when publik's plan page is in front of them.
// Every screen: a headline, one line, the plan line (callout), the three steps (strip), one big button.
// WORDING_PICK chooses the first screen's line: A is his wording, A2 his other phrasing to compare.
const PLAN_LINE = 'You do not need to buy publik\'s plan.';
const STEPS = ['Sign in', 'Skip publik\'s plan', 'Back to Nūs'];
const WORDING = {
  A: { headline: 'Free to start', line: 'About 100 asks for free, no card. Sign in to get started.', callout: PLAN_LINE },
  A2: { headline: 'Free to start', line: 'About 100 asks for free, no card. Sign in to get your free asks.', callout: PLAN_LINE },
};
const WORDING_PICK = 'A';

const UPDATING = 'Updating? Everything you set up is still here. To keep your own key, pick Use my own key after you sign in.';
const WAITING = { headline: 'Finish in your browser', line: 'Nūs comes back by itself once you\'re signed in.', callout: 'publik will show you a plan. You do not need to buy it.' };
const CHOICE_LINE = 'With publik, your question and a picture of your screen go to publik\'s AI to answer. With your own key they go to your AI company, as before. Voice commands, reminders and your notes stay on this computer either way.';
const NO_BALANCE_LINE = 'This publik account\'s free asks are used up.';
// 0.1.40: "Use my own key" pressed while publik has free use for this account and no key is saved on
// this computer. A third of new installs picked their own key and a third of those never got an answer
// (read 2026-11-24, conditor/own-key-0140). Our lines only; the two buttons keep publik's own labels.
const NO_KEY = { headline: 'No AI key on this computer yet', line: 'publik\'s free asks answer right now. You can switch to your own key any time, in Settings.' };
const NO_KEY_CAPTIONS = { connect: 'Free. Starts Nūs.', own_key: 'Only if you have a key or Claude Code' };
// publik's own offer (pricing page, read 2026-11-15): a 7-day free trial of its Basic plan for new
// subscribers, with a card, paid when the week ends. Said in full so nobody is surprised by a charge.
const FREE_WEEK_LINE = 'publik gives new subscribers a free week. It needs a card, and it is paid after the week unless you cancel.';
const FREE_WEEK_CAPTION = 'Free week, then paid';
// Kept for anything that still reads them.
const INTRO = WORDING[WORDING_PICK].line;
const WAITING_LINES = [WAITING.headline, WAITING.line, WAITING.callout];
const NO_BALANCE_LINES = [NO_BALANCE_LINE];

// publik's own sentence when it could not be reached at all (publik.js gateScreen). Any other body
// on that screen is an answer publik gave, and is never waited on.
const NOT_REACHABLE = 'publik is not reachable. Check your connection.';
// Pure: publik gave no answer (offline, a timeout). Only this is retried quietly before it is drawn.
function noAnswer(screen) { return !!screen && screen.id === 'unreachable' && (!screen.body || String(screen.body) === NOT_REACHABLE); }

// Pure: the name Nūs's own anonymous stats use for one of the module's screens (stats.js,
// GATE_SCREENS). sign_in becomes waiting once the browser was opened. Exported for tests.
function statScreen(screen) {
  if (!screen || typeof screen.id !== 'string') return '';
  if (screen.id === 'sign_in') return /^Waiting/.test(String(screen.note || '')) ? 'waiting' : 'sign_in';
  return screen.id === 'choose' || screen.id === 'unreachable' ? screen.id : '';
}

// Pure: what the module's own words on the plan screen say. -> { kind: 'balance'|'plan'|'none', usd, plan }
// usd is null when the module does not say the amount (publik's module from 2026-11 says only
// "You have publik use ready."); the window then promises no number of asks.
function readPlan(screen) {
  const body = String((screen && screen.body) || '');
  const plan = /Your plan: ([^.]*)\./.exec(body);
  if (plan) return { kind: 'plan', usd: 0, plan: plan[1] };
  const bal = /Your balance: \$([0-9]+(?:\.[0-9]+)?)\./.exec(body);
  if (bal) return { kind: Number(bal[1]) > 0 ? 'balance' : 'none', usd: Number(bal[1]), plan: '' };
  if (/You have publik use ready\./.test(body)) return { kind: 'balance', usd: null, plan: '' };
  return { kind: 'none', usd: 0, plan: '' };
}

// Pure: "about 100 asks" for a balance, rounded down; '' when it buys less than one.
function asksFor(usd) {
  const n = Math.floor((Number(usd) || 0) / SCREEN_ASK_USD);
  if (n < 1) return '';
  if (n >= 1000) return 'plenty of asks';
  if (n < 10) return n === 1 ? 'about 1 ask' : 'about ' + n + ' asks';
  const step = n >= 100 ? 50 : 10;
  return 'about ' + Math.floor(n / step) * step + ' asks';
}

// Pure: what the window shows for one of the module's screens. Exported for tests.
// -> { state, title, windowTitle, headline, line, callout, steps, step, small, updating, footnote, note, privacy, nus, buttons }
// state: sign_in, waiting, in (signed in with free use, a balance or a plan), no_balance, unreachable.
// title, footnote (Publik's body) and the button labels are Publik's words, untouched; the rest
// (headline, line, small, `primary`, `small`, `caption`) is ours.
function view(screen, opts = {}) {
  // Publik's body sentence repeats what our lines now say, and the SDK's table of the gate's fixed
  // words lists only titles and button labels, so it is not drawn (README, onboard-0120, section 6).
  const out = { state: '', title: screen.title, windowTitle: screen.title, headline: '', line: '', callout: '', steps: [], step: 0, small: '', updating: '', footnote: '', note: screen.note || '', privacy: '', nus: [],
    buttons: screen.buttons.map((b, i) => ({ action: b.action, label: b.label, primary: i === 0, small: false, caption: '' })) };
  out.body = screen.body;
  const put = (w) => { out.headline = w.headline; out.line = w.line; out.callout = w.callout || ''; out.small = w.small || ''; };
  if (screen.id === 'sign_in') {
    const waiting = statScreen(screen) === 'waiting';
    out.state = waiting ? 'waiting' : 'sign_in';
    put(waiting ? WAITING : (WORDING[opts.wording] || WORDING[WORDING_PICK]));
    out.steps = STEPS.slice(); out.step = waiting ? 2 : 1;
    // Already pressed: the same button again, quieter, for a browser that never opened.
    for (const b of out.buttons) if (b.action === 'sign_in') { if (waiting) { b.primary = false; b.caption = 'Opens the page again'; } else b.caption = 'Opens your browser'; }
    // Publik's waiting note ("Waiting for you to sign in in your browser.") says what our headline says,
    // with a doubled "in"; it is a note, not one of the gate's fixed words, so it is not drawn while waiting.
    if (waiting) out.note = '';
    if (opts.updating && !waiting) out.updating = UPDATING;
  } else if (screen.id === 'choose') {
    const p = readPlan(screen);
    out.privacy = CHOICE_LINE;
    out.windowTitle = 'Nūs: you\'re in';
    if (opts.confirmOwnKey && p.kind !== 'none') {
      out.state = 'no_key';
      put({ headline: NO_KEY.headline, line: NO_KEY.line, callout: '', small: '' });
      for (const b of out.buttons) {
        if (b.action === 'connect') { b.primary = true; b.small = false; b.caption = NO_KEY_CAPTIONS.connect; }
        if (b.action === 'own_key') { b.primary = false; b.small = true; b.caption = NO_KEY_CAPTIONS.own_key; }
      }
      out.buttons.sort((a, b) => Number(b.primary) - Number(a.primary));
    } else if (p.kind === 'none') {
      out.state = 'no_balance';
      put({ headline: 'You\'re in', line: NO_BALANCE_LINE, callout: FREE_WEEK_LINE, small: '' });
      // No free use left: the own key is the free path, so it leads. The plan button says what
      // publik's free week is; the callout above it names the card and the charge.
      for (const b of out.buttons) {
        if (b.action === 'own_key') { b.primary = true; b.caption = 'A free Gemini key works'; }
        if (b.action === 'get_plan') { b.primary = false; b.caption = FREE_WEEK_CAPTION; }
      }
      out.buttons.sort((a, b) => Number(b.primary) - Number(a.primary));
    } else {
      out.state = 'in';
      const who = /You are signed in as (@[^.\s]+)\./.exec(String(screen.body || ''));
      out.footnote = who ? 'Signed in as ' + who[1] + '.' : '';
      out.steps = STEPS.slice(); out.step = 3;
      // Never an amount of money: the balance is said as asks, or not at all when it is unknown.
      const known = p.usd !== null, asks = known ? asksFor(p.usd) : '', free = known && p.usd <= FREE_START_USD + 1e-9;
      const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
      put({ headline: 'You\'re in', small: '',
        line: p.kind === 'plan' ? 'Your publik plan (' + p.plan + ') answers in Nūs.'
          : free ? (asks ? cap(asks) + ' for free' : 'Free to start') + '. Nothing to buy.'
          : asks ? cap(asks) + ' on your publik balance.' : 'Your publik account is ready to answer in Nūs.' });
      for (const b of out.buttons) {
        if (b.action === 'connect') { b.primary = true; b.caption = p.kind === 'plan' ? 'Uses your plan. Starts Nūs.' : free ? 'Free. Starts Nūs.' : 'Starts Nūs.'; }
        if (b.action === 'own_key') { b.primary = false; b.small = true; }
      }
    }
  } else { out.state = 'unreachable'; out.line = screen.body; out.footnote = ''; }
  out.nus = [out.headline, out.line, out.callout, ...out.steps, out.small, out.updating].filter(Boolean);
  return out;
}

// Pure: whether this screen is the moment to come back to the front. The module moved from the
// sign-in screen (the browser had the person) to the plan screen: the sign-in landed.
function comesForward(prevId, screen) { return prevId === 'sign_in' && !!screen && screen.id === 'choose'; }

function createGateUI(opts = {}) {
  const { BrowserWindow, ipcMain, shell, app } = require('electron');
  const started = Date.now();
  let win = null, shown = false, pending = null, prevId = '', held = false, impatient = false;
  // 0.1.40: the choose screen on the glass, and whether the no-key check was already shown for it.
  let choosing = null, noKeyShown = false;
  const now = opts.now || Date.now;
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const log = (m) => { try { console.log('[gate] ' + m); } catch (_) { /* no console */ } };

  function ensureWindow() {
    if (win && !win.isDestroyed()) return win;
    win = new BrowserWindow({ width: 480, height: 500, resizable: false, minimizable: true, maximizable: false, show: false, title: 'Sign in with publik',
      backgroundColor: '#0b0d12', autoHideMenuBar: true, icon: opts.icon,
      webPreferences: { preload: path.join(__dirname, 'gate-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    win.loadFile(path.join(__dirname, 'gate.html'));
    // No way past the gate but signing in: closing it ends the app.
    win.on('closed', () => { win = null; if (pending) app.quit(); });
    win.on('focus', () => { try { win.flashFrame(false); } catch (_) { /* gone */ } });
    return win;
  }
  // Back to the front after the sign-in landed in the browser. Windows refuses focus to a window
  // whose app did not get the last input (the browser did), so each step is tried: restore, on
  // top, show, focus. If focus was refused, a minimize and restore, then the taskbar button
  // flashes. It stays on top until the person touches it (release()). The log says what held.
  function bringForward(w) {
    try {
      if (w.isMinimized()) w.restore();
      w.setAlwaysOnTop(true); held = true;
      w.show(); w.moveTop(); w.focus();
      if (typeof app.focus === 'function') app.focus({ steal: true });
      w.flashFrame(true);
    } catch (e) { log('front failed: ' + e.message); return; }
    setTimeout(() => {
      if (!w || w.isDestroyed()) return;
      const first = w.isFocused();
      if (!first) { try { w.minimize(); w.restore(); w.focus(); } catch (_) { /* gone */ } }
      setTimeout(() => { if (w && !w.isDestroyed()) log('front: focused ' + first + ' then ' + w.isFocused() + ', on top ' + w.isAlwaysOnTop() + ', visible ' + w.isVisible()); }, 300);
    }, 250);
  }
  function release() {
    if (!held || !win || win.isDestroyed()) return;
    held = false;
    try { win.setAlwaysOnTop(false); win.flashFrame(false); } catch (_) { /* gone */ }
  }
  const onPress = (event, action) => {
    if (!win || event.sender !== win.webContents || !pending) return;
    release();
    // 0.1.40: own key with publik's free use waiting and no key on this computer: one check first,
    // drawn in this window. A second press of the same button goes through as before.
    if (action === 'own_key' && needsNoKeyCheck()) {
      noKeyShown = true;
      tell(opts.onNoKey, true);
      try { win.webContents.send('publik-gate:screen', view(choosing, Object.assign({}, opts, { confirmOwnKey: true }))); } catch (_) { /* gone */ }
      return;
    }
    const p = pending; pending = null;
    if (p.buttons.includes(action)) { tell(opts.onPress, action); p.resolve(action); } else pending = p;
  };
  function needsNoKeyCheck() {
    if (!choosing || noKeyShown || typeof opts.hasOwnAnswer !== 'function') return false;
    if (readPlan(choosing).kind === 'none') return false;
    try { return !opts.hasOwnAnswer(); } catch (_) { return false; }
  }
  const onTouch = (event) => { if (win && event.sender === win.webContents) release(); };
  // Nūs's own anonymous counts (opts.onScreen, opts.onPress): which screen is up and which
  // button was pressed. Nothing from publik travels with them, and they never hold the gate up.
  function tell(fn, value) { if (typeof fn === 'function' && value) { try { fn(value); } catch (_) { /* counting never breaks the gate */ } } }
  ipcMain.on('publik-gate:press', onPress);
  ipcMain.on('publik-gate:touch', onTouch);

  return {
    async show(screen, signal) {
      if (noAnswer(screen) && !shown && !impatient && now() - started < QUIET_RETRY_MS) {
        await sleep(QUIET_STEP_MS);
        if (signal && signal.aborted) return new Promise(() => {});
        return 'retry';
      }
      const w = ensureWindow();
      tell(opts.onScreen, statScreen(screen));
      // 0.1.40: which kind of choose screen this account got: free use or a balance, a plan, or none left.
      if (screen.id === 'choose') { if (!choosing) tell(opts.onPlan, readPlan(screen).kind); choosing = screen; } else choosing = null;
      const forward = comesForward(prevId, screen);
      prevId = screen.id;
      // Came forward by itself: no button is focused and keys are ignored for a moment, so a key
      // meant for the browser cannot press Connect (walk 2026-11-11: it was pressed 2 s after it came up).
      const draw = () => { try { w.webContents.send('publik-gate:screen', Object.assign(view(screen, opts), forward ? { cameForward: true } : {})); } catch (_) {} };
      if (w.webContents.isLoading()) w.webContents.once('did-finish-load', draw); else draw();
      if (!shown) { w.once('ready-to-show', () => w.show()); if (!w.webContents.isLoading()) w.show(); shown = true; }
      if (forward) bringForward(w);
      return new Promise((resolve) => {
        pending = { resolve, buttons: screen.buttons.map((b) => b.action) };
        if (signal) signal.addEventListener('abort', () => { if (pending && pending.resolve === resolve) pending = null; }, { once: true });
      });
    },
    openUrl(url) { if (/^https:\/\//i.test(String(url))) shell.openExternal(String(url)); },
    // The person started Nūs again while the gate is up. A window that is up comes to the front;
    // with none yet (the quiet retries), the next screen is drawn without waiting any longer.
    front() {
      if (win && !win.isDestroyed() && shown) { bringForward(win); return true; }
      impatient = true; return false;
    },
    // The gate is passed: close the window without quitting.
    close() { pending = null; ipcMain.removeListener('publik-gate:press', onPress); ipcMain.removeListener('publik-gate:touch', onTouch); if (win && !win.isDestroyed()) win.destroy(); win = null; },
  };
}

module.exports = { NO_KEY, NO_KEY_CAPTIONS, createGateUI, view, statScreen, readPlan, asksFor, comesForward, noAnswer, NOT_REACHABLE, WORDING, WORDING_PICK, PLAN_LINE, STEPS, INTRO, UPDATING, WAITING, CHOICE_LINE, NO_BALANCE_LINE, FREE_WEEK_LINE, FREE_WEEK_CAPTION, WAITING_LINES, NO_BALANCE_LINES };
