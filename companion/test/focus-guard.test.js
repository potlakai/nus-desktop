const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createFocusGuard, looseFocusCommand, guardedTarget, guardedAsk, clockTime, shouldClose, matchFeed, isBrowserProcess, normalizeFeeds, parseFocusCommand, parseDuration, parseUntil, feedsNamed, DEFAULT_FEEDS, FEED_URLS, COPY } = require('../src/reflex/focus-guard');
const { VK } = require('../src/reflex/executor');

const root = path.resolve(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

// ---- shouldClose: pure, and the whole safety story -------------------------
test('shouldClose: only a browser window whose title names a feed', () => {
  const feeds = DEFAULT_FEEDS;
  assert.strictEqual(shouldClose('Reels • Instagram - Google Chrome', 'chrome', feeds), true);
  assert.strictEqual(shouldClose('Instagram — Mozilla Firefox', 'firefox', feeds), true);
  assert.strictEqual(shouldClose('TikTok - Make Your Day - Microsoft Edge', 'msedge', feeds), true);
  assert.strictEqual(shouldClose('(3) Shorts - YouTube - Brave', 'brave', feeds), true);
  assert.strictEqual(shouldClose('instagram - Opera', 'opera.exe', feeds), true, 'any case, .exe or not');
  // The same titles outside a browser: never.
  assert.strictEqual(shouldClose('reels-plan.docx - Word', 'WINWORD', feeds), false);
  assert.strictEqual(shouldClose('Instagram ads - Notepad', 'Notepad', feeds), false);
  assert.strictEqual(shouldClose('Reels • Instagram', 'electron', feeds), false, 'not even our own window');
  // A browser on anything else: never.
  assert.strictEqual(shouldClose('Google Docs - essay draft - Google Chrome', 'chrome', feeds), false);
  assert.strictEqual(shouldClose('New Tab - Google Chrome', 'chrome', feeds), false);
  assert.strictEqual(shouldClose('', 'chrome', feeds), false);
  assert.strictEqual(shouldClose(null, null, feeds), false);
  // Whole words: "shortstop" is not "Shorts", "reelsmith" is not "Reels".
  assert.strictEqual(shouldClose('shortstop drills - YouTube - Google Chrome', 'chrome', feeds), false);
  assert.strictEqual(shouldClose('reelsmith blog - Google Chrome', 'chrome', feeds), false);
  // The list is the person's: an edited list changes what counts.
  assert.strictEqual(shouldClose('Reels • Instagram - Google Chrome', 'chrome', ['Twitter']), false);
  assert.strictEqual(shouldClose('Home / X - Google Chrome', 'chrome', ['X']), true);
  assert.strictEqual(shouldClose('Reels • Instagram - Google Chrome', 'chrome', []), false, 'an empty list closes nothing');
  assert.strictEqual(matchFeed('TikTok - Make Your Day - Microsoft Edge', feeds), 'TikTok');
  assert.ok(isBrowserProcess('chrome') && isBrowserProcess('msedge.exe') && !isBrowserProcess('Code') && !isBrowserProcess(''));
});

test('normalizeFeeds: trimmed, short, deduplicated, at most twenty, defaults when nothing is given', () => {
  assert.deepStrictEqual(normalizeFeeds(undefined), DEFAULT_FEEDS);
  assert.deepStrictEqual(normalizeFeeds(' Instagram ,reels, ,REELS, X'), ['Instagram', 'reels', 'X']);
  assert.deepStrictEqual(normalizeFeeds(['TikTok', 'tiktok', 'x'.repeat(80)]), ['TikTok', 'x'.repeat(40)]);
  assert.strictEqual(normalizeFeeds(Array.from({ length: 40 }, (_, i) => 'f' + i)).length, 20);
  assert.deepStrictEqual(normalizeFeeds([]), [], 'an emptied list stays empty');
});

// ---- the words ---------------------------------------------------------------
test('the phrases from the scope parse to a start or a back; anything else is nothing', () => {
  const P = (t) => parseFocusCommand(t);
  assert.deepStrictEqual(P('keep me off reels'), { kind: 'start', feeds: ['Instagram', 'Reels'], minutes: null, untilApp: null });
  assert.deepStrictEqual(P('keep me off Reels for 20 minutes'), { kind: 'start', feeds: ['Instagram', 'Reels'], minutes: 20, untilApp: null });
  assert.deepStrictEqual(P('no reels for 20 minutes'), { kind: 'start', feeds: ['Instagram', 'Reels'], minutes: 20, untilApp: null });
  assert.deepStrictEqual(P('block tiktok until I close word'), { kind: 'start', feeds: ['TikTok'], minutes: null, untilApp: 'word' });
  assert.deepStrictEqual(P('ok let me back'), { kind: 'back' });
  assert.deepStrictEqual(P('Okay, let me back on Instagram.'), { kind: 'back' });
  assert.deepStrictEqual(P('let me back in'), { kind: 'back' });
  assert.deepStrictEqual(P('stop the focus guard'), { kind: 'back' });
  // Variations people actually say.
  assert.deepStrictEqual(P('hey nus, keep me off instagram and tiktok for half an hour'), { kind: 'start', feeds: ['Instagram', 'Reels', 'TikTok'], minutes: 30, untilApp: null });
  assert.deepStrictEqual(P('no tik tok for the next fifteen minutes'), { kind: 'start', feeds: ['TikTok'], minutes: 15, untilApp: null });
  assert.deepStrictEqual(P('keep me off social media for an hour'), { kind: 'start', feeds: DEFAULT_FEEDS.slice(), minutes: 60, untilApp: null });
  assert.deepStrictEqual(P('block shorts till I finish the essay'), { kind: 'start', feeds: ['Shorts'], minutes: null, untilApp: 'essay' });
  assert.deepStrictEqual(P('keep me off reels until Word is closed'), { kind: 'start', feeds: ['Instagram', 'Reels'], minutes: null, untilApp: 'Word' });
  assert.deepStrictEqual(P('no youtube shorts for 10 min'), { kind: 'start', feeds: ['Shorts'], minutes: 10, untilApp: null });
  // An edited feed list is what the words are read against.
  assert.deepStrictEqual(parseFocusCommand('block x for 5 minutes', ['X', 'Reels']), { kind: 'start', feeds: ['X'], minutes: 5, untilApp: null });
  assert.strictEqual(parseFocusCommand('block facebook for 5 minutes', ['X']), null, 'not in the list and not a known site: not a guard');
  assert.deepStrictEqual(parseFocusCommand('block facebook for 5 minutes', ['Facebook']), { kind: 'start', feeds: ['Facebook'], minutes: 5, untilApp: null });
  // Never a guard: room talk, other commands, a "no" that is not about a feed.
  for (const t of ['no thanks', 'no', 'block the view', 'keep me posted', 'let me know when you are back', 'open instagram', 'search reels editing tips', 'no reels for a while', 'keep me off reels for ever', 'block tiktok until', 'I am back from lunch', '', 'keep me off ' + 'reels and '.repeat(30)]) {
    assert.strictEqual(P(t), null, JSON.stringify(t));
  }
});

test('durations and end conditions are read plainly, and capped', () => {
  assert.strictEqual(parseDuration('20 minutes'), 20);
  assert.strictEqual(parseDuration('twenty min'), 20);
  assert.strictEqual(parseDuration('an hour'), 60);
  assert.strictEqual(parseDuration('1.5 hours'), 90);
  assert.strictEqual(parseDuration('half an hour'), 30);
  assert.strictEqual(parseDuration('the next 15 minutes'), 15);
  assert.strictEqual(parseDuration('forty five minutes'), 45);
  assert.strictEqual(parseDuration('12 hours'), 480, 'capped at eight hours');
  assert.strictEqual(parseDuration('0 minutes'), null);
  assert.strictEqual(parseDuration('a while'), null);
  assert.strictEqual(parseDuration('minutes'), null);
  assert.strictEqual(parseUntil('I close Word'), 'Word');
  assert.strictEqual(parseUntil("I'm done with the essay"), 'essay');
  assert.strictEqual(parseUntil('Excel is closed'), 'Excel');
  assert.strictEqual(parseUntil('I close microsoft word'), 'microsoft word');
  assert.strictEqual(parseUntil(''), null);
  assert.strictEqual(parseUntil('x'), null);
  assert.deepStrictEqual(feedsNamed('reels, insta and youtube shorts'), ['Instagram', 'Reels', 'Shorts']);
  assert.strictEqual(feedsNamed('reels and homework'), null);
});

test('the copy is short, plain and has no em dashes', () => {
  assert.strictEqual(COPY.minutes(20), '20 min. Then you can have it back.');
  assert.strictEqual(COPY.untilApp('Word'), 'Until you close Word. Then you can have it back.');
  assert.strictEqual(COPY.done, 'Done. Go ahead.');
  for (const v of Object.values(COPY)) {
    const s = typeof v === 'function' ? v('Word') : v;
    assert.doesNotMatch(s, /[—–]/, s);
    assert.ok(s.length <= 60, s);
  }
  // Nor anywhere in the feature's user-facing files.
  for (const f of [['src', 'reflex', 'focus-guard.js'], ['home', 'index.html'], ['home', 'home.js']]) assert.doesNotMatch(read(...f), /—/, f.join('/') + ' has an em dash');
});

// ---- the state machine, on a fake clock --------------------------------------
function fakeClock() {
  let t = 1_000_000;
  const timers = [];
  let id = 0;
  const clock = {
    now: () => t,
    setTimeout: (fn, ms) => { const h = { id: ++id, at: t + Math.max(0, Number(ms) || 0), fn }; timers.push(h); return h.id; },
    clearTimeout: (h) => { const i = timers.findIndex((x) => x.id === h); if (i >= 0) timers.splice(i, 1); },
    // Advance in steps, running every due timer in order and letting promises settle.
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > end) break;
        t = next.at; timers.shift();
        next.fn();
        for (let i = 0; i < 8; i++) await Promise.resolve();
        await new Promise((r) => setImmediate(r));
      }
      t = end;
      await new Promise((r) => setImmediate(r));
    },
    pending: () => timers.length
  };
  return clock;
}

