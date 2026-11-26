// Focus guard, checked in the running Companion (launch-companion.ps1, CDP 9342):
// opens a Reels tab in YOUR default browser, types "keep me off reels for 1
// minute" into the Knot, and asserts the tab is gone within 2 s and the note
// "1 min. Then you can have it back." is up; then types "ok let me back" and
// asserts "Done. Go ahead." and that the Reels tab came back. Screenshots and a
// JSON receipt go to work/nus-focus-guard/verify/.
//
// It uses the app the way a person would (real pointer and key events over
// CDP, the quick-ask composer) and reads window titles through PowerShell. It
// presses no keys of its own: the Ctrl+W is the Companion's, through hands.ps1.
// Run it at a desk, not in a meeting: it really closes and reopens a tab.
//
//   node companion\verify-focus-guard.cjs            (from Projects\nus-desktop-day1)
//   node companion\verify-focus-guard.cjs --url https://www.youtube.com/shorts/ --feed Shorts
//
// Needs: the Companion running from launch-companion.ps1 (probe available,
// Jev key optional: the phrases are read by code), Focus guard not switched off
// in Settings, a default browser. Leaves the reopened Reels tab for you to close.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const PORT = Number(process.env.NUS_CDP_PORT || 9342);
const OUT = process.env.NUS_VERIFY_OUT || 'C:/Users/prana/Downloads/jarvis-starter/jarvis/work/nus-focus-guard/verify';
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt; };
const URL_ = arg('--url', 'https://www.instagram.com/reels/');
const FEED = arg('--feed', 'Reels');
const CLOSE_BUDGET_MS = 2000;
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function attach(match) {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find(match);
  if (!page) throw new Error('no matching page (have: ' + list.map((x) => x.title + ' ' + x.url).join(' | ') + ')');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map(); let seq = 0;
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const call = (method, params = {}) => new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  await call('Runtime.enable'); await call('Page.enable');
  const ev = async (expr) => {
    const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception ? r.result.exceptionDetails.exception.description : 'eval failed');
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  const shot = async (name) => {
    const r = await call('Page.captureScreenshot', { format: 'png' });
    const file = path.join(OUT, name + '.png');
    fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
    return file;
  };
  const mouse = async (type, x, y, extra = {}) => call('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: type === 'mousePressed' || type === 'mouseReleased' ? 1 : 0, ...extra });
  const key = async (k, code, vk) => { await call('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk }); await call('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk }); };
  return { page, call, ev, shot, mouse, key, close: () => ws.close() };
}

// Titles of browser windows that carry the feed word. Read-only (Get-Process).
function feedWindows() {
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.ProcessName -match '^(chrome|msedge|firefox|brave|Arc|opera|vivaldi)$' } | ForEach-Object { $_.ProcessName + '|' + $_.MainWindowTitle }"], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
    const re = new RegExp('(?:^|[^a-z0-9])' + FEED.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![a-z0-9])', 'i');
    return out.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && re.test(s.split('|').slice(1).join('|')));
  } catch (e) { return ['(could not read windows: ' + e.message + ')']; }
}

const orbRect = (c) => c.ev(`(()=>{const r=document.getElementById('orb').getBoundingClientRect();return {cx:r.left+r.width/2,cy:r.top+r.height/2}})()`);

// Open the composer and type one line into the Knot, like a person would.
async function tellKnot(c, text) {
  const r = await orbRect(c);
  await c.mouse('mouseMoved', r.cx, r.cy); await c.mouse('mousePressed', r.cx, r.cy); await c.mouse('mouseReleased', r.cx, r.cy);
  await sleep(350);
  const open = await c.ev('!document.getElementById("quick-ask").classList.contains("hidden") && document.activeElement && document.activeElement.id === "quick-input"');
  if (!open) throw new Error('the composer did not open');
  await c.call('Input.insertText', { text });
  await c.key('Enter', 'Enter', 13);
  return Date.now();
}

async function waitFor(fn, ms, step = 100) {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return { ok: true, value: v, ms: Date.now() - t0 }; if (Date.now() - t0 > ms) return { ok: false, value: v, ms: Date.now() - t0 }; await sleep(step); }
}

