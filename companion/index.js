// Nūs Companion: the on-screen overlay, running as a second BrowserWindow
// inside the Nūs desktop process. Converted from the standalone jarvis-copilot
// app; the desktop main owns the Electron lifecycle and passes hooks so
// sessions, transcripts, and answers land in the desktop database.
const { BrowserWindow, ipcMain, globalShortcut, screen, session, desktopCapturer, shell, Tray, Menu, app } = require('electron');
const path = require('path');
const fs = require('fs');
const store = require('./src/store');
const { captureScreenshot } = require('./src/screen');
const { createSTT } = require('./src/stt');
const { createLLM } = require('./src/llm');
const { MODES } = require('./src/prompts');
const { appendResumeContext } = require('./src/profile-context');
const { loadPack, appendPack, extractNumbers, extractCard } = require('./src/context-pack');
const { rms16, pcmToWav } = require('./src/wav');
const { loadNusContext, appendNusContext, renderNusSummary } = require('./src/nus-context');
const { appendEvent } = require('./src/nus-outbox');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const DEBUG = false;

let win = null;
let tray = null;
let registeredAssistShortcut = null;
let hooks = {};
const NUS_CONTEXT_FILE = path.join(app.getPath('appData'), 'Nus', 'context.json');

const DEFAULT_ASSIST_SHORTCUT = 'CommandOrControl+Return';
const RESERVED_SHORTCUTS = new Set([
  'commandorcontrol+h',
  'commandorcontrol+shift+x',
  'commandorcontrol+shift+o',
  'commandorcontrol+shift+n',
  'commandorcontrol+shift+r',
  'commandorcontrol+shift+d',
  'commandorcontrol+shift+k',
  'commandorcontrol+shift+space'
]);

// -------- capture / transcript state --------
const state = { capturing: false, busy: false, transcribing: { you: false, them: false } };
let sttDisabled = false;
const buffers = { you: [], them: [] };
const transcript = []; // { channel, text, ts } working tail for prompts; durable copy goes through hooks
let sessionId = null;  // current desktop-db session, null when not capturing
let audioDir = null;   // per-session audio folder when saveAudio is on

const FLUSH_MS = 6000;
const MIN_BYTES = Math.floor(16000 * 2 * 0.6);
const RMS_GATE = 240;
let flushTimer = null;

let sttBackoffUntil = 0;
let sttTransientFailures = 0;
const STT_BACKOFF_MAX_MS = 60000;

// -------- rehearsal state --------
let sparTurns = [];
let sparActive = false;
const SPAR_MAX_TURNS = 40;

function send(channel, data) { if (win && !win.isDestroyed()) win.webContents.send(channel, data); }

// What the Companion knows about the app it lives in. Answers to "where is X"
// come from here, never from squinting at a screenshot.
const APP_GUIDE = 'APP GUIDE (answer questions about Nus from this, not from the screenshot): ' +
  'The dashboard is the Today tab, rail item 01 in the Nus desktop app. If its window is closed I am still running: click the Nus tray icon and choose "Open Nus dashboard". ' +
  'Talking to Nus: a full chat thread lives in the desktop app under Knot > Companion. It answers questions and can create tasks, move due dates, and draft emails, each with a Confirm step before anything is written. The Ask bar on the Today tab takes one-shot requests from anywhere. ' +
  'Email has its own tab in the rail. Gmail needs no connection at all: open the Email tab, add the address you send from under "Gmail and your addresses", fill the professor email form, press "Draft email", then press "Open in Gmail" and the finished draft opens in a Gmail compose window signed in as that address, where the student presses send. Outlook is a separate optional connection and is read-only until they opt in to sending. ' +
  'Map = rail item 02 (drag the canvas, scroll to zoom). Syllabus import = the Import button, always reviewed before saving. My capture sessions = Knot > History, uploadable to the vault. Automations and Integrations = the Connections tab. ' +
  'Keys, two of them and they are different: the DESKTOP app uses Claude, either Claude Code if it is installed or an Anthropic API key pasted in desktop Settings > AI provider. I, the Companion, use my OWN key, normally a free Google Gemini key from aistudio.google.com/apikey, pasted either in desktop Settings > "Companion AI key" (the card directly below the AI provider one) or through my gear icon in this command sheet. One Gemini key covers both my answers and speech-to-text for listening. The GPA scale for semester setup is in desktop Settings, the Data section. ' +
  'Hotkeys: Ctrl+Shift+Space hides or shows me, Ctrl+Shift+K hides just the Knot mark, Ctrl+Shift+X stops listening and vanishes. I keep running after the dashboard closes and the hotkeys keep working. "Turn off Companion" on the Knot > Companion pane removes me completely and releases the hotkeys until turned back on there.';