function rig(opts = {}) {
  const clock = fakeClock();
  const events = [];
  const ops = [];
  const front = { value: { hwnd: 7, title: 'New Tab - Google Chrome', process: 'chrome', rect: { x: 10, y: 20, w: 1200, h: 800 } } };
  const windows = { word: false };
  const probe = { request: async (op, p) => {
    ops.push([op, p]);
    if (op === 'fg') return front.value;
    if (op === 'win.find') return { found: !!windows[String(p.name).toLowerCase()] };
    return {};
  } };
  const hands = { request: async (op, p) => {
    ops.push([op, p]);
    if (op === 'win.activate') {
      if (opts.titleChanges) return { ok: false, found: true, refused: 'title changed', title: 'Google Docs - Google Chrome' };
      return { ok: true, found: true, title: front.value.title, hwnd: p.hwnd };
    }
    if (op === 'keys.chord') { if (opts.afterClose) front.value = opts.afterClose; return { ok: true }; }
    return { ok: true };
  } };
  const guard = createFocusGuard({ probe, hands, feeds: () => (opts.feeds === undefined ? DEFAULT_FEEDS : opts.feeds), onEvent: (e) => events.push(e), now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, ownPid: 1, log: () => {} });
  return { clock, events, ops, front, windows, guard, types: () => events.map((e) => e.type), chords: () => ops.filter(([op]) => op === 'keys.chord') };
}

