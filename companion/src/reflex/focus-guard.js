// The focus guard: "keep me off Reels for 20 minutes" (or "until I close
// Word"). While it is on, a browser window whose title names a feed is brought
// to the front and its tab closed with Ctrl+W, and the Knot says what it did.
// When the condition ends it says so, and "ok let me back" reopens the feed it
// last closed. While it is on, nothing Nūs opens goes back to a guarded site: the
// reflex layer, Hands and the task system ask refuse() or refuseAsk() first.
//
// Rules, all enforced here and tested:
//   it only ever closes a TAB in a BROWSER whose title matches a feed word,
//   it says something every time it acts, it stops on one switch, and it runs
//   only after the person asked for it. Nothing here blocks the network or
//   closes an application.
//
// Electron-free so it runs under node --test: the host passes the probe (reads
// the foreground window), the hands (activates a window, presses the chord), a
// feed list accessor and a clock.
'use strict';

const { BROWSERS, VK } = require('./executor');

const DEFAULT_FEEDS = ['Instagram', 'Reels', 'TikTok', 'Shorts'];
// Where a closed feed tab lived, by the feed word its title carried. A browser
// title never holds the URL, so this is the honest way back: the feed's home.
const FEED_URLS = {
  instagram: 'https://www.instagram.com/',
  reels: 'https://www.instagram.com/reels/',
  tiktok: 'https://www.tiktok.com/',
  shorts: 'https://www.youtube.com/shorts/',
  x: 'https://x.com/'
};
// A feed word means its site: Reels are Instagram (live 2026-11-03: "keep me off
// reels" guarded the word alone, and Instagram's own title does not carry it).
// words: how people say it. hosts and paths: the addresses that are it. The X
// page's title is not a word to match in any title, so it has a rule of its own.
const SITES = [
  { name: 'Instagram', feeds: ['Instagram', 'Reels'], words: ['instagram', 'insta', 'ig', 'reels', 'reel'], hosts: ['instagram.com'] },
  { name: 'YouTube Shorts', feeds: ['Shorts'], words: ['youtube shorts', 'shorts', 'short'], paths: [['youtube.com', '/shorts']] },
  { name: 'TikTok', feeds: ['TikTok'], words: ['tiktok', 'tik tok', 'ticktock', 'tick tock'], hosts: ['tiktok.com'] },
  { name: 'X', feeds: ['X'], words: ['twitter', 'x', 'x dot com'], hosts: ['x.com', 'twitter.com'], title: /\/ X(?:\s*[-20132014|].*)?$|\bon X: |\bTwitter\b/ }
];
const siteOfWord = (w) => SITES.find((s) => s.words.includes(String(w || '').toLowerCase())) || null;
const siteOfFeed = (f) => SITES.find((s) => s.feeds.some((x) => x.toLowerCase() === String(f || '').toLowerCase())) || null;
const EVERYTHING = /^(?:(?:all |every )?(?:social media|socials|feeds|the feeds|everything|all of it|all of them))$/i;

const DEFAULT_MINUTES = 20;
const MAX_MINUTES = 480;
const POLL_MS = 1000;
const CLOSE_COOLDOWN_MS = 1500;
// "Let me back" after the condition ended still reopens the tab, for a while.
const BACK_WINDOW_MS = 10 * 60 * 1000;

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function normalizeFeeds(list) {
  const src = Array.isArray(list) ? list : typeof list === 'string' ? list.split(/[,\n;]+/) : null;
  if (!src) return DEFAULT_FEEDS.slice();
  const out = [];
  for (const raw of src) {
    const f = String(raw == null ? '' : raw).trim().replace(/\s+/g, ' ').slice(0, 40);
    if (!f || out.some((x) => x.toLowerCase() === f.toLowerCase())) continue;
    out.push(f);
    if (out.length >= 20) break;
  }
  return out;
}

// chrome.exe, msedge.exe, firefox.exe ...: the same list the executor opens
// sites in. A feed title in any other process (a text editor with "Reels" in
// a file name) is never touched.
function isBrowserProcess(processName) {
  const p = String(processName || '').replace(/\.exe$/i, '');
  return !!p && BROWSERS.some(([re]) => re.test(p));
}

// The feed word the title carries, as configured, or null. Whole word, any case.
function matchFeed(title, feeds) {
  const t = String(title || '');
  if (!t) return null;
  for (const f of normalizeFeeds(feeds || DEFAULT_FEEDS)) {
    const site = siteOfFeed(f);
    if (site && site.title) { if (site.title.test(t)) return f; continue; }
    if (new RegExp('(?:^|[^a-z0-9])' + esc(f) + '(?![a-z0-9])', 'i').test(t)) return f;
  }
  return null;
}

