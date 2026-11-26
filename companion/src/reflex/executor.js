// Carries out a decided action on Windows. Everything here is local and
// reversible: launch, open a URL, press a chord, type into the focused field.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { looksSensitive } = require('../memory');

const VK = { CTRL: 0x11, SHIFT: 0x10, ALT: 0x12, WIN: 0x5B, TAB: 0x09, LEFT: 0x25, UP: 0x26, RIGHT: 0x27, DOWN: 0x28, N: 0x4E, T: 0x54, W: 0x57, PRTSC: 0x2C, VOL_MUTE: 0xAD, VOL_DOWN: 0xAE, VOL_UP: 0xAF, PLAY: 0xB3 };

const CHORDS = {
  new_item: [[VK.CTRL, VK.N]],
  new_tab: [[VK.CTRL, VK.T]],
  close_tab: [[VK.CTRL, VK.W]],
  next_tab: [[VK.CTRL, VK.TAB]],
  snap_left: [[VK.WIN, VK.LEFT]],
  snap_right: [[VK.WIN, VK.RIGHT]],
  maximize: [[VK.WIN, VK.UP]],
  minimize: [[VK.WIN, VK.DOWN]],
  volume_up: [[VK.VOL_UP], [VK.VOL_UP], [VK.VOL_UP]],
  volume_down: [[VK.VOL_DOWN], [VK.VOL_DOWN], [VK.VOL_DOWN]],
  mute: [[VK.VOL_MUTE]],
  play_pause: [[VK.PLAY]],
  screenshot: [[VK.WIN, VK.PRTSC]]
};