test('a 20 minute guard: closes a feed tab within one poll, says the time left, says Done when the time is up', async () => {
  const r = rig({ afterClose: { hwnd: 7, title: 'Google Docs - essay - Google Chrome', process: 'chrome', rect: { x: 0, y: 0, w: 100, h: 100 } } });
  const started = r.guard.start({ kind: 'start', feeds: ['Reels'], minutes: 20, untilApp: null });
  assert.deepStrictEqual([started.ok, started.text], [true, '20 min. Then you can have it back.']);
  assert.deepStrictEqual(r.types(), ['start']);
  assert.strictEqual(r.guard.active(), true);
  // Nothing happens on a document.
  await r.clock.advance(3000);
  assert.strictEqual(r.chords().length, 0);
  assert.deepStrictEqual(r.types(), ['start']);
  // A Reels tab comes to the front: within the next poll it is gone.
  r.front.value = { hwnd: 7, title: 'Reels • Instagram - Google Chrome', process: 'chrome', rect: { x: 10, y: 20, w: 1200, h: 800 } };
  await r.clock.advance(1000);
  assert.deepStrictEqual(r.types(), ['start', 'hop', 'closed']);
  const hop = r.events[1], closed = r.events[2];
  assert.deepStrictEqual(hop.rect, { x: 10, y: 20, w: 1200, h: 800 });
  assert.ok(r.ops.findIndex(([op]) => op === 'win.activate') < r.ops.findIndex(([op]) => op === 'keys.chord'), 'activate, then the chord');
  const act = r.ops.find(([op]) => op === 'win.activate')[1];
  assert.deepStrictEqual([act.hwnd, act.mustContain], [7, 'Reels'], 'activated by handle, with the feed word to re-check');
  assert.deepStrictEqual(r.chords()[0][1].keys, [VK.CTRL, VK.W], 'Ctrl+W through the existing chord op');
  assert.strictEqual(closed.text, '20 min. Then you can have it back.');
  assert.strictEqual(closed.url, FEED_URLS.reels);
  assert.strictEqual(r.guard.status().closes, 1);
  // The next tab, later, gets the time that is left.
  await r.clock.advance(5 * 60 * 1000);
  r.front.value = { hwnd: 9, title: 'Reels • Instagram - Mozilla Firefox', process: 'firefox', rect: null };
  await r.clock.advance(1000);
  assert.strictEqual(r.events[r.events.length - 1].type, 'closed');
  assert.strictEqual(r.events[r.events.length - 1].text, '15 min. Then you can have it back.');
  // Instagram's home is not in a Reels-only guard: left alone.
  r.front.value = { hwnd: 11, title: 'Instagram - Google Chrome', process: 'chrome', rect: null };
  await r.clock.advance(2000);
  assert.strictEqual(r.chords().length, 2, 'a feed the guard was not asked about stays open');
  r.front.value = { hwnd: 11, title: 'Google Docs - essay - Google Chrome', process: 'chrome', rect: null };
  assert.strictEqual(r.chords().length, 2);
  // Time is up: it says so, and polls no more.
  await r.clock.advance(15 * 60 * 1000);
  assert.strictEqual(r.events[r.events.length - 1].type, 'end');
  assert.strictEqual(r.events[r.events.length - 1].text, 'Done. Go ahead.');
  assert.strictEqual(r.guard.active(), false);
  const before = r.ops.length;
  await r.clock.advance(5000);
  assert.strictEqual(r.ops.length, before, 'no polling after the end');
  assert.strictEqual(r.clock.pending(), 0, 'no timers left behind');
});