// -------- window --------
function createOverlayWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const W = 600, H = workArea.height;
  win = new BrowserWindow({
    width: W,
    height: H,
    x: workArea.x,
    y: workArea.y,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  const noProtect = process.env.JARVIS_NO_PROTECT || process.env.NUS_NO_PROTECT;
  win.setContentProtection(!noProtect);
  if (process.platform === 'darwin') {
    win.setAlwaysOnTop(true, 'screen-saver', 1);
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    if (typeof win.setHiddenInMissionControl === 'function') win.setHiddenInMissionControl(true);
  } else {
    win.setAlwaysOnTop(true);
  }

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('did-finish-load', () => {
    win.showInactive();
    // Restore the persisted Knot-mark visibility so Ctrl+Shift+K survives restarts.
    send('knot:set', { hidden: store.getSettings().knotHidden === true });
  });
  win.webContents.on('render-process-gone', (_e, d) => console.log('[nus] overlay renderer gone', JSON.stringify(d)));
}

// -------- audio retention (opt-in) --------
function appendSessionAudio(channel, pcm) {
  if (!audioDir) return;
  try { fs.appendFileSync(path.join(audioDir, channel + '.pcm'), pcm); } catch (_) { /* never block capture on disk */ }
}

function finalizeSessionAudio() {
  if (!audioDir) return null;
  const dir = audioDir;
  audioDir = null;
  try {
    for (const channel of ['you', 'them']) {
      const raw = path.join(dir, channel + '.pcm');
      if (!fs.existsSync(raw)) continue;
      const pcm = fs.readFileSync(raw);
      if (pcm.length) fs.writeFileSync(path.join(dir, channel + '.wav'), pcmToWav(pcm));
      fs.unlinkSync(raw);
    }
    return dir;
  } catch (e) {
    console.log('[companion] audio finalize failed:', e.message);
    return dir;
  }
}

// Delete retained audio older than the retention window. Called once at init.
function cleanupRetainedAudio(root, days) {
  try {
    if (!fs.existsSync(root)) return;
    const cutoff = Date.now() - days * 86400000;
    for (const name of fs.readdirSync(root)) {
      const dir = path.join(root, name);
      try {
        if (fs.statSync(dir).mtimeMs < cutoff) fs.rmSync(dir, { recursive: true, force: true });
      } catch (_) { /* skip */ }
    }
  } catch (_) { /* retention cleanup is best-effort */ }
}

// -------- STT flushing --------
async function flushChannel(channel) {
  if (state.transcribing[channel]) return;
  if (Date.now() < sttBackoffUntil) return;
  const chunks = buffers[channel];
  if (!chunks.length) return;
  const pcm = Buffer.concat(chunks);
  buffers[channel] = [];
  if (pcm.length < MIN_BYTES) return;
  if (rms16(pcm) < RMS_GATE) return;

  // Voice-activated audio log: only speech that passes the gates is retained,
  // so the WAV is shorter than wall-clock time by design.
  appendSessionAudio(channel, pcm);

  state.transcribing[channel] = true;
  try {
    const settings = store.getSettings();
    const stt = createSTT(settings);
    if (!stt.available) {
      if (!sttDisabled) { sttDisabled = true; send('status', { message: 'No transcription key set. Add an OpenAI (Whisper) or Gemini key in Settings to enable listening. Screen/LeetCode features work without it.' }); }
      return;
    }
    const res = await stt.transcribe(pcm);
    if (res.error) {
      handleSttError(res.error, settings);
      return;
    }
    sttTransientFailures = 0;
    if (res.text && res.text.trim()) {
      const turn = { channel, text: res.text.trim(), ts: Date.now() };
      transcript.push(turn);
      if (sessionId && hooks.onMessage) hooks.onMessage(sessionId, turn);
      send('transcript', turn);
    }
  } catch (e) {
    console.log('[stt] error', e && e.message);
  } finally {
    state.transcribing[channel] = false;
  }
}

function handleSttError(err) {
  console.log('[stt] error', err.provider, err.status, err.code, err.message);
  const transient =
    err.status === 429 || err.status === 408 || (err.status >= 500 && err.status < 600) ||
    /rate.?limit|quota|overload|timeout|ECONNRESET|ETIMEDOUT|fetch failed/i.test(err.message || '');

  if (transient) {
    sttTransientFailures += 1;
    const wait = Math.min(STT_BACKOFF_MAX_MS, 5000 * Math.pow(2, sttTransientFailures - 1));
    sttBackoffUntil = Date.now() + wait;
    if (sttTransientFailures === 1 || sttTransientFailures % 4 === 0) {
      send('status', {
        message: 'Transcription is being rate limited (' + err.provider + '). ' +
          'Pausing ' + Math.round(wait / 1000) + 's, then resuming automatically.'
      });
    }
    return;
  }

  if (sttDisabled) return;
  const noAccess = err.status === 403 || err.status === 401 || err.code === 'model_not_found';
  sttDisabled = true;
  if (noAccess) {
    send('status', { message: 'Transcription off: your ' + err.provider + ' key has no access to a speech-to-text model (' + (err.status || err.code) + '). Screen features still work. To enable listening: give the key transcription access, or add a Gemini key in Settings and reopen.' });
  } else {
    send('status', { message: 'Transcription error (' + err.provider + '): ' + err.message });
  }
}

function startFlushLoop() {
  if (flushTimer) return;
  flushTimer = setInterval(() => { flushChannel('you'); flushChannel('them'); }, FLUSH_MS);
}
function stopFlushLoop() { if (flushTimer) { clearInterval(flushTimer); flushTimer = null; } }

// -------- capture toggle --------
function setCapturing(active) {
  if (active === state.capturing) return active;
  state.capturing = active;
  const settings = store.getSettings();
  if (active) {
    // Open a durable session in the desktop database.
    const packName = settings.packPath ? path.basename(path.dirname(settings.packPath)) : '';
    if (hooks.onSessionStart) {
      sessionId = hooks.onSessionStart({ pack: packName, started_at: new Date().toISOString() });
      if (sessionId && settings.saveAudio && hooks.audioRoot) {
        try {
          audioDir = path.join(hooks.audioRoot(), String(sessionId));
          fs.mkdirSync(audioDir, { recursive: true });
        } catch (_) { audioDir = null; }
      }
    }
    startFlushLoop();
  } else {
    stopFlushLoop();
    // Flush what's left so the tail of the conversation isn't dropped.
    flushChannel('you'); flushChannel('them');
    buffers.you = []; buffers.them = [];
    const dir = finalizeSessionAudio();
    if (sessionId && hooks.onSessionEnd) {
      hooks.onSessionEnd(sessionId, { ended_at: new Date().toISOString(), audio_path: dir || '' });
    }
    sessionId = null;
  }
  send('capture:state', { active });
  updateTrayMenu();
  return active;
}

// -------- pack helpers --------
function packFor(def, settings) {
  if (!def.pack) return { text: '', error: null };
  const p = def.pack === 'spar' ? settings.sparPath : settings.packPath;
  const res = loadPack(p);
  if (res.error) return { text: '', error: res.error };
  return { text: res.text, error: null };
}

function packStatus() {
  const s = store.getSettings();
  const live = loadPack(s.packPath);
  const spar = loadPack(s.sparPath);
  return {
    live: { path: s.packPath || '', ok: !!live.text, chars: live.text.length, error: live.error },
    spar: { path: s.sparPath || '', ok: !!spar.text, chars: spar.text.length, error: spar.error }
  };
}

// -------- feature runner --------
async function runFeature(mode, userText) {
  if (state.busy) { send('llm:busy', {}); return; }
  const def = MODES[mode];
  if (!def) return;

  const settings = store.getSettings();

  // Live desktop snapshot: same process, no file round-trip. The file stays
  // as the cold-start fallback.
  const desktopSnapshot = () => {
    try { if (hooks.getDesktopState) return hooks.getDesktopState(); } catch (_) { /* fall through */ }
    const fromFile = loadNusContext(NUS_CONTEXT_FILE);
    return fromFile.ok ? fromFile.context : null;
  };

  // The guide mode answers "what should I do" from the semester snapshot.
  // With no provider key (or provider-sharing off) it renders locally: the
  // ranked next_moves ARE the answer, no model required.
  if (mode === 'guide') {
    const snapshot = desktopSnapshot();
    const llm = createLLM(settings);
    const useProvider = llm.ready && settings.shareNusContextWithProvider === true;
    if (!useProvider) {
      send('llm:start', { userBubble: userText || 'What should I do?', small: false });
      if (!snapshot) {
        send('llm:error', { message: 'Open the Nūs desktop app once so I can see your semester.' });
        return;
      }
      const moves = (snapshot.next_moves || []).slice(0, 5);
      const local = moves.length
        ? 'Next moves, ranked:\n' + moves.map((m, i) => `${i + 1}. ${m.title}${m.due_date ? ' (due ' + m.due_date + ')' : ''}${m.reason ? '. ' + m.reason : ''}`).join('\n')
        : 'Nothing ranked yet. Import a syllabus or add a smart task in the desktop app and I will have a real answer.';
      send('llm:token', { text: local });
      send('llm:done', {});
      return;
    }
    // Provider path continues below with the snapshot appended.
  }

  if (def.local) {
    const { text, error } = packFor(def, settings);
    send('llm:start', { userBubble: def.userBubble || null, small: !!def.small });
    if (error || !text) {
      send('llm:error', { message: error || 'No briefing pack set. Add one in Settings (gear icon).' });
      return;
    }
    const block = def.local === 'numbers' ? extractNumbers(text) : extractCard(text);
    if (!block) {
      send('llm:error', { message: 'The pack has no "' + def.local + '" block. Rebuild it with scripts/build_briefing.py.' });
      return;
    }
    send('llm:token', { text: block });
    send('llm:done', {});
    return;
  }

  state.busy = true;
  notifyDesktopState();
  try {
    const llm = createLLM(settings);
    const userBubble = def.userBubble !== null ? def.userBubble : (mode === 'ask' || mode === 'spar' ? userText : null);
    send('llm:start', { userBubble, small: !!def.small });

    if (!llm.ready) {
      send('llm:error', { message: 'Add your ' + settings.provider + ' API key in Settings (gear icon) to start. Model: ' + (llm.model || 'unset') + '.' });
      return;
    }

    let imageDataUrl = null;
    if (def.needsScreen) {
      try { imageDataUrl = await captureScreenshot(); }
      catch (e) {
        send('status', { message: 'Screen capture needs permission. Grant Screen Recording to Nūs in System Settings.' });
      }
    }

    const { text: packText, error: packError } = packFor(def, settings);
    if (packError) send('status', { message: packError });
    let system = appendResumeContext(def.system, settings.resumeContext);
    // Questions about Nus itself arrive in whatever mode the user happens to be
    // in, usually by typing rather than pressing the guide button. Reading the
    // answer off a screenshot is guesswork, so the guide travels with ask too.
    if (mode === 'guide' || mode === 'assist' || mode === 'ask') {
      const snapshot = desktopSnapshot();
      if (snapshot) system = appendNusContext(system, snapshot);
      system += '\n\n' + APP_GUIDE;
    } else if (settings.shareNusContextWithProvider === true) {
      const sharedNus = loadNusContext(NUS_CONTEXT_FILE);
      if (sharedNus.ok) system = appendNusContext(system, sharedNus.context);
    }
    if (packText) {
      system = appendPack(system, packText, {
        label: def.pack === 'spar' ? 'REHEARSAL EVIDENCE PACK' : 'BRIEFING PACK'
      });
    }

    let turns;
    if (def.multiTurn) {
      const built = def.build({ transcript, userText: userText || '' });
      sparTurns.push({ role: 'user', text: built });
      if (sparTurns.length > SPAR_MAX_TURNS) sparTurns = sparTurns.slice(-SPAR_MAX_TURNS);
      turns = sparTurns.slice();
    } else if (mode === 'score') {
      const spoken = sparTurns
        .map((t) => (t.role === 'user' ? 'You: ' : 'Them: ') + t.text)
        .join('\n');
      turns = [{ role: 'user', text: def.build({ transcript, userText: spoken }) }];
    } else {
      turns = [{ role: 'user', text: def.build({ transcript, userText: userText || '' }) }];
    }

    // A typed question is part of the session record too.
    if (sessionId && hooks.onMessage && userText && userText.trim()) {
      hooks.onMessage(sessionId, { channel: 'you', text: userText.trim(), ts: Date.now(), mode });
    }

    const fullText = await llm.stream({
      system,
      turns,
      imageDataUrl,
      onToken: (t) => send('llm:token', { text: t })
    });

    if (def.multiTurn && fullText) {
      sparTurns.push({ role: 'assistant', text: fullText });
      if (!sparActive) { sparActive = true; send('spar:state', { active: true }); }
    }

    if (fullText && sessionId && hooks.onMessage) {
      hooks.onMessage(sessionId, { channel: 'nus', text: fullText, ts: Date.now(), mode, used_screenshot: Boolean(imageDataUrl) });
    }
    if (fullText && settings.reportToNus === true) {
      appendEvent(app.getPath('appData'), {
        mode,
        used_screenshot: Boolean(imageDataUrl),
        answer: fullText,
        transcript_tail: transcript.slice(-6).map((t) => `${t.channel}: ${t.text}`).join('\n'),
      });
      if (hooks.onOutboxEvent) hooks.onOutboxEvent();
    }
    send('llm:done', {});
  } catch (e) {
    send('llm:error', { message: 'Error: ' + (e && e.message ? e.message : String(e)) });
  } finally {
    state.busy = false;
    notifyDesktopState();
  }
}

// -------- deep vault query --------
function deepQuery(text) {
  const settings = store.getSettings();
  const target = settings.deepQueryUrl;
  return new Promise((resolve) => {
    if (!target || !text || !text.trim()) {
      return resolve({ ok: false, error: 'Nothing to ask, or no deep-query URL set.' });
    }
    let url;
    try { url = new URL(target); } catch (_) {
      return resolve({ ok: false, error: 'Deep-query URL is not valid: ' + target });
    }
    const body = JSON.stringify({ text: text, voice: false, fast: false });
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 120000
    }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(out);
          if (parsed.reply) return resolve({ ok: true, reply: parsed.reply });
          resolve({ ok: false, error: parsed.error || 'Your Jarvis vault server returned no reply.' });
        } catch (_) {
          resolve({ ok: false, error: 'Could not parse the Jarvis vault server response.' });
        }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'Deep query timed out.' }); });
    req.on('error', (e) => resolve({
      ok: false,
      error: 'Jarvis vault server unreachable at ' + target + ' (' + e.message + '). Start it with scripts/start_jarvis.bat.'
    }));
    req.write(body);
    req.end();
  });
}