// How far to turn it: "a bit", "a little", "a notch", "a touch" is one key
// press (2% on Windows), "a lot" or "way down" is five, anything else three.
const VOLUME_KEYS = new Set(['volume_up', 'volume_down']);
function volumePresses(clause) {
  const t = String(clause || '').toLowerCase();
  if (/\b(?:a (?:little|bit|notch|touch|tad|smidge)(?: bit)?|just a (?:little|bit|touch|notch|tad)|slightly|one notch|a hair)\b/.test(t)) return 1;
  if (/\b(?:a lot|lots|way (?:up|down)|way (?:louder|quieter|softer)|all the way|much (?:louder|quieter|softer))\b/.test(t)) return 5;
  return 3;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 'open chrome and search X' must search in Chrome, not in whatever the Windows
// default browser is (live 2026-09-21: Chrome opened, the search went to Firefox).
// The exe is looked up once in the registry's App Paths and started directly
// with the URL as its only argument: no shell, nothing to inject into.
const BROWSERS = [[/chrome/i, 'chrome.exe'], [/edge/i, 'msedge.exe'], [/firefox/i, 'firefox.exe'], [/brave/i, 'brave.exe'], [/^arc$/i, 'Arc.exe'], [/opera/i, 'opera.exe']];
const exeCache = new Map();
function browserExe(appName) {
  const hit = BROWSERS.find(([re]) => re.test(String(appName || '')));
  if (!hit) return null;
  const exe = hit[1];
  if (exeCache.has(exe)) return exeCache.get(exe);
  let found = null;
  for (const hive of ['HKCU', 'HKLM']) {
    if (found) break;
    try {
      const out = execFileSync('reg', ['query', hive + '\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\' + exe, '/ve'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      const m = /REG_SZ\s+(.+?)\s*$/m.exec(out);
      if (m && fs.existsSync(m[1].replace(/^"|"$/g, ''))) found = m[1].replace(/^"|"$/g, '');
    } catch (_) { /* not registered in this hive */ }
  }
  if (!found && process.env.LOCALAPPDATA) {
    const alias = path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', exe);
    if (fs.existsSync(alias)) found = alias;
  }
  exeCache.set(exe, found);
  return found;
}

function createExecutor({ probe, hands, shell, log, vaultDir, notesFile, spawnFn, refuseSite }) {
  // probe reads (foreground window); hands presses keys. Tests pass one fake for both.
  const keys = hands || probe;
  const say = log || (() => {});
  const start = spawnFn || spawn;

  async function fg() {
    try { return await probe.request('fg', { ignorePid: process.pid }, 1500); } catch (_) { return null; }
  }

  // Is the window in front the app that was asked for? "Google Chrome" runs as
  // chrome.exe, "Visual Studio Code" as Code.exe: compare squashed names both ways.
  function isApp(f, appName) {
    if (!f || !appName) return false;
    const sq = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const proc = sq(f.process); const title = sq(f.title); const name = sq(appName);
    if (!name) return false;
    if (proc && (name.includes(proc) || proc.includes(name))) return true;
    return title.includes(name);
  }

  // A launch has landed when the foreground window changes, OR when the window
  // in front already is the app (live 2026-09-21: Notepad was already focused,
  // nothing changed, the wait timed out after 3.5 s and "create a new note" was
  // skipped as unsafe). Returns the window, or null when time runs out.
  async function settle(beforeHwnd, maxMs, appName) {
    const t0 = Date.now();
    let pulled = false;
    while (Date.now() - t0 < maxMs) {
      const f = await fg();
      if (f && f.hwnd && f.hwnd !== beforeHwnd && (!appName || isApp(f, appName) || Date.now() - t0 > 1500)) { await sleep(180); return f; }
      // Give a real launch a moment to steal focus before trusting "already there".
      if (f && f.hwnd && Date.now() - t0 >= 350 && isApp(f, appName)) return f;
      // Already running but behind another window: Windows will not bring it
      // forward on a second launch. Pull it to the front once.
      if (!pulled && appName && Date.now() - t0 >= 600) {
        pulled = true;
        try {
          const r = await keys.request('win.activate', { name: appName }, 2500);
          if (r && r.ok) { say('[reflex] brought ' + appName + ' to the front'); await sleep(150); const g = await fg(); if (g && isApp(g, appName)) return g; }
        } catch (_) { /* older sidecar or no window yet: keep waiting */ }
      }
      await sleep(90);
    }
    return null;
  }

  function launch(appId) {
    // explorer resolves both classic shortcuts and Store app ids.
    const child = start('explorer.exe', ['shell:AppsFolder\\' + appId], { detached: true, stdio: 'ignore', windowsHide: true });
    if (child.on) child.on('error', (e) => say('[reflex] launch failed: ' + e.message));
    child.unref();
  }

  // In the browser the person just named when there is one, else the default.
  async function openUrl(url, browserApp) {
    const exe = browserExe(browserApp);
    if (exe && url.startsWith('https://')) {
      const child = start(exe, [url], { detached: true, stdio: 'ignore', windowsHide: false });
      // Store-packaged browsers can refuse a direct start: fall back to the default.
      if (child.on) child.on('error', () => { shell.openExternal(url).catch(() => {}); });
      child.unref();
      return exe;
    }
    await shell.openExternal(url);
    return 'default';
  }

  async function chords(list) {
    for (const combo of list) { await keys.request('keys.chord', { keys: combo }, 1500); await sleep(30); }
  }

  async function run(d) {
    const before = await fg();
    const beforeHwnd = before ? before.hwnd : 0;
    // The focus guard is on and this is what it keeps the person off.
    if (refuseSite && (d.intent === 'open_app' || d.intent === 'open_site')) {
      const line = refuseSite(d.intent === 'open_app' ? d.app.name : d.url);
      if (line) return { ok: false, refused: 'focus guard', line };
    }
    switch (d.intent) {
      case 'open_app':
        launch(d.app.appId);
        return { ok: true, settle: () => settle(beforeHwnd, 3500, d.app.name), target: d.app.name };
      case 'open_site':
        await openUrl(d.url, d.browserApp);
        return { ok: true, settle: () => settle(beforeHwnd, 2500, d.browserApp), target: d.url };
      case 'web_search':
        await openUrl(d.url || ('https://www.google.com/search?q=' + encodeURIComponent(d.text)), d.browserApp);
        return { ok: true, settle: () => settle(beforeHwnd, 2500, d.browserApp), target: 'search' };
      case 'type_text': {
        const r = await keys.request('keys.text', { text: d.text }, 4000);
        if (r && r.refused) return { ok: false, refused: r.refused };
        return { ok: Boolean(r && r.ok) };
      }
      case 'remember_note': {
        if (looksSensitive('note', d.text)) return { ok: false, refused: 'sensitive' };
        if (!vaultDir && !notesFile) return { ok: false, error: 'no notes destination' };
        const file = vaultDir ? path.join(vaultDir, 'notes', 'inbox', 'reflex-notes.md') : notesFile;
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, '- ' + new Date().toISOString().slice(0, 16).replace('T', ' ') + ' ' + d.text + '\n', 'utf8');
        return { ok: true, target: 'note' };
      }
      default:
        if (VOLUME_KEYS.has(d.intent)) {
          const n = volumePresses(d.clause);
          await chords(Array.from({ length: n }, () => CHORDS[d.intent][0]));
          return { ok: true, presses: n };
        }
        if (CHORDS[d.intent]) { await chords(CHORDS[d.intent]); return { ok: true }; }
        say('[reflex] no executor for ' + d.intent);
        return { ok: false, error: 'unhandled' };
    }
  }

  return { run, fg };
}

// BROWSERS is shared with the focus guard: a feed title counts only in one of these.
module.exports = { createExecutor, browserExe, volumePresses, CHORDS, VK, BROWSERS };