test('a cooldown stops the same window being hammered, and a tab that stopped being a feed is left alone', async () => {
  const r = rig();   // the title never changes after the chord (the close "missed")
  r.guard.start({ kind: 'start', feeds: ['Reels'], minutes: 20 });
  r.front.value = { hwnd: 7, title: 'Reels • Instagram - Google Chrome', process: 'chrome', rect: null };
  // Polls at 0 and at 1000 ms: one close, then the poll inside the 1.5 s cooldown skips.
  await r.clock.advance(1000);
  assert.strictEqual(r.chords().length, 1, 'same window, same title, inside the cooldown: not again');
  // The poll at 2000 ms: past the cooldown and still a feed, so it tries again.
  await r.clock.advance(1000);
  assert.strictEqual(r.chords().length, 2, 'still a feed past the cooldown: tried again');
  // The hands say the title changed between the poll and the press: no chord.
  const r2 = rig({ titleChanges: true });
  r2.guard.start({ kind: 'start', feeds: ['Reels'], minutes: 20 });
  r2.front.value = { hwnd: 7, title: 'Reels • Instagram - Google Chrome', process: 'chrome', rect: null };
  await r2.clock.advance(1000);
  assert.strictEqual(r2.chords().length, 0, 'nothing pressed');
  assert.deepStrictEqual(r2.types(), ['start', 'hop'], 'the hop happened, the close did not');
  assert.strictEqual(r2.guard.status().closes, 0);
});

test('"until I close Word": ends only after Word was seen and is then gone; a feed meanwhile is still closed', async () => {
  const r = rig({ afterClose: { hwnd: 7, title: 'New Tab - Google Chrome', process: 'chrome', rect: null } });
  const s = r.guard.start({ kind: 'start', feeds: [], minutes: null, untilApp: 'Word' });
  assert.strictEqual(s.text, 'Until you close Word. Then you can have it back.');
  assert.deepStrictEqual(r.guard.status().feeds, DEFAULT_FEEDS, 'no feed named: all of them');
  await r.clock.advance(3000);
  assert.strictEqual(r.guard.active(), true, 'Word not open yet: that is not "closed"');
  r.windows.word = true;
  await r.clock.advance(2000);
  r.front.value = { hwnd: 7, title: 'TikTok - Make Your Day - Google Chrome', process: 'chrome', rect: null };
  await r.clock.advance(1000);
  assert.strictEqual(r.chords().length, 1);
  assert.strictEqual(r.events[r.events.length - 1].text, 'Until you close Word. Then you can have it back.');
  r.windows.word = false;
  await r.clock.advance(1000);
  assert.strictEqual(r.guard.active(), false);
  assert.strictEqual(r.events[r.events.length - 1].type, 'end');
  assert.strictEqual(r.events[r.events.length - 1].reason, 'app closed');
});