async function runDeepQuery(text) {
  if (state.busy) return;
  state.busy = true;
  notifyDesktopState();
  send('llm:start', { userBubble: text || 'Ask the vault', small: false });
  send('llm:token', { text: '_Asking the full vault, this takes 15 to 30 seconds..._\n\n' });
  try {
    const res = await deepQuery(text);
    if (res.ok) send('llm:token', { text: res.reply });
    else send('llm:error', { message: res.error });
    send('llm:done', {});
  } finally {
    state.busy = false;
    notifyDesktopState();
  }
}

// -------- shortcuts --------
function normalizeShortcut(accelerator) {
  return typeof accelerator === 'string' ? accelerator.trim().replace(/\s+/g, '') : '';
}

function registerAssistShortcut(accelerator) {
  const next = normalizeShortcut(accelerator) || DEFAULT_ASSIST_SHORTCUT;
  if (next.length > 80) return { ok: false, error: 'That shortcut is too long.' };
  if (RESERVED_SHORTCUTS.has(next.toLowerCase())) {
    return { ok: false, error: 'That shortcut is reserved by another Nūs action.' };
  }

  const previous = registeredAssistShortcut;
  if (previous) globalShortcut.unregister(previous);

  try {
    if (!globalShortcut.register(next, () => runFeature('assist', ''))) {
      if (previous) globalShortcut.register(previous, () => runFeature('assist', ''));
      return { ok: false, error: 'That shortcut is already in use by another application.' };
    }
  } catch (_) {
    if (previous) globalShortcut.register(previous, () => runFeature('assist', ''));
    return { ok: false, error: 'That key combination is not a valid global shortcut.' };
  }

  registeredAssistShortcut = next;
  return { ok: true, accelerator: next };
}