(async () => {
  const receipt = { at: new Date().toISOString(), url: URL_, feed: FEED, checks: {} };
  const ok = (name, pass, detail) => { receipt.checks[name] = { pass: !!pass, detail }; console.log((pass ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 240) : '')); };

  const c = await attach((p) => /renderer\/index\.html/.test(p.url));
  await sleep(300);
  // Skip the tour on a fresh profile.
  await c.ev('(()=>{const s=document.getElementById("onboard-scrim");if(s&&!s.classList.contains("hidden"))document.getElementById("ob-skip").click();return 1})()');
  // Collect the Knot's notes and guard phases as they arrive.
  await c.ev(`(()=>{window.__fg=[];for(const ch of ['guide:hint','focus:guard'])window.nus.on(ch,p=>window.__fg.push({t:Date.now(),ch,p:p&&JSON.parse(JSON.stringify(p))}));return 1})()`);
  const settings = await c.ev('window.nus.settingsGet()');
  ok('settings: focus guard not switched off, feed in the list', settings.focusGuard !== false && (settings.focusGuardFeeds || []).some((f) => f.toLowerCase() === FEED.toLowerCase()), { focusGuard: settings.focusGuard, feeds: settings.focusGuardFeeds });

  // 1. a feed tab in the default browser, in front
  const before = feedWindows();
  spawn('cmd.exe', ['/c', 'start', '', URL_], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  const opened = await waitFor(() => { const w = feedWindows(); return w.length > before.length ? w : null; }, 8000, 250);
  ok('setup: a ' + FEED + ' tab is open in the browser', opened.ok, { windows: opened.value || feedWindows(), ms: opened.ms });
  if (!opened.ok) { console.log('Open ' + URL_ + ' in your browser by hand, leave it in front, and run again.'); c.close(); process.exit(2); }
  await sleep(1200);   // the page title settles; the browser is the foreground window

  // 2. start the guard by typing the phrase; the tab must go within 2 s
  const t0 = await tellKnot(c, 'keep me off ' + FEED.toLowerCase() + ' for 1 minute');
  const gone = await waitFor(() => (feedWindows().length === 0 ? Date.now() : null), CLOSE_BUDGET_MS + 1500, 100);
  const closedMs = gone.ok ? gone.value - t0 : null;
  ok('close: the ' + FEED + ' tab is gone within ' + CLOSE_BUDGET_MS + ' ms of Enter', gone.ok && closedMs <= CLOSE_BUDGET_MS, { ms: closedMs, left: feedWindows() });
  const evs = await c.ev('window.__fg');
  const startNote = evs.find((e) => e.ch === 'guide:hint' && /1 min\. Then you can have it back\./.test(e.p.text));
  const hop = evs.find((e) => e.ch === 'focus:guard' && e.p.phase === 'hop');
  const closedNote = evs.filter((e) => e.ch === 'guide:hint' && /Then you can have it back\./.test(e.p.text));
  ok('note: "1 min. Then you can have it back." shown', !!startNote, { ms: startNote ? startNote.t - t0 : null, notes: evs.filter((e) => e.ch === 'guide:hint').map((e) => e.p.text) });
  ok('knot: hopped to the window edge before the close', !!hop && (!gone.ok || hop.t <= gone.value), { hopMs: hop ? hop.t - t0 : null, rect: hop && hop.p.rect });
  ok('note: said it again on the close itself', closedNote.length >= 2, closedNote.map((e) => e.t - t0));
  const glow = await c.ev('({guard: document.getElementById("orb").dataset.guard, hint: document.getElementById("knot-hint").textContent, shown: !document.getElementById("knot-hint").classList.contains("hidden")})');
  ok('knot: coral while the guard is on', glow.guard === 'active', glow);
  await c.shot('01-guard-on');

  // 3. let me back: Done, green, and the tab comes back
  const t1 = await tellKnot(c, 'ok let me back');
  const done = await waitFor(async () => { const e = await c.ev('window.__fg'); return e.find((x) => x.ch === 'guide:hint' && x.p.text === 'Done. Go ahead.' && x.t >= t1) || null; }, 2500, 100);
  ok('end: "Done. Go ahead." within 2 s', done.ok, { ms: done.ok ? done.value.t - t1 : null });
  const glow2 = await c.ev('document.getElementById("orb").dataset.guard');
  ok('knot: green at the end', glow2 === 'done', glow2);
  await c.shot('02-guard-done');
  const back = await waitFor(() => { const w = feedWindows(); return w.length ? w : null; }, 6000, 250);
  ok('reopen: the ' + FEED + ' tab is back in the browser', back.ok, { ms: back.ms, windows: back.value || [] });
  await sleep(3000);
  const glow3 = await c.ev('document.getElementById("orb").dataset.guard');
  ok('knot: glow cleared after the beat', glow3 == null, glow3);
  // The guard is over: a feed in front now stays open.
  const still = feedWindows();
  await sleep(2500);
  ok('off: with the guard over, the reopened tab is left alone', feedWindows().length === still.length && still.length > 0, feedWindows());

  receipt.events = await c.ev('window.__fg');
  fs.writeFileSync(path.join(OUT, 'receipt.json'), JSON.stringify(receipt, null, 2));
  const fails = Object.entries(receipt.checks).filter(([, v]) => !v.pass).map(([k]) => k);
  console.log(fails.length ? 'FAILED: ' + fails.join(', ') : 'all checks passed');
  console.log('The reopened ' + FEED + ' tab is yours to close. Receipt and screenshots in ' + OUT);
  c.close();
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('verify-focus-guard: ' + e.message); process.exit(2); });