// Pure. True only for a browser window whose title names a feed.
function shouldClose(title, processName, feeds) {
  return isBrowserProcess(processName) && matchFeed(title, feeds) !== null;
}

// ---- the spoken or typed command -------------------------------------------
const NUMBER_WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, ninety: 90 };
function numberOf(text) {
  const t = String(text || '').trim().toLowerCase();
  if (/^\d+(?:\.\d+)?$/.test(t)) return Number(t);
  if (t === 'half') return 0.5;
  let total = 0, any = false;
  for (const w of t.split(/[\s-]+/)) {
    if (NUMBER_WORDS[w] == null) return null;
    total += NUMBER_WORDS[w]; any = true;
  }
  return any ? total : null;
}

// "20 minutes", "twenty min", "an hour", "half an hour", "the next 15 minutes", "1.5 hours"
function parseDuration(text) {
  const t = String(text || '').toLowerCase().replace(/^(?:the next|the following|another|about|like|around)\s+/, '').trim();
  const half = /^half an hour$|^half hour$|^thirty min/.test(t);
  if (half) return 30;
  const m = /^((?:[a-z]+(?:[\s-][a-z]+)?)|\d+(?:\.\d+)?)\s*(minutes?|mins?|m|hours?|hrs?|h)$/.exec(t);
  if (!m) return null;
  const n = numberOf(m[1]);
  if (n == null || !(n > 0)) return null;
  const minutes = /^h/.test(m[2]) ? n * 60 : n;
  return Math.min(MAX_MINUTES, Math.max(1, Math.round(minutes)));
}

// "until I close Word", "till I'm done with the essay in Word", "until Word is closed"
function parseUntil(text) {
  let t = String(text || '').trim().replace(/[.!?]+$/, '');
  t = t.replace(/^(?:i|i've|i have|i'm|i am|we)\s+(?:close|closed|shut|quit|exit|finish(?:ed)?(?: with| in)?|(?:am |are )?done(?: with| in)?)\s+/i, '');
  t = t.replace(/\s+(?:is|gets|has been)\s+(?:closed|shut|done|finished)$/i, '');
  t = t.replace(/^(?:the|my)\s+/i, '').trim();
  if (!/^[a-z0-9][a-z0-9 .+-]{1,30}$/i.test(t)) return null;
  return t;
}

// Which feeds a phrase names. "reels and tiktok", "instagram", "social media"
// (= all of them). A known site counts whether or not Settings lists it; any other
// word is read against the list. Unknown words make the whole phrase unknown, so
// "no thanks" is never a guard.
function feedsNamed(phrase, feeds) {
  const list = normalizeFeeds(feeds || DEFAULT_FEEDS);
  const p = String(phrase || '').toLowerCase().replace(/[.!?,]+$/, '').trim();
  if (!p) return null;
  if (EVERYTHING.test(p)) return list.slice();
  const out = [];
  for (let part of p.split(/\s*(?:,|\band\b|\bor\b|\bplus\b)\s*/)) {
    part = part.replace(/^(?:the|my|any|all)\s+/, '').trim();
    if (!part) continue;
    const site = siteOfWord(part);
    const hits = site ? site.feeds : list.filter((f) => f.toLowerCase() === part);
    if (!hits.length) return null;
    for (const hit of hits) if (!out.includes(hit)) out.push(hit);
  }
  return out.length ? out : null;
}

const LEAD = '(?:(?:ok(?:ay)?|alright|hey|please|nus|knot|can you|could you|would you|just)[,.!]?\\s+)*';
const START = new RegExp('^' + LEAD + '(?:keep me (?:off(?: of)?|away from|out of)|get me off(?: of)?|stay off(?: of)?|block|no more|no)\\s+(.+?)(?:\\s+(for|until|till|while)\\s+(.+?))?[.!?\\s]*$', 'i');
const BACK = new RegExp('^' + LEAD + '(?:(?:ok|alright|fine|now)[,.]?\\s+)?(?:let me back(?: in| on)?(?:\\s+(?:on|to|into)\\s+[a-z ]{2,30})?|give (?:it|them) back|let me have (?:it|them) back|(?:stop|end|cancel|turn off) (?:the )?focus guard|focus guard off|i(?:\'m| am) done,? let me back)[.!?\\s]*$', 'i');