function setAssistShortcut(accelerator) {
  const result = registerAssistShortcut(accelerator);
  if (result.ok) store.setSettings({ shortcuts: { assist: result.accelerator } });
  return result;
}

// -------- visibility levels --------
// Level 1: normal. Level 2 (Ctrl+Shift+K): Knot mark hidden, panel still works.
// Level 3 (Ctrl+Shift+Space): window hidden; with the stealth setting on, the
// tray hides too and nothing on screen shows the Companion exists. The desktop
// app's Companion pane is the always-available way back.
function destroyTray() { if (tray) { tray.destroy(); tray = null; } }

function toggleOverlay() {
  if (!win || win.isDestroyed()) return;
  const settings = store.getSettings();
  if (win.isVisible()) {
    win.hide();
    if (settings.stealth === true) destroyTray();
  } else {
    win.showInactive();
    if (!tray) createTray();
  }
  updateTrayMenu();
  notifyDesktopState();
}

function forceShow() {
  // Showing a Companion the user turned off turns it back on, shortcuts and
  // tray included, rather than half-reviving a window with no way to drive it.
  if (store.getSettings().companionEnabled === false) return enableCompanion();
  if (!win || win.isDestroyed()) createOverlayWindow();
  else win.showInactive();
  if (!tray) createTray();
  updateTrayMenu();
  notifyDesktopState();
  return companionStatus();
}