test('"ok let me back": ends the guard and reopens the feed it last closed; later, within ten minutes, it still reopens; with nothing closed it says so', async () => {
  const r = rig({ afterClose: { hwnd: 7, title: 'New Tab - Google Chrome', process: 'chrome', rect: null } });
  r.guard.start({ kind: 'start', feeds: ['Reels', 'Shorts'], minutes: 20 });
  r.front.value = { hwnd: 7, title: 'Shorts - YouTube - Google Chrome', process: 'chrome', rect: null };
  await r.clock.advance(1000);
  const back = r.guard.back();
  assert.deepStrictEqual([back.ok, back.reopened, back.text], [true, FEED_URLS.shorts, 'Done. Go ahead.']);
  assert.deepStrictEqual(r.types().slice(-2), ['end', 'reopen']);
  assert.strictEqual(r.guard.active(), false);
  // Asked again: nothing left to reopen.
  const again = r.guard.back();
  assert.deepStrictEqual([again.ok, again.reopened, again.text], [false, null, 'Nothing to reopen.']);
  assert.strictEqual(r.events[r.events.length - 1].type, 'note');

  // The condition ended on its own; "let me back" a minute later reopens.
  const r2 = rig({ afterClose: { hwnd: 7, title: 'New Tab - Google Chrome', process: 'chrome', rect: null } });
  r2.guard.start({ kind: 'start', feeds: ['Reels'], minutes: 1 });
  r2.front.value = { hwnd: 7, title: 'Reels • Instagram - Google Chrome', process: 'chrome', rect: null };
  await r2.clock.advance(1000);
  await r2.clock.advance(60 * 1000);
  assert.strictEqual(r2.guard.active(), false);
  await r2.clock.advance(60 * 1000);
  const late = r2.guard.back();
  assert.deepStrictEqual([late.reopened, late.text], [FEED_URLS.reels, 'Go ahead.']);
  // Much later it does not: the person has moved on.
  const r3 = rig({ afterClose: { hwnd: 7, title: 'New Tab - Google Chrome', process: 'chrome', rect: null } });
  r3.guard.start({ kind: 'start', feeds: ['Reels'], minutes: 1 });
  r3.front.value = { hwnd: 7, title: 'Reels • Instagram - Google Chrome', process: 'chrome', rect: null };
  await r3.clock.advance(1000);
  await r3.clock.advance(60 * 1000 + 11 * 60 * 1000);
  assert.strictEqual(r3.guard.back().reopened, null);
});

test('a custom feed with no known home closes, but cannot be reopened; a second start replaces the first; stop clears everything', async () => {
  const r = rig({ feeds: ['Threads', 'Reels'], afterClose: { hwnd: 7, title: 'New Tab - Google Chrome', process: 'chrome', rect: null } });
  r.guard.start({ kind: 'start', feeds: [], minutes: 10 });
  r.front.value = { hwnd: 7, title: 'Home - Threads - Google Chrome', process: 'chrome', rect: null };
  await r.clock.advance(1000);
  assert.strictEqual(r.chords().length, 1);
  assert.strictEqual(r.events[r.events.length - 1].url, null);
  // Restart with a longer guard: one poll loop, one end timer.
  const s2 = r.guard.start({ kind: 'start', feeds: ['Reels'], minutes: 30 });
  assert.strictEqual(s2.text, '30 min. Then you can have it back.');
  assert.deepStrictEqual(r.guard.status().feeds, ['Reels']);
  assert.strictEqual(r.clock.pending(), 2, 'one poll, one end timer');
  r.front.value = { hwnd: 8, title: 'Home - Threads - Google Chrome', process: 'chrome', rect: null };
  await r.clock.advance(2000);
  assert.strictEqual(r.chords().length, 1, 'X is not in this guard');
  r.guard.stop('settings');
  assert.strictEqual(r.guard.active(), false);
  assert.strictEqual(r.clock.pending(), 0);
  assert.strictEqual(r.events[r.events.length - 1].reason, 'settings');
  // An emptied feed list refuses to start, and says why.
  const r4 = rig({ feeds: [] });
  assert.deepStrictEqual(r4.guard.start({ kind: 'start', feeds: [], minutes: 5 }), { ok: false, text: 'No feed titles set. Add some in Settings.' });
  assert.strictEqual(r4.guard.active(), false);
});