// -> { kind: 'start', feeds: [...], minutes: n | null, untilApp: 'word' | null }
//  | { kind: 'back' } | null. Code reads these, not a model: a wrong guess
// would close someone's tab, and the phrases are few and exact.
function parseFocusCommand(text, feeds) {
  const t = String(text || '').replace(/[’]/g, "'").trim();
  if (!t || t.length > 140) return null;
  if (BACK.test(t)) return { kind: 'back' };
  const m = START.exec(t);
  if (!m) return null;
  const target = m[1]; const joiner = (m[2] || '').toLowerCase(); const tail = m[3] || '';
  const named = feedsNamed(target, feeds);
  if (!named) return null;
  const out = { kind: 'start', feeds: named, minutes: null, untilApp: null };
  if (tail) {
    if (joiner === 'for') {
      out.minutes = parseDuration(tail);
      if (out.minutes == null) return null;
    } else {
      out.untilApp = parseUntil(tail);
      if (!out.untilApp) return null;
    }
  }
  return out;
}

// The classifier said this is a guard, in words the phrases above miss ("remember
// I told you to keep me off of reels for 20 minutes"). The feeds and the time are
// still read by code: naming nothing is what means every feed.
function looseFocusCommand(text) {
  const t = String(text || '').toLowerCase().replace(/[’]/g, "'");
  const feeds = [];
  for (const site of SITES) {
    if (site.words.some((w) => w.length > 2 && w !== 'short' && new RegExp('(?:^|[^a-z0-9])' + esc(w) + '(?![a-z0-9])').test(t))) feeds.push(...site.feeds);
  }
  const m = /\bfor\s+(.+?)[.!?\s]*$/.exec(t);
  return { kind: 'start', feeds, minutes: m ? parseDuration(m[1]) : null, untilApp: null };
}