// Panic key: stop listening and vanish in one stroke.
function panicHide() {
  setCapturing(false);
  if (win && !win.isDestroyed() && win.isVisible()) win.hide();
  const settings = store.getSettings();
  if (settings.stealth === true) destroyTray();
  updateTrayMenu();
  notifyDesktopState();
}

function toggleKnot() {
  const hidden = !(store.getSettings().knotHidden === true);
  store.setSettings({ knotHidden: hidden });
  send('knot:set', { hidden });
  notifyDesktopState();
}

function companionStatus() {
  return {
    running: Boolean(win && !win.isDestroyed()),
    visible: Boolean(win && !win.isDestroyed() && win.isVisible()),
    capturing: state.capturing,
    busy: Boolean(state.busy),
    knotHidden: store.getSettings().knotHidden === true,
    enabled: store.getSettings().companionEnabled !== false,
    stealth: store.getSettings().stealth === true,
    tray: Boolean(tray),
    sessionId,
  };
}

// Remove the Companion entirely: capture stops, the hotkeys are released back
// to the OS, the tray icon and overlay window go away, and the choice is
// remembered so it does not return on the next launch. Nothing else about Nus
// is affected, and the desktop Knot pane can bring it back.
function disableCompanion() {
  setCapturing(false);
  store.setSettings({ companionEnabled: false });
  try { globalShortcut.unregisterAll(); } catch {}
  registeredAssistShortcut = null;
  stopCursorProbe();
  destroyTray();
  if (win && !win.isDestroyed()) win.destroy();
  win = null;
  notifyDesktopState();
  return companionStatus();
}