// ---- wiring: the host, the switch, the hands, the Knot ------------------------
test('the guard is wired: typed and spoken words reach it, the switch stops it, the hands re-check the title, the Knot hops first', () => {
  const main = read('index.js'), reflex = read('src', 'reflex', 'index.js'), router = read('src', 'reflex', 'router.js');
  assert.match(main, /const fc = parseFocusCommand\(text, store\.getSettings\(\)\.focusGuardFeeds\)/, 'spoken, before the reflex layer');
  assert.match(main, /const fc = parseFocusCommand\(p\.text, store\.getSettings\(\)\.focusGuardFeeds\)/, 'typed');
  assert.match(main, /onFocusGuard: \(cmd\) => handleFocusCommand\(cmd, 'voice'\)/, 'Jev-routed variants');
  assert.match(main, /if \(s\.focusGuard === false\) \{ flash\(FOCUS_COPY\.off/, 'off in Settings means off');
  assert.match(main, /if \(s\.focusGuard !== true\) applySettingsPatch\(\{ focusGuard: true \}\)/, 'first use turns the switch on');
  assert.match(main, /if \(patch\.focusGuard === false && focusGuard && focusGuard\.active\(\)\) focusGuard\.stop\('settings'\)/, 'the switch stops a running guard');
  assert.match(main, /if \(r\.ok\) \{ noteAsk\('guide', 'focus_guard'\); noteWin\('focus_guard'\);/, 'one ask event, mode guide, feature focus_guard, on activation');
  assert.match(main, /send\('focus:guard', \{ phase: 'hop', rect \}\)/);
  assert.match(main, /shell\.openExternal\(ev\.url\)/, 'the reopen');
  assert.match(reflex, /if \(onFocusGuard\) onFocusGuard\(d\.focus/);
  assert.match(router, /focus_guard:/);
  const store = read('src', 'store.js');
  assert.match(store, /focusGuard: null/); assert.match(store, /focusGuardFeeds: \['Instagram', 'Reels', 'TikTok', 'Shorts'\]/);
  const host = fs.readFileSync(path.join(root, '..', 'src', 'main-companion.js'), 'utf8');
  assert.match(host, /'hideFromCapture', 'sounds', 'focusGuard'/, 'Home may flip the switch');
  assert.match(host, /clean\.focusGuardFeeds = normalizeFeeds\(patch\.focusGuardFeeds\)/, 'and edit the list, cleaned');
  const html = read('home', 'index.html'), home = read('home', 'home.js');
  assert.match(html, /id="focus-guard"/); assert.match(html, /id="focus-feeds"/); assert.match(html, />Focus guard </);
  assert.match(home, /'focus-guard':\['focusGuard'/); assert.match(home, /'focus-feeds':\['focusGuardFeeds'/);
  // The hands: by handle, the title re-read and matched before activation; the chord is the existing op.
  const hands = read('src', 'reflex', 'hands.ps1');
  assert.match(hands, /if \(\$req\.hwnd\) \{/);
  assert.match(hands, /refused='title changed'/);
  assert.match(hands, /refused='no title check'/, 'no feed word, no activation');
  assert.doesNotMatch(hands, /'win\.close'|CloseWindow|WM_CLOSE|PostMessage/, 'it only ever activates and presses Ctrl+W, never closes a window');
  const probe = read('src', 'win', 'probe.ps1');
  assert.match(probe, /'win\.find' \{/); assert.doesNotMatch(probe, /SetCursorPos|mouse_event|SendInput|keybd_event/, 'the probe still never clicks or types');
  // The Knot: the channel is allowed, the hop is issued inside the handler, coral and green exist.
  assert.match(read('preload.js'), /'focus:guard'/);
  const js = read('renderer', 'renderer.js'), css = read('renderer', 'knot-look.css');
  assert.match(js, /nus\.on\('focus:guard'/);
  const handler = js.slice(js.indexOf("nus.on('focus:guard'"), js.indexOf("nus.on('focus:guard'") + 1600);
  assert.ok(handler.indexOf('moveKnotTo(to, { persist: false })') > 0 && handler.indexOf('await') < 0, 'the hop is a synchronous move in the handler, ahead of the engine tick');
  assert.match(js, /if \(body === 'idle' && guardGlow\) body = 'ready'/);
  assert.match(css, /#orb\[data-guard='active'\] \{ --knot-accent: #F2735E/); assert.match(css, /#orb\[data-guard='done'\] \{ --knot-accent: #5BC48C/);
});

test('a feed word implies its site, whether or not Settings lists it', () => {
  const P = (t) => parseFocusCommand(t, DEFAULT_FEEDS).feeds;
  assert.deepStrictEqual(P('keep me off reels'), ['Instagram', 'Reels']);
  assert.deepStrictEqual(P('keep me off instagram'), ['Instagram', 'Reels']);
  assert.deepStrictEqual(P('keep me off of insta for 5 minutes'), ['Instagram', 'Reels']);
  assert.deepStrictEqual(P('no shorts'), ['Shorts']);
  assert.deepStrictEqual(P('block tiktok'), ['TikTok']);
  assert.deepStrictEqual(P('keep me off twitter'), ['X']);
  assert.deepStrictEqual(P('keep me off x for 10 minutes'), ['X']);
  assert.deepStrictEqual(parseFocusCommand('keep me off twitter for 5 minutes', ['Instagram']).feeds, ['X'], 'not in the list, still a known site');
  // The words the phrases miss, handed over by the classifier, keep their feed and time (live: the default feeds came back).
  assert.deepStrictEqual(looseFocusCommand('Okay, no, remember I told you to keep me off of reels for 20 minutes.'), { kind: 'start', feeds: ['Instagram', 'Reels'], minutes: 20, untilApp: null });
  assert.deepStrictEqual(looseFocusCommand('stop me scrolling so much'), { kind: 'start', feeds: [], minutes: null, untilApp: null });
});

test('the X rule: its page titles match, a stray X in any other title does not', () => {
  for (const t of ['Home / X - Google Chrome', '(3) Home / X', 'Lee (@lee) / X', 'Lee on X: "hello" / X', 'Twitter - Mozilla Firefox']) assert.equal(matchFeed(t, ['X']), 'X', t);
  for (const t of ['Mac OS X tips - Google Chrome', 'X-ray results', 'Generation X essay', 'Canvas - Google Chrome']) assert.equal(matchFeed(t, ['X']), null, t);
});

test('what is guarded: addresses, names and asks to open; never a mention', () => {
  const feeds = ['Instagram', 'Reels', 'Shorts', 'TikTok', 'X'];
  for (const u of ['https://www.instagram.com/', 'https://instagram.com/reels/', 'instagram.com', 'https://m.tiktok.com/@a', 'https://x.com/home', 'https://twitter.com', 'https://www.youtube.com/shorts/abc']) assert.ok(guardedTarget(u, feeds), u);
  assert.equal(guardedTarget('Instagram', feeds), 'Instagram');
  assert.equal(guardedTarget('reels', feeds), 'Instagram');
  assert.equal(guardedTarget('https://www.youtube.com/shorts/abc', feeds), 'YouTube Shorts');
  for (const u of ['https://www.youtube.com/watch?v=1', 'https://www.google.com/search?q=instagram', 'https://example.com/x.com', 'https://notinstagram.com', 'Notepad', 'Chrome', '']) assert.equal(guardedTarget(u, feeds), null, u);
  assert.equal(guardedTarget('https://www.instagram.com', ['Shorts']), null, 'only what is on');
  assert.equal(guardedTarget('https://www.facebook.com/', ['Facebook']), 'Facebook', 'a custom feed is its own site');

  for (const t of ['Open Instagram.', 'Open Instagram on...', 'open instagram in firefox', 'Can you open Chrome and show me reels', 'go to x dot com', 'Please pull up TikTok', 'open a new tab on instagram', 'go to instagram.com', 'The ask was: Open Instagram.']) assert.ok(guardedAsk(t, feeds), t);
  for (const t of ['how do I open Instagram', 'what is on tiktok', 'Open Notepad and write about Instagram', 'open notepad', 'open xcode', 'search reels editing tips', 'open the short story']) assert.equal(guardedAsk(t, feeds), null, t);
});

test('while the guard is on it refuses with one line naming when it lifts; off, or for another site, nothing', () => {
  const at = new Date(2026, 10, 3, 14, 11, 0).getTime();
  const g = createFocusGuard({ probe: { request: async () => null }, hands: { request: async () => ({ ok: true }) }, feeds: () => DEFAULT_FEEDS, now: () => at, setTimeout: () => 1, clearTimeout: () => {}, log: () => {} });
  assert.equal(g.refuse('https://www.instagram.com/'), null, 'not on yet');
  g.start(parseFocusCommand('keep me off reels for 20 minutes'));
  assert.equal(g.refuse('https://www.instagram.com/'), 'You asked me to stay off Instagram until 2:31.');
  assert.equal(g.refuseAsk('Open Instagram.'), 'You asked me to stay off Instagram until 2:31.');
  assert.equal(g.refuse('https://www.tiktok.com/'), null, 'not what was asked');
  assert.equal(g.refuseAsk('open notepad'), null);
  g.start(parseFocusCommand('keep me off tiktok until I close Word'));
  assert.equal(g.refuse('https://www.tiktok.com/'), 'You asked me to stay off TikTok until you close Word.');
  g.stop();
  assert.equal(g.refuse('https://www.tiktok.com/'), null, 'off again');
  assert.equal(clockTime(new Date(2026, 10, 3, 0, 5).getTime()), '12:05');
});

test('the refusal is wired at every door: the words, the reflex layer, Hands and the task executor', () => {
  const main = read('index.js');
  const route = main.slice(main.indexOf('async function routeUtterance('));
  assert.ok(route.indexOf('refusedByGuard(text, source, heardAt)') > 0 && route.indexOf('refusedByGuard(text, source, heardAt)') < route.indexOf('handsClaims(text)) { routeUtteranceSlow'), 'before Hands takes the words');
  assert.match(main, /if \(refusedByGuard\(p\.text, p\.source \|\| 'typed', Date\.now\(\)\)\) return;/, 'typed');
  assert.match(main, /refuseSite: guardLine\n/, 'the reflex layer');
  assert.match(main, /refuseSite: guardLine,\n\s+openPath/, 'the Hands actions');
  assert.match(main, /refuse: \(t\) => \{ const line = guardAskLine\(t\.request\)/, 'the task executor');
  assert.match(main, /if \(ev\.type === 'closed' && agent && agent\.active\(\)\) agent\.refuse\(/, 'Hands stops when its tab is closed');
});

test('the reflex open_site and open_app stop at the guard: nothing launches', async () => {
  const { createExecutor } = require('../src/reflex/executor');
  const opened = [];
  const ex = createExecutor({ probe: { request: async () => null }, hands: { request: async () => ({ ok: true }) }, shell: { openExternal: async (u) => { opened.push(u); } }, log: () => {}, spawnFn: () => { opened.push('spawn'); return { on() {}, unref() {} }; }, refuseSite: (t) => (/instagram/i.test(t) ? 'You asked me to stay off Instagram until 2:31.' : null) });
  const site = await ex.run({ intent: 'open_site', url: 'https://www.instagram.com' });
  assert.deepStrictEqual(site, { ok: false, refused: 'focus guard', line: 'You asked me to stay off Instagram until 2:31.' });
  const app = await ex.run({ intent: 'open_app', app: { name: 'Instagram', appId: 'x' } });
  assert.equal(app.refused, 'focus guard');
  assert.deepStrictEqual(opened, [], 'nothing opened');
  await ex.run({ intent: 'open_site', url: 'https://www.youtube.com' });
  assert.deepStrictEqual(opened, ['https://www.youtube.com'], 'another site still opens');
});

test('Hands: open_url and open_app refuse, and the run ends on the line instead of trying another way', async () => {
  const { createActions } = require('../src/hands/actions');
  const { HandsAgent } = require('../src/hands/agent');
  const opened = [];
  const line = 'You asked me to stay off Instagram until 2:31.';
  const actions = createActions({ probe: { request: async () => null }, hands: { request: async () => ({ ok: true }) }, shell: { openExternal: async (u) => { opened.push(u); } }, apps: () => [], log: () => {}, sleep: async () => {}, refuseSite: (t) => (/instagram/i.test(t) ? line : null) });
  assert.deepStrictEqual(await actions.run('open_url', { url: 'instagram.com', in: 'Firefox' }, {}), { ok: false, guarded: true, report: line });
  assert.deepStrictEqual(await actions.run('open_app', { name: 'Instagram' }, {}), { ok: false, guarded: true, report: line });
  assert.deepStrictEqual(opened, []);

  const sent = [];
  let asked = 0;
  const agent = new HandsAgent({
    read: async () => ({ fg: { title: 'Untitled - Notepad', process: 'Notepad', hwnd: 1 }, cap: null, elements: [{ id: 1, name: 'x', type: 'Button', rect: { x: 0, y: 0, w: 1, h: 1 } }], originPhys: { x: 0, y: 0 } }),
    llm: () => ({ ready: true, provider: 'test', async complete() { asked++; return 'Opening. [DO:open_url {"url": "https://www.instagram.com"}]'; } }),
    actions: { findElement: () => null, run: actions.run },
    consent: { preview: () => null, pending: { cancel() {} } },
    send: (c, p) => sent.push([c, p]), watcher: { async waitForChange() { return { changed: true, settled: true }; } }, sleep: async () => {},
  });
  await agent.run('Open Instagram', 'voice');
  assert.equal(asked, 1, 'no second try');
  assert.equal(agent.last.outcome, 'guarded');
  assert.equal(agent.canResume(), false, 'keep going does not take it back');
  assert.equal(agent.canFollowUp(), false);
  assert.ok(sent.some(([c, p]) => c === 'guide:bubble' && p.text === line), 'it says the line');
});

test('the Hands executor: a task the guard refuses is cancelled before the agent runs; a run that ends on it is cancelled too', async () => {
  const { createHandsExecutor } = require('../src/tasks/executors/hands');
  const events = [];
  let ran = 0;
  const fake = { d: { read: async () => ({}), actions: { run: async () => ({ ok: true }) }, send: () => {} }, resume() {}, stop() {}, last: { outcome: 'guarded' }, async run() { ran++; return true; } };
  const ctx = { emit: (type, data) => events.push([type, data]), resumed: false };
  const refused = createHandsExecutor({ agent: () => fake, refuse: () => 'You asked me to stay off Instagram until 2:31.' });
  await refused.run({ id: 't1', request: 'Open Instagram', source: 'voice' }, ctx);
  assert.equal(ran, 0, 'the agent never started');
  assert.deepStrictEqual(events.map((e) => e[0]), ['started', 'cancelled']);
  assert.equal(events[1][1].reason, 'guarded');
  events.length = 0;
  const free = createHandsExecutor({ agent: () => fake, refuse: () => null });
  await free.run({ id: 't2', request: 'Open Notepad', source: 'voice' }, ctx);
  assert.equal(ran, 1);
  assert.deepStrictEqual(events.map((e) => e[0]), ['started', 'cancelled'], 'the run ended on the guard line');
});