// ---- what the guard keeps the person off -----------------------------------
function feedSite(f) { return siteOfFeed(f) || { name: f, feeds: [f], words: [String(f).toLowerCase()], custom: true }; }
function guardedSites(feeds) {
  const out = [];
  for (const f of normalizeFeeds(feeds)) { const s = feedSite(f); if (!out.some((x) => x.name === s.name)) out.push(s); }
  return out;
}
function hostIs(host, want) { return host === want || host.endsWith('.' + want); }
// An address or a name ("Instagram", "instagram.com/reels") -> the guarded site's
// name, or null. A search that only mentions a site is not the site.
function guardedTarget(target, feeds) {
  const t = String(target || '').trim().toLowerCase();
  if (!t) return null;
  const sites = guardedSites(feeds);
  let url = null;
  if (/^https?:\/\//.test(t) || /^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:[/?#]|$)/.test(t)) { try { url = new URL(/^https?:/.test(t) ? t : 'https://' + t); } catch (_) { url = null; } }
  for (const s of sites) {
    if (url) {
      const host = url.hostname;
      if ((s.hosts || []).some((h) => hostIs(host, h))) return s.name;
      if ((s.paths || []).some(([h, p]) => hostIs(host, h) && url.pathname.startsWith(p))) return s.name;
      if (s.custom && host.split('.').includes(s.words[0])) return s.name;
    } else if (s.words.includes(t.replace(/\s*(?:\.|dot)\s*com$/, ''))) return s.name;
  }
  return null;
}
// An ask to open one: "Open Instagram on...", "go to x dot com", "open Chrome and
// show me reels". The site has to be what is being opened, so "open Notepad and
// write about Instagram" and "how do I open Instagram" are not it.
const OPENS = '\\b(?:open|go (?:to|on)|get on|pull up|bring up|launch|start|show me|take me to|visit|browse|scroll|check)\\s+(?:up\\s+)?(?:a\\s+(?:new\\s+)?tab\\s+(?:on|for|with|to)\\s+)?(?:the\\s+|my\\s+)?';
function guardedAsk(text, feeds) {
  const t = String(text || '').toLowerCase().replace(/[’]/g, "'");
  if (!t || /^\s*(?:how|why|what|where|when|who|is|does|do)\b/.test(t)) return null;
  for (const s of guardedSites(feeds)) {
    const words = s.words.filter((w) => w !== 'short').map(esc).sort((a, b) => b.length - a.length).join('|');
    if (words && new RegExp(OPENS + '(?:' + words + ')(?:\\s*(?:\\.|dot)\\s*com)?(?![a-z0-9])').test(t)) return s.name;
  }
  return null;
}
function clockTime(ms) {
  const d = new Date(ms);
  return ((d.getHours() + 11) % 12 + 1) + ':' + String(d.getMinutes()).padStart(2, '0');
}

// ---- copy. Short, plain, no em dashes. ------------------------------------
const COPY = {
  minutes: (n) => n + ' min. Then you can have it back.',
  untilApp: (app) => 'Until you close ' + app + '. Then you can have it back.',
  done: 'Done. Go ahead.',
  nothing: 'Nothing to reopen.',
  off: 'Focus guard is off in Settings.',
  noFeeds: 'No feed titles set. Add some in Settings.',
  refused: (site, when) => 'You asked me to stay off ' + site + ' until ' + when + '.'
};

// ---- the state machine -----------------------------------------------------
//   off --start--> active --(timer | app closed | back | stop)--> done --> off
// Events out (onEvent): start, hop, closed, end, reopen, note.
function createFocusGuard(o) {
  const say = o.log || (() => {});
  const now = o.now || Date.now;
  const setT = o.setTimeout || setTimeout;
  const clearT = o.clearTimeout || clearTimeout;
  const pollMs = o.pollMs || POLL_MS;
  const emit = (ev) => { if (o.onEvent) { try { o.onEvent(ev); } catch (e) { say('[focus] onEvent failed: ' + e.message); } } };
  const feedsNow = () => normalizeFeeds(typeof o.feeds === 'function' ? o.feeds() : o.feeds);

  const state = { active: false, until: null, condition: null, feeds: [], closedUrl: null, closedTitle: null, closedAt: 0, closes: 0, startedAt: 0, endedAt: 0, appSeen: false };
  let pollTimer = null, endTimer = null, closing = false, lastClose = { key: '', at: 0 }, gen = 0;

  function noteText() {
    if (!state.active) return COPY.done;
    if (state.condition.kind === 'untilApp') return COPY.untilApp(state.condition.app);
    return COPY.minutes(Math.max(1, Math.ceil((state.until - now()) / 60000)));
  }

  // The one line for a guarded site: when it lifts, in the person's own terms.
  function refusal(site) {
    if (!site) return null;
    const when = state.condition.kind === 'untilApp' ? 'you close ' + state.condition.app : clockTime(state.until);
    const text = COPY.refused(site, when);
    say('[focus] refused ' + site);
    return text;
  }
  const refuse = (target) => (state.active ? refusal(guardedTarget(target, state.feeds)) : null);
  const refuseAsk = (text) => (state.active ? refusal(guardedAsk(text, state.feeds)) : null);

  function clearTimers() {
    if (pollTimer) { clearT(pollTimer); pollTimer = null; }
    if (endTimer) { clearT(endTimer); endTimer = null; }
  }

  function start(cmd) {
    const feeds = feedsNow();
    const named = cmd && Array.isArray(cmd.feeds) ? cmd.feeds : [];
    if (!feeds.length && !named.some(siteOfFeed)) { emit({ type: 'note', text: COPY.noFeeds }); return { ok: false, text: COPY.noFeeds }; }
    const want = named.length ? named.filter((f) => siteOfFeed(f) || feeds.some((g) => g.toLowerCase() === f.toLowerCase())) : feeds.slice();
    clearTimers();
    gen++;
    state.active = true; state.startedAt = now(); state.endedAt = 0; state.appSeen = false; state.closes = 0;
    state.feeds = want.length ? want : feeds.slice();
    if (cmd && cmd.untilApp) {
      state.condition = { kind: 'untilApp', app: String(cmd.untilApp) };
      state.until = now() + MAX_MINUTES * 60000;            // a safety cap, never the headline
    } else {
      const minutes = Math.min(MAX_MINUTES, Math.max(1, Math.round(Number(cmd && cmd.minutes) || DEFAULT_MINUTES)));
      state.condition = { kind: 'minutes', minutes };
      state.until = now() + minutes * 60000;
    }
    endTimer = setT(() => { endTimer = null; end('timer'); }, state.until - now());
    schedule(0);
    const text = noteText();
    say('[focus] on: ' + state.feeds.join(', ') + ' ' + JSON.stringify(state.condition));
    emit({ type: 'start', text, feeds: state.feeds.slice(), condition: state.condition });
    return { ok: true, text };
  }

  function end(reason) {
    if (!state.active) return { ok: false };
    clearTimers();
    state.active = false; state.endedAt = now();
    say('[focus] off (' + reason + '), closed ' + state.closes + ' tab' + (state.closes === 1 ? '' : 's'));
    emit({ type: 'end', text: COPY.done, reason, closes: state.closes, closedUrl: state.closedUrl });
    return { ok: true, text: COPY.done };
  }

  // "Ok let me back": ends the guard if it is on, and reopens what was closed.
  function back() {
    const was = state.active;
    if (was) end('asked');
    const recent = state.closedUrl && (was || now() - Math.max(state.endedAt, state.closedAt) < BACK_WINDOW_MS);
    if (recent) {
      const url = state.closedUrl;
      state.closedUrl = null; state.closedTitle = null;
      emit({ type: 'reopen', url, text: was ? COPY.done : 'Go ahead.' });
      return { ok: true, reopened: url, text: was ? COPY.done : 'Go ahead.' };
    }
    if (!was) emit({ type: 'note', text: COPY.nothing });
    return { ok: was, reopened: null, text: was ? COPY.done : COPY.nothing };
  }

  function schedule(ms) {
    if (!state.active) return;
    if (pollTimer) clearT(pollTimer);
    const g = gen;
    pollTimer = setT(() => { pollTimer = null; if (g === gen) tick().catch((e) => say('[focus] tick: ' + e.message)).then(() => { if (g === gen) schedule(pollMs); }); }, ms);
  }

  async function fg() {
    try { return await o.probe.request('fg', { ignorePid: o.ownPid || process.pid }, 900); } catch (_) { return null; }
  }

  // "Until I close Word": the app must have been seen once, then be gone.
  async function checkApp() {
    let r = null;
    try { r = await o.probe.request('win.find', { name: state.condition.app }, 900); } catch (_) { return; }
    if (!r) return;
    if (r.found) state.appSeen = true;
    else if (state.appSeen) end('app closed');
  }

  async function tick() {
    if (!state.active || closing) return;
    if (state.condition.kind === 'untilApp') { await checkApp(); if (!state.active) return; }
    const f = await fg();
    if (!f || !f.hwnd || !state.active) return;
    const feed = isBrowserProcess(f.process) ? matchFeed(f.title, state.feeds) : null;
    if (!feed) return;
    const key = f.hwnd + '|' + f.title;
    if (key === lastClose.key && now() - lastClose.at < CLOSE_COOLDOWN_MS) return;
    closing = true;
    try { await closeTab(f, feed); } finally { closing = false; }
  }

  async function closeTab(f, feed) {
    // The Knot hops first, before anything is awaited: the host hands this to
    // the renderer ahead of the engine tick (the v4 rule), so the move is on
    // screen as the tab goes.
    emit({ type: 'hop', rect: f.rect || null, hwnd: f.hwnd, title: f.title, feed });
    // The hands re-read the title by handle right before activating: a window
    // that stopped being a feed in the meantime is left alone.
    let act = null;
    const site = siteOfFeed(feed);
    const mustContain = site && site.title && /\bTwitter\b/.test(f.title) ? 'Twitter' : feed;
    try { act = await o.hands.request('win.activate', { hwnd: f.hwnd, mustContain, name: f.title }, 1500); } catch (e) { say('[focus] activate failed: ' + e.message); }
    // Refused or failed: the same cooldown as a close, so the Knot does not hop
    // at a window the hands will not touch on every poll.
    lastClose = { key: f.hwnd + '|' + f.title, at: now() };
    if (!act || !act.ok) { say('[focus] not closing: ' + (act && (act.refused || act.error) || 'could not bring the window forward')); return false; }
    try { await o.hands.request('keys.chord', { keys: [VK.CTRL, VK.W] }, 1500); } catch (e) { say('[focus] chord failed: ' + e.message); return false; }
    state.closes++;
    state.closedAt = now();
    state.closedTitle = f.title;
    state.closedUrl = FEED_URLS[feed.toLowerCase()] || null;
    const text = noteText();
    say('[focus] closed "' + String(f.title).slice(0, 60) + '" (' + feed + ')');
    emit({ type: 'closed', text, feed, title: f.title, url: state.closedUrl });
    return true;
  }

  return {
    start, end, back, tick, refuse, refuseAsk,
    stop: (reason) => end(reason || 'stopped'),
    active: () => state.active,
    status: () => ({ active: state.active, until: state.until, condition: state.condition, feeds: state.feeds.slice(), closedUrl: state.closedUrl, closes: state.closes, text: state.active ? noteText() : null }),
    COPY
  };
}

module.exports = { createFocusGuard, shouldClose, matchFeed, isBrowserProcess, normalizeFeeds, parseFocusCommand, looseFocusCommand, guardedTarget, guardedAsk, clockTime, parseDuration, parseUntil, feedsNamed, DEFAULT_FEEDS, FEED_URLS, COPY, DEFAULT_MINUTES, MAX_MINUTES };