function enableCompanion() {
  store.setSettings({ companionEnabled: true });
  if (!win || win.isDestroyed()) createOverlayWindow();
  else win.showInactive();
  registerShortcuts();
  if (!tray) createTray();
  updateTrayMenu();
  startCursorProbe();
  notifyDesktopState();
  return companionStatus();
}

function notifyDesktopState() {
  if (hooks.onStateChange) hooks.onStateChange(companionStatus());
}

// -------- tray --------
function updateTrayMenu() {
  if (!tray) return;
  const visible = win && !win.isDestroyed() && win.isVisible();
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: visible ? 'Hide overlay' : 'Show overlay', click: toggleOverlay },
    { label: state.capturing ? 'Stop listening' : 'Start listening', click: () => { setCapturing(!state.capturing); } },
    { type: 'separator' },
    { label: 'Open Nūs dashboard', click: () => { if (hooks.showDesktop) hooks.showDesktop(); } },
    { type: 'separator' },
    { label: 'Quit Nūs', click: () => app.quit() },
  ]));
  tray.setToolTip(`Nūs Companion, ${visible ? 'on screen' : 'hidden'} (Ctrl+Shift+Space)`);
}

function createTray() {
  try {
    tray = new Tray(path.join(__dirname, 'tray-icon.png'));
    tray.on('click', toggleOverlay);
    updateTrayMenu();
  } catch (e) {
    console.log('[nus] tray unavailable:', e.message);
  }
}

function registerShortcuts() {
  globalShortcut.register('CommandOrControl+H', () => runFeature('leetcode', ''));
  globalShortcut.register('CommandOrControl+Shift+X', panicHide);
  globalShortcut.register('CommandOrControl+Shift+Space', toggleOverlay);
  globalShortcut.register('CommandOrControl+Shift+K', toggleKnot);

  const extras = [
    ['CommandOrControl+Shift+O', () => runFeature('objection', '')],
    ['CommandOrControl+Shift+N', () => runFeature('numbers', '')],
    ['CommandOrControl+Shift+R', () => runFeature('spar', '')]
  ];
  for (const [accel, fn] of extras) {
    try {
      if (!globalShortcut.register(accel, fn)) {
        console.log('[nus] shortcut in use by another app, skipped:', accel);
      }
    } catch (_) {
      console.log('[nus] invalid shortcut, skipped:', accel);
    }
  }

  const settings = store.getSettings();
  const configured = settings.shortcuts && settings.shortcuts.assist;
  const result = registerAssistShortcut(configured || DEFAULT_ASSIST_SHORTCUT);
  if (!result.ok && configured && configured !== DEFAULT_ASSIST_SHORTCUT) {
    console.log('[nus] unable to register Assist shortcut:', result.error, 'Falling back to default.');
    const fallback = registerAssistShortcut(DEFAULT_ASSIST_SHORTCUT);
    if (fallback.ok) store.setSettings({ shortcuts: { assist: DEFAULT_ASSIST_SHORTCUT } });
  }
}

// -------- IPC (namespaced companion:*) --------
function registerIpc() {
  ipcMain.handle('companion:settings:get', () => ({ ...store.getSettings(), _migrationNote: store.migrationNote() }));
  ipcMain.handle('companion:settings:set', (_e, patch) => { sttDisabled = false; return store.setSettings(patch); });
  ipcMain.handle('companion:shortcut:assist:set', (_e, accelerator) => setAssistShortcut(accelerator));
  ipcMain.handle('companion:capture:toggle', () => setCapturing(!state.capturing));
  ipcMain.handle('companion:capture:state', () => ({ active: state.capturing }));
  ipcMain.handle('companion:pack:status', () => packStatus());
  ipcMain.handle('companion:desktop:tour', () => {
    if (hooks.showDesktop) hooks.showDesktop();
    if (hooks.startDesktopTour) hooks.startDesktopTour();
    return { ok: true };
  });
  ipcMain.handle('companion:ai:ready', () => {
    const settings = store.getSettings();
    const llm = createLLM(settings);
    return llm.ready
      ? { ok: true }
      : { ok: false, message: 'Add your ' + settings.provider + ' API key in Settings (gear icon) to start. Model: ' + (llm.model || 'unset') + '.' };
  });
  ipcMain.handle('companion:nus-context:status', () => {
    const result = loadNusContext(NUS_CONTEXT_FILE);
    return { ok: result.ok, path: result.path, updatedAt: result.updatedAt, error: result.error };
  });
  ipcMain.handle('companion:spar:reset', () => {
    sparTurns = [];
    sparActive = false;
    send('spar:state', { active: false });
    return { active: false };
  });
  ipcMain.handle('companion:deep:query', (_e, text) => runDeepQuery(text));
  ipcMain.on('companion:ask', (_e, payload) => runFeature(payload.mode, payload.text));
  ipcMain.on('companion:mic:pcm', (_e, arrayBuffer) => { if (state.capturing) buffers.you.push(Buffer.from(arrayBuffer)); });
  ipcMain.on('companion:system:pcm', (_e, arrayBuffer) => { if (state.capturing) buffers.them.push(Buffer.from(arrayBuffer)); });
  ipcMain.on('companion:mouse:ignore', (_e, v) => { if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(!!v, { forward: true }); });
  ipcMain.on('companion:open-pane', (_e, url) => {
    if (typeof url !== 'string') return;
    if (url.startsWith('x-apple.systempreferences:') || url.startsWith('https://')) {
      shell.openExternal(url).catch(() => {});
    }
  });
  ipcMain.on('companion:log', (_e, msg) => console.log('[companion]', msg));
}

// Windows click-through probe: while transparent + click-through, mouse-move
// forwarding is unreliable, so poll the cursor from main and let the renderer
// answer through companion:mouse:ignore. Skipped while the overlay is hidden.
let cursorProbeTimer = null;
function startCursorProbe() {
  if (cursorProbeTimer) return; // never stack probes across enable/disable
  cursorProbeTimer = setInterval(() => {
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    const p = screen.getCursorScreenPoint();
    const b = win.getBounds();
    const inside = p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
    if (!inside) return;
    send('cursor:probe', { x: p.x - b.x, y: p.y - b.y });
  }, 120);
}
function stopCursorProbe() {
  if (cursorProbeTimer) { clearInterval(cursorProbeTimer); cursorProbeTimer = null; }
}

// -------- init --------
// Called by the desktop main after app.whenReady(). `providedHooks`:
//   onSessionStart(meta) -> sessionId     durable session opened in the db
//   onSessionEnd(sessionId, meta)         session closed (ended_at, audio_path)
//   onMessage(sessionId, turn)            each transcript line / question / answer
//   onStateChange(status)                 visibility/capture changes, for the desktop UI
//   onOutboxEvent()                       an outbox event was appended (live ingest)
//   audioRoot() -> path                   folder for opt-in retained audio
//   showDesktop()                         focus/reopen the desktop window
function initCompanion(providedHooks = {}) {
  hooks = providedHooks;

  const allowMedia = (permission) => permission === 'media' || permission === 'microphone' || permission === 'audioCapture' || permission === 'display-capture';
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(allowMedia(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowMedia(permission));
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      if (sources.length) callback({ video: sources[0], audio: 'loopback' });
      else callback();
    }).catch(() => callback());
  }, { useSystemPicker: false });

  const settings = store.getSettings();
  if (hooks.audioRoot) cleanupRetainedAudio(hooks.audioRoot(), Number(settings.audioRetentionDays) || 30);

  // IPC is always registered (the handlers are inert without a window), but a
  // Companion the user turned off stays off across launches until they turn it
  // back on from the desktop Knot pane.
  registerIpc();
  if (settings.companionEnabled !== false) {
    createOverlayWindow();
    registerShortcuts();
    createTray();
    startCursorProbe();
  }

  return {
    show: forceShow,
    startTour: () => { forceShow(); send('tour:start', {}); return companionStatus(); },
    hide: () => { if (win && !win.isDestroyed() && win.isVisible()) toggleOverlay(); return companionStatus(); },
    toggle: () => { toggleOverlay(); return companionStatus(); },
    panic: () => { panicHide(); return companionStatus(); },
    toggleKnot,
    setCapturing: (v) => { setCapturing(Boolean(v)); return companionStatus(); },
    isCapturing: () => state.capturing,
    isEnabled: () => store.getSettings().companionEnabled !== false,
    disable: disableCompanion,
    enable: enableCompanion,
    status: companionStatus,
    unregisterShortcuts: () => globalShortcut.unregisterAll(),
  };
}

module.exports = { initCompanion };
