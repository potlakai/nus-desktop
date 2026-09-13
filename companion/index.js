// Nūs Companion: the on-screen overlay, running as a second BrowserWindow
// inside the Nūs desktop process. Converted from the standalone jarvis-copilot
// app; the desktop main owns the Electron lifecycle and passes hooks so
// sessions, transcripts, and answers land in the desktop database.
const { BrowserWindow, ipcMain, globalShortcut, screen, session, desktopCapturer, shell, Tray, Menu, app, nativeImage } = require('electron');
const IS_MAC = process.platform === 'darwin';
// The shortcuts are CommandOrControl; the labels should say what the key is.
const HOTKEY_MOD = IS_MAC ? '⌘' : 'Ctrl';
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
const { createProbe } = require('./src/win/probe');
const { GuideSession } = require('./src/guide/session');
const { createWalkthroughs } = require('./src/guide/walkthroughs');
const { createProactive } = require('./src/proactive');
const { cleanTranscript, classifyUtterance, partialWindow, PARTIAL_WINDOW_S } = require('./src/guide/voice');
const { bitmapHash } = require('./src/guide/verify');
const { sensitiveTarget } = require('./src/guide/sensitive');
const { buildCompanionContext } = require('./src/companion-context');
const { captureDisplay } = require('./src/screen');
const { registerInspectionShortcut, resolveInspectionHit, pointContext } = require('./src/inspection-input');
const { cropSelection, sameApp, claudeClient, answerSelection, describeClaudeError } = require('./src/selected-assistance');
const http = require('http');
const https = require('https');
const { URL, pathToFileURL } = require('url');

const DEBUG = false;

let win = null;
let overlayUserHidden = false;
let overlayRecoveryTimer = null;
let overlayRecoveryAttempts = 0;
const voiceTurns = []; // Session-only; never automatically saved as memory.
const askTurns = []; // Session-only conversation, separate from durable Keep.
const inspectionTurns = []; // Claude-only context; never added to another provider's ask history.
let featureAbort = null;
let inspectionShortcutStatus = { ok: false, error: 'Pointing shortcut has not registered yet.' };
function ensureInspectionShortcut() {
  inspectionShortcutStatus = registerInspectionShortcut(globalShortcut, inspectAtCursor);
  if (!inspectionShortcutStatus.ok) console.log('[inspect] ' + inspectionShortcutStatus.error);
  return inspectionShortcutStatus;
}
function cancelFeature() {
  featureAbort?.abort();
  clearInspection();
  state.busy = false;
  send('llm:cancelled', {});
}
let tray = null;
let registeredAssistShortcut = null;
let hooks = {};
const NUS_CONTEXT_FILE = path.join(app.getPath('userData'), 'context.json');
const TRUSTED_COMPANION_URL = pathToFileURL(path.join(__dirname, 'renderer', 'index.html')).href;
// The desktop dashboard gets microphone access for Knot voice chat, and only
// that: display-capture stays companion-only.
const TRUSTED_DESKTOP_URL = pathToFileURL(path.join(__dirname, '..', 'renderer', 'index.html')).href;

function isTrustedCompanionUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    parsed.search = '';
    parsed.hash = '';
    return parsed.href === TRUSTED_COMPANION_URL;
  } catch { return false; }
}

function isTrustedCompanionWebContents(webContents) {
  return Boolean(webContents && !webContents.isDestroyed?.() && isTrustedCompanionUrl(webContents.getURL?.()));
}

function isTrustedDesktopWebContents(webContents) {
  try {
    if (!webContents || webContents.isDestroyed?.()) return false;
    const parsed = new URL(String(webContents.getURL?.() || ''));
    parsed.search = '';
    parsed.hash = '';
    return parsed.href === TRUSTED_DESKTOP_URL;
  } catch { return false; }
}

const DEFAULT_ASSIST_SHORTCUT = 'CommandOrControl+Return';
// Founder tooling (leetcode hotkey, stealth, packs, résumé) is invisible to
// students; Pranav's own machine sets NUS_FOUNDER=1 to get it back.
const FOUNDER = process.env.NUS_FOUNDER === '1';
const RESERVED_SHORTCUTS = new Set([
  'commandorcontrol+h',
  'commandorcontrol+shift+x',
  'commandorcontrol+shift+space',
  'commandorcontrol+shift+t',
  'commandorcontrol+alt+space'
]);
const KNOT_CORNERS = new Set(['tl', 'tr', 'bl', 'br']);
const ALLOWED_SYSTEM_PANES = new Set([
  'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
]);

// -------- capture / transcript state --------
const state = { capturing: false, busy: false, transcribing: { you: false, them: false } };
let sttDisabled = false;
const buffers = { you: [], them: [] };
const transcript = []; // { channel, text, ts } working tail for prompts; durable copy goes through hooks
let sessionId = null;  // current desktop-db session, null when not capturing
let captureFinalizing = false, captureDrain = Promise.resolve();
const flushInFlight = { you: null, them: null };
let audioDir = null;   // per-session audio folder when saveAudio is on

const FLUSH_MS = 6000;
const MIN_BYTES = Math.floor(16000 * 2 * 0.6);
const RMS_GATE = 240;
let flushTimer = null;
let captureLimitTimer = null;
let captureStartedAt = null;

let sttBackoffUntil = 0;
let sttTransientFailures = 0;
const STT_BACKOFF_MAX_MS = 60000;

// -------- rehearsal state --------
let sparTurns = [];
let sparActive = false;
const SPAR_MAX_TURNS = 40;

function send(channel, data) {
  // A fast Escape tap can fall between probe polls. Reserve it only while
  // guidance or voice is active, then return it to the foreground app.
  if (channel === 'guide:state') { if (data && data.state && data.state !== 'idle') armEsc(); else disarmEsc(); }
  if (channel === 'guide:done') disarmEsc();
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}

// What the Companion knows about the app it lives in. Answers to "where is X"
// come from here, never from squinting at a screenshot.
const APP_GUIDE = 'APP GUIDE (answer questions about Nus from this, not from the screenshot): ' +
  'The dashboard is the Today tab, rail item 01 in the Nus desktop app. If its window is closed I am still running: click the Nus tray icon and choose "Open Nus dashboard". ' +
  'Talking to Nus: a full chat thread lives in the desktop app under Knot > Companion. It answers questions and can create tasks, move due dates, and draft emails, each with a Confirm step before anything is written. The Ask bar on the Today tab takes one-shot requests from anywhere. ' +
  'Email has its own tab in the rail. Gmail needs no connection at all: open the Email tab, add the address you send from under "Gmail and your addresses", fill the professor email form, press "Draft email", then press "Open in Gmail" and the finished draft opens in a Gmail compose window signed in as that address, where the student presses send. Outlook is a separate optional connection and is read-only until they opt in to sending. ' +
  'Map = rail item 02 (drag the canvas, scroll to zoom). Syllabus import = the Import button, always reviewed before saving. My capture sessions = Knot > History, uploadable to the vault. Automations and Integrations = the Connections tab. ' +
  'AI setup: the desktop connection can also answer Companion questions; a separate Companion AI key is optional. Desktop Settings > AI provider configures Claude. Desktop Settings > "Companion AI key" and my gear icon configure a separate provider when wanted. Voice uses local transcription when installed, with configured speech providers as fallback. The GPA scale is in desktop Settings, the Data section. ' +
  `Hotkeys: ${HOTKEY_MOD}+Shift+Space hides or shows me, ${HOTKEY_MOD}+Shift+X stops listening and vanishes. I keep running after the dashboard closes and the hotkeys keep working. "Turn off Companion" on the Knot > Companion pane removes me completely and releases the hotkeys until turned back on there.`;

// -------- window --------
// The overlay covers the whole work area of one display (the "Knot display"),
// so the strand can reach any pixel on it. It is click-through everywhere
// except the Knot corner and the bubbles, and it never moves: the Knot picks
// a corner instead.
function overlayBounds() {
  const want = store.getSettings().knotDisplayId;
  const display = (want != null && screen.getAllDisplays().find((d) => d.id === want)) || screen.getPrimaryDisplay();
  return display.workArea;
}

let displayWatch = false;
function reboundOverlay() {
  if (!win || win.isDestroyed()) return;
  try { win.setBounds(overlayBounds()); } catch (_) { /* display went away mid-change */ }
}

function createOverlayWindow() {
  const area = overlayBounds();
  win = new BrowserWindow({
    show: false,
    width: area.width,
    height: area.height,
    x: area.x,
    y: area.y,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // The overlay is a persistent, transparent, never-focused window.
      // Chromium can decide it is occluded and flip the document to hidden,
      // which throttled timers and froze the Knot. Keep it running; the
      // renderer is told about real hide/show through overlay:visible.
      backgroundThrottling: false
    }
  });
  win.on('show', () => send('overlay:visible', { visible: true }));
  win.on('hide', () => send('overlay:visible', { visible: false }));
  // A click on the Knot makes the overlay the foreground window: the one
  // moment a stripped always-on-top bit can be put back (see reassertTopmost).
  win.on('focus', reassertTopmost);

  const noProtect = process.env.JARVIS_NO_PROTECT === '1' || process.env.NUS_NO_PROTECT === '1';
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
  if (!displayWatch) {
    displayWatch = true;
    screen.on('display-metrics-changed', reboundOverlay);
    screen.on('display-added', reboundOverlay);
    screen.on('display-removed', reboundOverlay);
  }
  win.webContents.on('did-finish-load', () => {
    if (!overlayUserHidden && store.getSettings().companionEnabled !== false) win.showInactive();
    else win.hide();
    if (askTurns.length || inspectionTurns.length) send('conversation:restore', { turns: askTurns.concat(inspectionTurns) });
    if (!inspectionShortcutStatus.ok) send('status', { message: inspectionShortcutStatus.error });
    // Restore the full transcripts after history, which clears the renderer.
    // Voice commands and partial recordings may not have an ask-history entry.
    for (const turn of voiceTurns) send('voice:transcript', turn);
    if (guide && guide.session && guide.status().state === 'paused') guide.pause();
    reboundOverlay();
    // Restore the persisted Knot-mark visibility and corner across restarts.
    send('knot:set', { hidden: store.getSettings().knotHidden === true });
    send('knot:corner', { corner: store.getSettings().knotCorner || 'br' });
    // Give the desktop a moment to push its semester snapshot, then speak first.
    setTimeout(maybeSendDailyLine, 3000);
  });
  const createdWindow = win;
  win.webContents.on('render-process-gone', (_e, d) => {
    console.log('[nus] overlay renderer gone', JSON.stringify(d));
    cancelFeature();
    pttStop('cancel');
    if (guide) guide.pause();
    setCapturing(false);
    clearTimeout(overlayRecoveryTimer);
    if (++overlayRecoveryAttempts > 3) { console.log('[nus] automatic recovery stopped; use Show Companion to retry'); return; }
    overlayRecoveryTimer = setTimeout(() => {
      if (win !== createdWindow || store.getSettings().companionEnabled === false) return;
      if (!createdWindow.isDestroyed()) createdWindow.destroy();
      win = null;
      createOverlayWindow();
    }, 500);
  });
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
function flushChannel(channel, force = false) {
  if (flushInFlight[channel]) return flushInFlight[channel];
  const task = runFlushChannel(channel, sessionId, force);
  flushInFlight[channel] = task.finally(() => { flushInFlight[channel] = null; });
  return flushInFlight[channel];
}
async function runFlushChannel(channel, recordingId, force) {
  if (!force && Date.now() < sttBackoffUntil) return;
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
      if (!sttDisabled) { sttDisabled = true; send('status', { message: 'No transcription available. Run voice setup in the desktop app (Today tab mic) for free local transcription, or add an OpenAI (Whisper) or Gemini key in Settings. Screen/LeetCode features work without it.' }); }
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
      if (recordingId && hooks.onMessage) hooks.onMessage(recordingId, turn);
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
  if (active && captureFinalizing) { flash('Finishing the last transcript. Please wait a moment.'); return false; }
  if (active && (ptt.held || ptt.processing || (guide && guide.active()))) { flash('Finish your guide or voice question before recording.'); return false; }
  if (active && !createSTT(store.getSettings()).available) {
    flash('Set up voice in Nūs before recording a transcript.', 5000);
    if (hooks.showVoiceSetup) hooks.showVoiceSetup();
    return false;
  }
  if (active && hooks.captureAllowanceMs) {
    const allowance = Number(hooks.captureAllowanceMs());
    if (Number.isFinite(allowance) && allowance <= 0) {
      send('status', { message: 'Free Companion time is used for today. Upgrade to Pro or come back tomorrow.' });
      send('capture:limit', { error: 'limit_companion_minutes' });
      try { hooks.onCaptureLimit?.(); } catch {}
      return false;
    }
  }
  state.capturing = active;
  const settings = store.getSettings();
  if (active) {
    captureStartedAt = Date.now();
    const allowance = hooks.captureAllowanceMs ? Number(hooks.captureAllowanceMs()) : Number.POSITIVE_INFINITY;
    if (Number.isFinite(allowance)) {
      captureLimitTimer = setTimeout(() => {
        send('status', { message: 'Free Companion time is used for today. Listening stopped.' });
        setCapturing(false);
        try { hooks.onCaptureLimit?.(); } catch {}
      }, Math.max(1, allowance));
      captureLimitTimer.unref?.();
    }
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
    if (captureLimitTimer) { clearTimeout(captureLimitTimer); captureLimitTimer = null; }
    stopFlushLoop();
    const finishingId = sessionId;
    const endedAt = new Date().toISOString();
    captureFinalizing = true;
    send('capture:finalizing', { active: true });
    captureDrain = require('./src/capture-drain').drainCapture({
      pending: Object.values(flushInFlight).filter(Boolean),
      flush: (channel) => flushChannel(channel, true),
      finish: () => {
        buffers.you = []; buffers.them = [];
        const dir = finalizeSessionAudio();
        if (finishingId && hooks.onSessionEnd) hooks.onSessionEnd(finishingId, { ended_at: endedAt, audio_path: dir || '' });
      },
    }).catch(() => send('status', { message: 'The recording could not finish saving. Check recording history before closing Nūs.' })).finally(() => {
      if (sessionId === finishingId) sessionId = null;
      captureFinalizing = false;
      send('capture:finalizing', { active: false });
      notifyDesktopState();
    });
    if (captureStartedAt && hooks.onCaptureEnd) {
      const endedAt = Date.now();
      try { hooks.onCaptureEnd({ started_at: new Date(captureStartedAt).toISOString(), ended_at: new Date(endedAt).toISOString(), duration_ms: endedAt - captureStartedAt }); } catch {}
    }
    captureStartedAt = null;
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

// Live desktop snapshot: same process, no file round-trip. The file stays
// as the cold-start fallback.
function desktopSnapshot() {
  try { if (hooks.getDesktopState) return hooks.getDesktopState(); } catch (_) { /* fall through */ }
  const fromFile = loadNusContext(NUS_CONTEXT_FILE);
  return fromFile.ok ? fromFile.context : null;
}

// The once-a-day proactive line: the top ranked next move, rendered locally
// with no key and no model, shown above the Knot until clicked. This is the
// Companion speaking first, which is the whole reason it lives on screen.
function maybeSendDailyLine() {
  // Plan nudges own proactive suggestions; avoid a second competing notice.
  return;
  try {
    const today = new Date().toISOString().slice(0, 10);
    if (store.getSettings().lastDailyLine === today) return;
    const snapshot = desktopSnapshot();
    const move = snapshot && Array.isArray(snapshot.next_moves) ? snapshot.next_moves[0] : null;
    if (!move || !move.title) return;
    const text = move.title + (move.due_date ? ' (due ' + move.due_date + ')' : '');
    store.setSettings({ lastDailyLine: today });
    send('daily:line', { text });
  } catch (_) { /* the daily line is best-effort, never a crash */ }
}

// -------- feature runner --------
async function runFeature(mode, userText, voiceSessionId = null, opts = {}) {
  if (state.busy) { send('llm:busy', {}); return; }
  const def = MODES[mode];
  if (!def) return;

  const settings = store.getSettings();

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
  const controller = featureAbort = new AbortController();
  notifyDesktopState();
  try {
    const llm = featureLlm(settings);
    const userBubble = def.userBubble !== null ? def.userBubble : (mode === 'ask' || mode === 'spar' ? userText : null);
    send('llm:start', { userBubble, small: !!def.small });

    if (!llm.ready) {
      send('llm:error', { message: 'Connect Claude in the desktop app, or add a ' + settings.provider + ' API key in Settings (gear icon). Model: ' + (llm.model || 'unset') + '.' });
      return;
    }

    let imageDataUrl = null;
    // The composer's "Ask without screen" intent passes screen:false. Measured
    // 2026-09-10: without this, a plain typed question still went through
    // the reading state and a screenshot, which the label promised not to do.
    const wantScreen = !!def.needsScreen && opts.screen !== false;
    if (wantScreen) {
      send('guide:state', { state: 'reading', task: 'ask' });
      try { imageDataUrl = await captureScreenshot(); }
      catch (e) {
        send('status', { message: 'Screen capture needs permission. Grant Screen Recording to Nūs in System Settings.' });
      }
    }

    if (wantScreen) send('guide:state', { state: 'thinking', task: 'ask' });
    const { text: packText, error: packError } = packFor(def, settings);
    if (packError) send('status', { message: packError });
    let system = appendResumeContext(def.system, settings.resumeContext);
    if (def.needsScreen && !wantScreen) system += '\n\nNo screen image is attached for this question. Answer from the question and the context you have; do not claim to see the screen.';
    // Questions about Nus itself arrive in whatever mode the user happens to be
    // in, usually by typing rather than pressing the guide button. Reading the
    // answer off a screenshot is guesswork, so the guide travels with ask too.
    if (mode === 'guide' || mode === 'assist' || mode === 'ask') {
      system += companionContext(userText);
      system += '\n\n' + APP_GUIDE;
    } else if (settings.shareNusContextWithProvider === true) {
      system += companionContext(userText);
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
      if (mode === 'ask') turns = askTurns.slice(-12).concat(turns);
    }

    // A typed question is part of the session record too.
    if (sessionId && hooks.onMessage && userText && userText.trim()) {
      hooks.onMessage(sessionId, { channel: 'you', text: userText.trim(), ts: Date.now(), mode });
    }

    if (controller.signal.aborted) return;
    const fullText = await llm.stream({
      signal: controller.signal,
      system,
      turns,
      imageDataUrl,
      onToken: (t) => { if (!controller.signal.aborted) send('llm:token', { text: t }); }
    });
    if (controller.signal.aborted) return;
    if (mode === 'ask' && fullText) {
      askTurns.push({ role: 'user', text: String(userText || '').slice(0, 2000), voiceSessionId }, { role: 'assistant', text: fullText.slice(0, 6000) });
      if (askTurns.length > 24) askTurns.splice(0, askTurns.length - 24);
    }

    if (def.multiTurn && fullText) {
      sparTurns.push({ role: 'assistant', text: fullText });
      if (!sparActive) { sparActive = true; send('spar:state', { active: true }); }
    }

    if (fullText && sessionId && hooks.onMessage) {
      hooks.onMessage(sessionId, { channel: 'nus', text: fullText, ts: Date.now(), mode, used_screenshot: Boolean(imageDataUrl) });
    }
    if (fullText && settings.reportToNus === true) {
      appendEvent(app.getPath('userData'), {
        mode,
        used_screenshot: Boolean(imageDataUrl),
        answer: fullText,
        transcript_tail: transcript.slice(-6).map((t) => `${t.channel}: ${t.text}`).join('\n'),
      });
      if (hooks.onOutboxEvent) hooks.onOutboxEvent();
    }
    send('llm:done', {});
  } catch (e) {
    if (!controller.signal.aborted) send('llm:error', { message: 'Error: ' + (e && e.message ? e.message : String(e)) });
  } finally {
    if (controller !== featureAbort) return;
    state.busy = false;
    restoreKnotState();
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

  // The primary shortcut is the one verb: "what should I do?" It works with
  // no key set (guide renders locally), so day one it always answers.
  try {
    if (!globalShortcut.register(next, () => runFeature('guide', ''))) {
      if (previous) globalShortcut.register(previous, () => runFeature('guide', ''));
      return { ok: false, error: 'That shortcut is already in use by another application.' };
    }
  } catch (_) {
    if (previous) globalShortcut.register(previous, () => runFeature('guide', ''));
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
// Level 1: normal. Level 2 (desktop Knot pane): Knot mark hidden, panel still
// works. Level 3 (Ctrl+Shift+Space): window hidden; with the stealth setting on, the
// tray hides too and nothing on screen shows the Companion exists. The desktop
// app's Companion pane is the always-available way back.
function destroyTray() { if (tray) { tray.destroy(); tray = null; } }

// Bring the overlay back without stealing focus, except when Windows has
// stripped its always-on-top bit (a fullscreen app came and went): only an
// activating show() puts that back (measured; showInactive() cannot), so the
// hotkey and the tray are a guaranteed recovery for a buried Knot.
function showOverlay() {
  overlayUserHidden = false;
  if (!win || win.isDestroyed()) return;
  // Measured 2026-09-10: after the automatic recovery limit, Show brought a
  // blank crashed renderer to the front. An explicit Show rebuilds it.
  if (win.webContents.isCrashed()) {
    const dead = win; win = null;
    try { dead.destroy(); } catch (_) {}
    createOverlayWindow();
    return;
  }
  if (process.platform === 'win32' && !win.isAlwaysOnTop()) win.show();
  else win.showInactive();
}

function toggleOverlay() {
  if (!win || win.isDestroyed()) return;
  const settings = store.getSettings();
  if (win.isVisible()) {
    overlayUserHidden = true;
    win.hide();
    if (settings.stealth === true) destroyTray();
  } else {
    showOverlay();
    if (!tray) createTray();
  }
  updateTrayMenu();
  notifyDesktopState();
}

function forceShow() {
  overlayRecoveryAttempts = 0;
  overlayUserHidden = false;
  // Showing a Companion the user turned off turns it back on, shortcuts and
  // tray included, rather than half-reviving a window with no way to drive it.
  if (store.getSettings().companionEnabled === false) return enableCompanion();
  if (!win || win.isDestroyed()) createOverlayWindow();
  else showOverlay();
  if (!tray) createTray();
  updateTrayMenu();
  notifyDesktopState();
  return companionStatus();
}

// Panic key: stop listening and vanish in one stroke.
function panicHide() {
  cancelFeature();
  overlayUserHidden = true;
  pttStop('cancel');
  if (guide) guide.dismiss('panic');
  if (harness.active) guideDismiss('panic');
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
    probe: probe ? probe.status() : { available: false },
    guide: guide ? guide.status() : { state: 'idle' },
    walkthroughs: walkthroughs ? walkthroughs.list().length : 0,
    nudge: activeNudge ? activeNudge.key : null,
    ptt: { accelerator: ptt.accelerator, held: ptt.held },
    inspectionShortcut: inspectionShortcutStatus,
  };
}

// Remove the Companion entirely: capture stops, the hotkeys are released back
// to the OS, the tray icon and overlay window go away, and the choice is
// remembered so it does not return on the next launch. Nothing else about Nus
// is affected, and the desktop Knot pane can bring it back.
function disableCompanion() {
  cancelFeature();
  overlayUserHidden = true;
  clearTimeout(overlayRecoveryTimer);
  pttStop('cancel');
  if (guide) guide.dismiss('disabled');
  setCapturing(false);
  store.setSettings({ companionEnabled: false });
  try { globalShortcut.unregisterAll(); } catch {}
  registeredAssistShortcut = null;
  harness.esc = false;
  stopCursorProbe();
  stopProbe();
  stopProactive();
  destroyTray();
  if (win && !win.isDestroyed()) win.destroy();
  win = null;
  notifyDesktopState();
  return companionStatus();
}

function enableCompanion() {
  overlayUserHidden = false;
  store.setSettings({ companionEnabled: true });
  if (!win || win.isDestroyed()) createOverlayWindow();
  else showOverlay();
  registerShortcuts();
  if (!tray) createTray();
  updateTrayMenu();
  startCursorProbe();
  startProbe();
  startProactive();
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
  tray.setToolTip(`Nūs Companion, ${visible ? 'on screen' : 'hidden'} (${HOTKEY_MOD}+Shift+Space)`);
}

function createTray() {
  try {
    // The PNG is 512px, which Windows scales for the tray but the macOS menu
    // bar would draw at full size. Menu bar icons are 18pt (36px @2x).
    const iconPath = path.join(__dirname, 'tray-icon.png');
    const icon = IS_MAC ? nativeImage.createFromPath(iconPath).resize({ width: 18, height: 18 }) : iconPath;
    tray = new Tray(icon);
    tray.on('click', toggleOverlay);
    updateTrayMenu();
  } catch (e) {
    console.log('[nus] tray unavailable:', e.message);
  }
}

function registerShortcuts() {
  // Three hotkeys, no more: hide/show, panic, and the ask shortcut below.
  // Knot-mark visibility stays reachable from the desktop Knot pane.
  globalShortcut.register('CommandOrControl+Shift+X', panicHide);
  globalShortcut.register('CommandOrControl+Shift+Space', toggleOverlay);
  if (FOUNDER) globalShortcut.register('CommandOrControl+H', () => runFeature('leetcode', ''));
  ensureInspectionShortcut();
  registerPttShortcut();

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
  const { trustedSender } = require('../src/ipc-origin');
  const allowed = e => trustedSender(e, win && !win.isDestroyed() ? win.webContents : null);
  const safeIpc = {
    handle(channel, fn) { ipcMain.handle(channel, (event, ...args) => {
      if (!allowed(event)) return { ok: false, error: 'untrusted_sender' };
      return fn(event, ...args);
    }); },
    on(channel, fn) { ipcMain.on(channel, (event, ...args) => {
      if (!allowed(event)) return;
      try { Promise.resolve(fn(event, ...args)).catch(() => send('status', { message: 'That request did not finish. Please try again.' })); }
      catch (_) { send('status', { message: 'That request did not finish. Please try again.' }); }
    }); }
  };
  safeIpc.handle('companion:settings:get', () => ({ ...store.getSettings(), _inspectionShortcut: store.getSettings().companionEnabled === false ? inspectionShortcutStatus : ensureInspectionShortcut(), _migrationNote: store.migrationNote(), _founderTools: FOUNDER, _pttShortcut: ptt.accelerator || '', _speechProviders: createSTT(store.getSettings()).providers.join(' → ') || 'No speech engine available' }));
  safeIpc.handle('companion:ptt:toggle', () => { if (ptt.held) return pttStop('button'); pttStart(true); return { held: ptt.held }; });
  safeIpc.handle('companion:ptt:retry', () => {
    if (ptt.held || ptt.processing || !ptt.retryPcm) return { ok: false };
    return transcribeVoice(ptt.retryPcm);
  });
  safeIpc.handle('companion:ptt:finish', () => pttStop('device-ended'));
  safeIpc.handle('companion:shortcut:ptt:set', (_e, value) => setPttShortcut(value));
  safeIpc.handle('companion:ptt:cancel', () => {
    return pttStop('cancel');
  });
  safeIpc.handle('companion:walkthrough:list', () => getWalkthroughs().list());
  safeIpc.handle('companion:walkthrough:forget', (_e, key) => { try { getWalkthroughs().forget(String(key)); return { ok: true }; } catch (_) { return { ok: false, error: 'Could not forget this walkthrough. Please try again.' }; } });
  safeIpc.handle('companion:walkthrough:preview', (_e, key) => walkthroughNote(key));
  safeIpc.handle('companion:walkthrough:export', (_e, key) => {
    const note = walkthroughNote(key);
    if (!note.ok) return note;
    try { return require('../src/vault-notes').writeNote(note.fileName, note.content); }
    catch (_) { return { ok: false, error: 'Could not export to Jarvis. Check that the vault is writable, then try again.' }; }
  });
  safeIpc.handle('companion:desktop:history', () => { if (hooks.showHistory) hooks.showHistory(); else if (hooks.showDesktop) hooks.showDesktop(); return { ok: true }; });
  safeIpc.handle('companion:settings:set', (_e, patch) => { sttDisabled = false; return store.setSettings(patch); });
  safeIpc.handle('companion:shortcut:assist:set', (_e, accelerator) => setAssistShortcut(accelerator));
  safeIpc.handle('companion:capture:toggle', () => setCapturing(!state.capturing));
  safeIpc.handle('companion:capture:state', () => ({ active: state.capturing }));
  safeIpc.handle('companion:pack:status', () => packStatus());
  safeIpc.handle('companion:desktop:tour', () => {
    if (hooks.showDesktop) hooks.showDesktop();
    if (hooks.startDesktopTour) hooks.startDesktopTour();
    return { ok: true };
  });
  safeIpc.handle('companion:ai:ready', () => {
    const settings = store.getSettings();
    const llm = featureLlm(settings);
    return llm.ready
      ? { ok: true }
      : { ok: false, message: 'Connect Claude in the desktop app, or add a ' + settings.provider + ' API key in Settings (gear icon). Model: ' + (llm.model || 'unset') + '.' };
  });
  safeIpc.handle('companion:nus-context:status', () => {
    const result = loadNusContext(NUS_CONTEXT_FILE);
    return { ok: result.ok, path: result.path, updatedAt: result.updatedAt, error: result.error };
  });
  safeIpc.handle('companion:spar:reset', () => {
    sparTurns = [];
    sparActive = false;
    send('spar:state', { active: false });
    return { active: false };
  });
  safeIpc.handle('companion:deep:query', (_e, text) => runDeepQuery(text));
  safeIpc.on('companion:ask', (_e, payload) => runFeature(payload.mode, payload.text, null, { screen: !(payload && payload.screen === false) }));
  safeIpc.on('companion:mic:pcm', (_e, arrayBuffer) => { if (state.capturing) buffers.you.push(Buffer.from(arrayBuffer)); });
  safeIpc.on('companion:ptt:pcm', (_e, arrayBuffer) => { if (ptt.held) ptt.chunks.push(Buffer.from(arrayBuffer)); });
  safeIpc.on('companion:system:pcm', (_e, arrayBuffer) => { if (state.capturing) buffers.them.push(Buffer.from(arrayBuffer)); });
  safeIpc.on('companion:mouse:ignore', (_e, v) => { if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(!!v, { forward: true }); });
  // The Knot corner: persisted, echoed back so every renderer state agrees.
  safeIpc.handle('companion:knot:corner:set', (_e, corner) => {
    const next = KNOT_CORNERS.has(corner) ? corner : 'br';
    store.setSettings({ knotCorner: next });
    send('knot:corner', { corner: next });
    return next;
  });
  // Guide sessions. The real loop (screen read, pointing, replay) lands in
  // the next milestones; today these keep the harness honest and the
  // renderer's contract stable.
  safeIpc.on('companion:guide:dismiss', (_e, p) => {
    if (inspection || inspectionPreparing) { clearInspection(); send('guide:done', { offerKeep: false }); lastInspectionClearedAt = Date.now(); if (guide && guide.status().state === 'paused') setTimeout(() => guide && guide.showPaused(), 900); return; }
    const reason = (p && p.reason) || 'renderer';
    // Measured 2026-09-10: Escape on a selection reached here a second time
    // (the renderer cancels the selection, then dismisses) and ended the
    // walkthrough it had only paused. One Escape closes the selection; the
    // paused walkthrough comes back with Resume / End task.
    if (reason === 'esc' && guide && guide.status().state === 'paused' && Date.now() - lastInspectionClearedAt < 1500) { setTimeout(() => guide && guide.showPaused(), 900); return; }
    if (activeNudge) { endNudge(reason); return; }
    if (guide && guide.active()) guide.dismiss(reason);
    else guideDismiss(reason);
  });
  safeIpc.on('companion:strand:arrived', (_e, p) => {
    harness.arrivedAt = Date.now();
    if (guide && p && p.sessionId === guide.status().sessionId && p.generation === guide.gen) guide.onArrived();
  });
  safeIpc.handle('companion:guide:keep', (_e, p) => guide ? guide.keep(p && p.sessionId) : { ok: false });
  safeIpc.on('companion:guide:skip', (_e, p) => { if (guide) guide.skip(p && p.sessionId); });
  safeIpc.on('companion:guide:ask', (_e, p) => {
    // Founder-only: the harness can be driven from the renderer (and from a
    // DevTools session) as well as from the hotkey.
    if (p && p.action === 'harness' && FOUNDER) { harnessStep(); return; }
    // Founder-only: exercise the push-to-talk state round trip with no audio.
    if (p && p.action === 'ptt-test' && FOUNDER) { pttStart(); setTimeout(() => pttStop('test'), 1200); return; }
    if (p && p.action === 'say-test' && FOUNDER) { routeUtterance(String(p.text || 'thanks')); return; }
    if (p && p.action === 'open' && activeNudge) { if (hooks.showDesktop) hooks.showDesktop(); endNudge('open'); return; }
    if (p && p.action === 'notnow' && activeNudge) { endNudge('notnow'); return; }
    if (p && p.action === 'inspect-dismiss') { clearInspection(); send('guide:done', { offerKeep: false }); return; }
    if (p && p.action === 'walkthrough') { startWalkthroughFromSelection(); return; }
    if (p && p.action === 'resume-walkthrough') {
      clearInspection(); send('guide:done', { offerKeep: false }); lastInspectionClearedAt = Date.now();
      if (guide && guide.status().state === 'paused') setTimeout(() => guide && guide.onAction('resume'), 900);
      return;
    }
    if (p && p.text && inspection && inspection.turns.length) return submitInspection({ id: inspection.id, text: p.text, intent: 'explain' });
    if (p && p.action) { if (guide) guide.onAction(String(p.action)); return; }
    if (p && p.text && p.text.trim()) {
      if (state.capturing || ptt.held || ptt.processing) { flash('Finish recording or your voice question first.'); return; }
      if (state.busy) { send('llm:busy', {}); return; }
      const active = getGuide();
      return active.active() ? active.followUp(String(p.text).slice(0, 1000)) : active.start(String(p.text).slice(0, 1000), p.source === 'voice' ? 'voice' : 'typed');
    }
  });
  safeIpc.on('companion:inspect:submit', async (_e, p) => {
    return submitInspection(p);
  });
  safeIpc.on('companion:inspect:region', (_e, p) => {
    if (!inspection || !p || p.id !== inspection.id || !win || win.isDestroyed()) return;
    if (state.busy) { flash('Wait for this answer before changing the selection.'); return; }
    const b = win.getBounds();
    const r = p.rect;
    if (!r || ![r.x, r.y, r.w, r.h].every(Number.isFinite) || r.x < 0 || r.y < 0 || r.w < 4 || r.h < 4 || r.x + r.w > b.width || r.y + r.h > b.height) return;
    if (!inspection.capture) { flash('Press Ctrl+Shift+T to select a fresh region.'); return; }
    if (!sameBounds(b, inspection.bounds)) { flash('The display changed. Select again with Ctrl+Shift+T.'); return; }
    inspection.imageDataUrl = cropSelection(r, inspection.capture, inspection.bounds, nativeImage);
    inspection.bbox = r; inspection.name = 'Your selected region'; inspection.type = 'region'; inspection.source = 'user-selected';
    inspection.marker = null; inspection.point = null;
    inspection.turns = [];
    send('guide:done', { offerKeep: false });
    sendInspectionReady();
  });
  safeIpc.on('companion:inspect:cancel', () => { clearInspection(); send('guide:done', { offerKeep: false }); lastInspectionClearedAt = Date.now(); if (guide && guide.status().state === 'paused') setTimeout(() => guide && guide.showPaused(), 900); });
  safeIpc.on('companion:open-pane', (_e, url) => {
    if (typeof url === 'string' && ALLOWED_SYSTEM_PANES.has(url)) shell.openExternal(url).catch(() => {});
  });
  safeIpc.on('companion:log', (_e, msg) => console.log('[companion]', msg));
}

// -------- the Windows probe --------
// One PowerShell sidecar (src/win/probe.ps1): foreground window, UI
// Automation controls and rects, and key/click polling only while a session
// asks for it. Windows only; everything degrades when it is unavailable.
let probe = null;
function startProbe() {
  if (process.platform !== 'win32') return;
  if (!probe) {
    probe = createProbe({ resourcesPath: process.resourcesPath, log: (m) => console.log('[probe]', m) });
    probe.on('availability', (v) => { console.log('[probe] available:', v); notifyDesktopState(); });
  }
  wireProbeEvents();
  probe.start();
}
function stopProbe() { if (probe) probe.stop(); }
function probeReady() { return Boolean(probe && probe.available); }

// Physical screen rect (from the probe) -> overlay window CSS-ish DIPs.
// Electron only exposes the physical/DIP helpers on platforms that need
// them.  The Companion can still explain a guide on macOS, so use identity
// conversions when the helper is unavailable instead of failing before the
// explanation is shown.
function screenToDip(pt) { return typeof screen.screenToDipPoint === 'function' ? screen.screenToDipPoint(pt) : pt; }
function dipToScreen(pt) { return typeof screen.dipToScreenPoint === 'function' ? screen.dipToScreenPoint(pt) : pt; }
function physRectToWindow(r) {
  const a = screenToDip({ x: r.x, y: r.y });
  const b = screenToDip({ x: r.x + r.w, y: r.y + r.h });
  const wb = win.getBounds();
  return { x: a.x - wb.x, y: a.y - wb.y, w: Math.max(1, b.x - a.x), h: Math.max(1, b.y - a.y) };
}

// The real control under the cursor, via the probe. Null when the probe is
// off, the cursor is over nothing interactive, or the lookup is slow.
async function controlUnderCursor(at) {
  if (!probeReady() || !win || win.isDestroyed()) return null;
  try {
    const dip = at || screen.getCursorScreenPoint();
    const phys = dipToScreen(dip);
    const r = await probe.request('uia.frompoint', { x: phys.x, y: phys.y, ignorePid: process.pid }, 2500);
    const el = r && r.element;
    if (el && sensitiveTarget(el)) return { blocked: true };
    if (!el || !el.rect || el.pid === process.pid) return null;
    return { bbox: physRectToWindow(el.rect), name: el.name || '', type: el.type || '', window: r.window || null, fallback: !!el.fallback, ms: r.ms };
  } catch (e) {
    console.log('[probe] frompoint failed:', e.message);
    return null;
  }
}

let inspection = null;
let lastInspectionClearedAt = 0; // Escape on a selection must not end a paused walkthrough
let inspectionGeneration = 0;
let inspectionExpiry = null;
let inspectionPreparing = null;
function sameBounds(a, b) { return !!a && !!b && ['x', 'y', 'width', 'height'].every(k => a[k] === b[k]); }
function clearInspection() {
  ++inspectionGeneration;
  clearTimeout(inspectionExpiry);
  if (inspectionPreparing) {
    inspectionPreparing.abort();
    if (featureAbort === inspectionPreparing) { state.busy = false; featureAbort = null; }
    inspectionPreparing = null;
  }
  if (inspection) {
    inspection.controller?.abort();
    if (featureAbort === inspection.controller) { state.busy = false; send('llm:cancelled', {}); }
    inspection.capture = null; inspection.imageDataUrl = null;
  }
  inspection = null;
  send('inspect:cleared', {});
}
function sendInspectionReady() {
  if (!inspection) return;
  const { id, createdAt, name, type, source, bbox, point, imageDataUrl, capture } = inspection;
  // Never send the full local display snapshot to either renderer or model.
  send('inspect:ready', { id, createdAt, name, type, source, bbox, point, imageDataUrl, canReselect: !!capture, provider: 'Claude' });
}
async function inspectAtCursor() {
  if (state.capturing || ptt.held || ptt.processing || state.busy) { flash('Finish the current recording or answer first.'); return; }
  const invokedPoint = screen.getCursorScreenPoint();
  if (guide && guide.active()) guide.pause();
  clearInspection();
  send('guide:done', { offerKeep: false });
  const generation = ++inspectionGeneration;
  const preparing = inspectionPreparing = featureAbort = new AbortController();
  state.busy = true;
  armEsc();
  const selectionDeadline = setTimeout(() => {
    if (inspectionPreparing !== preparing) return;
    clearInspection();
    restoreKnotState();
    send('inspect:failed', { message: 'Windows took too long to identify or capture this control.' });
  }, 10000);
  flash('Selecting what you pointed at…');
  // Do not focus the overlay until the app and target have been collected.
  let capture, foreground, hit, bounds;
  try {
    foreground = await getGuide().foreground();
    if (!win || win.isDestroyed() || generation !== inspectionGeneration) return;
    hit = await resolveInspectionHit({ point: invokedPoint, bounds: win.getBounds(), lookup: controlUnderCursor, signal: preparing.signal });
    if (generation !== inspectionGeneration || !win || win.isDestroyed()) return;
    if (hit?.blocked) throw new Error('This is a protected field. Point at a non-sensitive area instead.');
    bounds = win.getBounds();
    send('guide:state', { state: 'reading', task: 'ask' });
    // Snapshot before the composer takes focus. Full display remains local,
    // only until a region is chosen/sent, cancelled, or its 120s timer expires.
    capture = await captureDisplay(store.getSettings().knotDisplayId, { maxSide: 16384 });
    if (!capture) throw new Error('Screen capture unavailable. Check Nūs screen-recording permission.');
    if (generation !== inspectionGeneration || !win || win.isDestroyed()) return;
    if (foreground && !sameApp(foreground, await getGuide().foreground())) throw new Error('The app changed. Point at it again.');
    if (generation !== inspectionGeneration || !win || win.isDestroyed()) return;
    if (!sameBounds(bounds, win.getBounds())) throw new Error('The display changed. Point at it again.');
    // Measured 2026-09-10: over empty space UI Automation hands back the whole
    // window as the "control", which would preview and send the entire app.
    // Anything bigger than a quarter of the display is not a control: ask for
    // a drawn region instead.
    if (hit && hit.bbox && hit.bbox.w * hit.bbox.h > 0.25 * bounds.width * bounds.height) { console.log('[inspect] hit is window-sized (' + hit.name + '); asking for a region'); hit = null; }
    inspection = { id: 'inspect-' + generation, createdAt: Date.now(), window: foreground, bounds, capture, turns: [], name: hit && hit.name || '', type: hit && hit.type || '', bbox: hit && hit.bbox || null, source: hit ? 'accessibility' : 'user-selected' };
    if (hit) {
      try { inspection.imageDataUrl = cropSelection(hit.bbox, capture, bounds, nativeImage); }
      catch (_) { inspection.bbox = null; inspection.source = 'user-selected'; }
    }
    if (!inspection.imageDataUrl) {
      const nearby = pointContext(invokedPoint, bounds);
      inspection.bbox = nearby.bbox; inspection.marker = nearby.marker; inspection.point = nearby.point;
      inspection.name = 'Area around your pointer'; inspection.type = 'area'; inspection.source = 'point-context';
      inspection.imageDataUrl = cropSelection(nearby.bbox, capture, bounds, nativeImage);
    }
  } catch (error) {
    if (generation === inspectionGeneration) {
      clearInspection(); restoreKnotState();
      send('inspect:failed', { message: error.message || 'The selected control could not be read.' });
    }
    return;
  }
  finally {
    clearTimeout(selectionDeadline);
    if (inspectionPreparing === preparing) inspectionPreparing = null;
    if (featureAbort === preparing) { state.busy = false; featureAbort = null; notifyDesktopState(); }
    if (generation === inspectionGeneration) restoreKnotState();
  }
  if (generation !== inspectionGeneration) return;
  inspectionExpiry = setTimeout(() => { clearInspection(); send('guide:done', { offerKeep: false }); flash('Selection expired. Ctrl+Shift+T takes a fresh snapshot.'); }, 120000);
  if (overlayUserHidden) showOverlay();
  win.setIgnoreMouseEvents(false);
  win.focus();
  // focus() over a maximized app can drop the overlay to the bottom of the
  // z-order (see restoreTopmost); put it back before the composer is shown.
  if (!win.isAlwaysOnTop()) { console.log('[inspect] focus() stripped topmost; restoring'); await restoreTopmost('inspect'); }
  sendInspectionReady();
  pointAtSelection();
}

// The thread unwinds to the selected control the moment it is selected, not
// only after Claude answers (Pranav, 2026-09-10 evening: "Ctrl+Shift+T
// shouldn't just open a text box"). Only a UI Automation control is pointed
// at; a drawn region never gets a thread. The answer later replaces this
// bubble at the same tip; Escape, expiry and Done wind it back. An arbitrary
// chosen spot also gets a strand, explicitly labeled as a spot, not a control.
function pointAtSelection() {
  if (inspection?.source === 'point-context' && inspection.marker) {
    send('guide:target', { bbox: inspection.marker, task: 'ask', generation: inspectionGeneration, kicker: 'Your spot · not a detected control', instruction: 'What’s happening here? What would you like help with?', hint: 'Type the issue, or press Enter to let Claude describe this preview and ask a question. Nothing is shared until Send.', actions: [] });
    return;
  }
  if (!inspection || !inspection.bbox || inspection.source !== 'accessibility') return;
  send('guide:target', { bbox: inspection.bbox, task: 'ask', generation: inspectionGeneration, kicker: 'Selected · ' + (inspection.name || inspection.type), text: '', hint: 'Enter explains it. Type a question for more. Escape lets go.', actions: [] });
}

// True when another visible window of this process (the desktop dashboard,
// never the overlay itself) sits over a DIP point on the Knot display.
function coveredByOwnWindow(dip) {
  return BrowserWindow.getAllWindows().some((w) => {
    if (w === win || w.isDestroyed() || !w.isVisible() || w.isMinimized()) return false;
    const r = w.getBounds();
    return dip.x >= r.x && dip.x < r.x + r.width && dip.y >= r.y && dip.y < r.y + r.height;
  });
}

// "Walk me through it" on a selection answer: the ordinary multi-step guide,
// started with the selection's question as the goal and its answer as one
// line of prior context (text only). The selected snapshot is dropped here and
// never reused; each step takes its own capture under the guide rules. The
// session is pinned to Claude for its whole life. Never automatic.
function startWalkthroughFromSelection() {
  const selected = inspection;
  if (!selected || !selected.turns.length) { flash('Select something with Ctrl+Shift+T first.'); return; }
  if (state.capturing || ptt.held || ptt.processing || state.busy) { flash('Finish the current recording or answer first.'); return; }
  const lastUser = [...selected.turns].reverse().find((t) => t.role === 'user');
  const lastAnswer = [...selected.turns].reverse().find((t) => t.role === 'assistant');
  const question = String(lastUser && lastUser.text || '').replace(/^Help me fix this: /, '').trim();
  const generic = /^(Explain (this selection|the next step for this selection)\.?|Help me fix this\.?)$/i.test(question);
  const task = generic || !question ? ('Help me with ' + (selected.name || 'this') + (selected.window && selected.window.title ? ' in ' + selected.window.title : '')) : question;
  const prior = String(lastAnswer && lastAnswer.text || '');
  if (typeof hooks.desktopComplete !== 'function' && !createLLM({ ...store.getSettings(), provider: 'anthropic' }).ready) { flash('Connect Claude in Nūs to walk through this.', 5000); return; }
  clearInspection();
  send('guide:done', { offerKeep: false });
  if (guide && guide.active()) guide.dismiss('replaced-by-walkthrough');
  console.log('[inspect] walkthrough from selection: ' + JSON.stringify({ task, priorChars: prior.length }));
  getGuide().start(task, 'typed', { providerLock: 'anthropic', prior });
}

async function inspectionTargetStillValid(selected) {
  if (selected.source !== 'accessibility' || !probeReady() || !win || win.isDestroyed() || !sameBounds(selected.bounds, win.getBounds())) return false;
  // A null foreground is the Companion itself (composer focused); the
  // uia.frompoint check below still proves the control is where it was.
  const fg = await getGuide().foreground();
  if (fg && !sameApp(selected.window, fg)) return false;
  const r = selected.bbox, b = selected.bounds;
  const point = dipToScreen({ x: b.x + r.x + r.w / 2, y: b.y + r.y + r.h / 2 });
  // Measured 2026-09-10: the probe skips every window of our own process, so
  // a selected control hidden under the Nūs dashboard still "hit". When our
  // own window is in front and covers the point, do not draw a thread to it.
  if (!fg && coveredByOwnWindow({ x: b.x + r.x + r.w / 2, y: b.y + r.y + r.h / 2 })) return false;
  try {
    const result = await probe.request('uia.frompoint', { ...point, ignorePid: process.pid }, 2500);
    const el = result && result.element;
    if (!el || !el.rect || el.pid === process.pid || sensitiveTarget(el) || el.name !== selected.name || el.type !== selected.type) return false;
    const live = physRectToWindow(el.rect);
    return ['x', 'y', 'w', 'h'].every(k => Math.abs(live[k] - r[k]) <= 2);
  } catch (_) { return false; }
}

async function submitInspection(p) {
  if (!inspection || !p || p.id !== inspection.id) return;
  if (state.busy || state.capturing || ptt.held || ptt.processing) { flash('Finish the current answer or recording first.'); return; }
  const selected = inspection;
  const text = String(p.text || '').trim().slice(0, 2000);
  if (!text || !['explain', 'fix', 'guide'].includes(p.intent)) return;
  if (!selected.imageDataUrl) { flash('Select a region first, then send it to Claude.'); return; }
  if (Date.now() - selected.createdAt > 120000) { clearInspection(); flash('Selection expired. Press Ctrl+Shift+T again.'); return; }
  const controller = new AbortController();
  selected.controller = featureAbort = controller;
  state.busy = true;
  selected.capture = null; // No full-display snapshot is retained after Send.
  send('llm:start', { userBubble: text, small: false });
  send('guide:state', { state: 'thinking', task: 'ask' });
  try {
    const fg = await getGuide().foreground();
    if (controller.signal.aborted) return;
    // Measured 2026-09-10: after the composer takes focus the Companion itself
    // is the foreground window, so foreground() returns null (our own pid is
    // never "the app"). Null means "unknown, probably us", not "changed";
    // only a different real app in front refuses the send.
    if (selected.window && fg && !sameApp(selected.window, fg)) {
      console.log('[inspect] app mismatch at send: selected=' + JSON.stringify({ hwnd: selected.window.hwnd, title: selected.window.title, process: selected.window.process }) + ' now=' + JSON.stringify({ hwnd: fg.hwnd, title: fg.title, process: fg.process }));
      throw new Error('The selected app changed. Press Ctrl+Shift+T to refresh.');
    }
    if (!win || win.isDestroyed() || !sameBounds(selected.bounds, win.getBounds())) throw new Error('The display changed. Select the area again.');
    const client = claudeClient(store.getSettings(), createLLM, hooks.desktopComplete);
    // This consent covers the selected snapshot and its conversation only,
    // not unrelated semester records or another active desktop task.
    send('context:used', { sources: [{ source: 'selected snapshot → Claude', updatedAt: selected.createdAt }] });
    const result = await answerSelection({ selected, text, intent: p.intent, client, signal: controller.signal });
    if (controller.signal.aborted || inspection !== selected) return;
    selected.turns.push({ role: 'user', text }, { role: 'assistant', text: result.answer });
    if (selected.turns.length > 12) selected.turns.splice(0, selected.turns.length - 12);
    inspectionTurns.push({ role: 'user', text: '[Selected area · Claude] ' + text }, { role: 'assistant', text: result.answer });
    if (inspectionTurns.length > 24) inspectionTurns.splice(0, inspectionTurns.length - 24);
    send('llm:token', { text: result.answer }); send('llm:done', {});
    const valid = result.pointToSelection && await inspectionTargetStillValid(selected);
    if (controller.signal.aborted || inspection !== selected) return;
    // The explicit bridge into a walkthrough. One inline sentence says what
    // changes (fresh captures per step, still Claude); no extra prompts.
    const guideIntent = p.intent === 'guide';
    const pausedWalkthrough = Boolean(guide && guide.status().state === 'paused');
    const actions = [
      ...(guideIntent ? [{ id: 'walkthrough', label: 'Walk me through it' }] : []),
      ...(pausedWalkthrough ? [{ id: 'resume-walkthrough', label: 'Resume walkthrough' }] : []),
      { id: 'inspect-ask', label: 'Ask more' },
      { id: 'inspect-dismiss', label: 'Done' },
    ];
    const hint = (guideIntent ? 'Walk me through it takes a fresh screen picture at each step and sends it to Claude. ' : '') + 'Ask more uses this same snapshot. Ctrl+Shift+T selects a fresh area. The full answer is in the conversation.';
    const bubble = { instruction: result.answer.slice(0, 400), text: result.answer.slice(0, 400), task: 'ask', sessionId: selected.id, generation: inspectionGeneration, kicker: 'Claude · selected snapshot', hint, actions };
    if (valid) send('guide:target', { ...bubble, bbox: selected.bbox });
    else { send('guide:done', { offerKeep: false }); send('guide:bubble', { ...bubble, anchor: 'knot' }); }
  } catch (error) {
    if (!controller.signal.aborted) { send('llm:error', { message: error.message || 'Claude could not answer. Try again.' }); restoreKnotState(); }
  } finally {
    if (featureAbort === controller) { state.busy = false; featureAbort = null; if (controller.signal.aborted || !selected.turns.length) restoreKnotState(); notifyDesktopState(); }
  }
}

// -------- the guide session --------
// One ask, one thread. Main owns the state machine (src/guide/session.js);
// the probe supplies windows, controls, clicks and Esc; the renderer draws.
let guide = null;

// { whole, crop } hashes of a capture, for "did the click change anything".
function hashCapture(cap, physRect) {
  const img = nativeImage.createFromDataURL(cap.dataUrl);
  const whole = bitmapHash(img.resize({ width: 16, height: 16, quality: 'good' }).toBitmap());
  let crop = null;
  if (physRect) {
    const origin = dipToScreen({ x: cap.display.bounds.x, y: cap.display.bounds.y });
    const f = cap.width / cap.pxWidth;
    const pad = 24;
    const r = {
      x: Math.max(0, Math.round((physRect.x - origin.x - pad) * f)),
      y: Math.max(0, Math.round((physRect.y - origin.y - pad) * f)),
      width: Math.max(4, Math.round((physRect.w + pad * 2) * f)),
      height: Math.max(4, Math.round((physRect.h + pad * 2) * f)),
    };
    r.width = Math.min(r.width, cap.width - r.x);
    r.height = Math.min(r.height, cap.height - r.y);
    if (r.width > 3 && r.height > 3) crop = bitmapHash(img.crop(r).resize({ width: 16, height: 16, quality: 'good' }).toBitmap());
  }
  return { whole, crop };
}

// The Companion's own key when it has one; otherwise the desktop's Claude
// (Claude Code on the subscription, or its API key). Both paths receive the
// screenshot inline, together with the current control list.
// The Companion's model: its own key when one is set, otherwise the desktop's
// Claude connection (Claude Code sign-in or the desktop Anthropic key) through
// hooks.desktopComplete, which runs with no tools. The guide and the command
// sheet share this so a user with only the desktop connected still gets
// answers everywhere, not just screen pointing.
async function desktopAnswer(prompt, imageDataUrl) {
  const r = await hooks.desktopComplete(prompt, imageDataUrl);
  if (!r || r.error) {
    if (r && r.error === 'no_ai') throw new Error('No AI is set up. Connect Claude in the desktop app or add a Companion key.');
    throw new Error(r && r.error ? describeClaudeError(r) : 'No model response');
  }
  return r.text || '';
}
function turnsToPrompt(turns) {
  const list = Array.isArray(turns) ? turns : [];
  if (list.length <= 1) return list[0] ? list[0].text : '';
  return list.map((t) => (t.role === 'assistant' ? 'Nūs: ' : 'User: ') + t.text).join('\n\n') + '\n\nNūs:';
}
function featureLlm(settings) {
  const own = createLLM(settings || store.getSettings());
  if (own.ready || typeof hooks.desktopComplete !== 'function') return own;
  return {
    ready: true,
    provider: 'claude (desktop)',
    model: 'desktop',
    async complete({ system, turns, imageDataUrl }) {
      const prompt = system + '\n\n' + turnsToPrompt(turns) + '\n\nReply with the JSON object only.';
      return desktopAnswer(prompt, imageDataUrl);
    },
    async stream({ system, turns, imageDataUrl, onToken }) {
      const text = await desktopAnswer(system + '\n\n' + turnsToPrompt(turns), imageDataUrl);
      if (text && typeof onToken === 'function') onToken(text);
      return text;
    },
  };
}
function guideLlm() { return featureLlm(store.getSettings()); }
function companionContext(task, activeSession) {
  const built = buildCompanionContext({ settings: store.getSettings(), snapshot: desktopSnapshot(), task, session: activeSession });
  send('context:used', { sources: built.sources });
  return built.prompt;
}

let walkthroughs = null;
function getWalkthroughs() {
  if (!walkthroughs) walkthroughs = createWalkthroughs({ file: path.join(app.getPath('userData'), 'companion-walkthroughs.json'), log: (m) => console.log('[walkthroughs]', m) });
  return walkthroughs;
}

function getGuide() {
  if (guide) return guide;
  guide = new GuideSession({
    context: (activeSession) => companionContext(activeSession.unresolved || activeSession.task, activeSession),
    walkthroughs: getWalkthroughs(),
    capture: () => captureDisplay(store.getSettings().knotDisplayId, { maxSide: 1280 }),
    get probe() { return probe; },
    llm: () => guideLlm(),
    // A walkthrough started from a selected area stays on Claude: same client
    // as the selection itself, never the general provider preference.
    llmFor: (lock) => (lock === 'anthropic' ? claudeClient(store.getSettings(), createLLM, hooks.desktopComplete) : guideLlm()),
    lastForeground: () => lastForeground,
    send,
    screenToDip,
    dipToScreen,
    winBounds: () => (win && !win.isDestroyed() ? win.getBounds() : { x: 0, y: 0, width: 0, height: 0 }),
    hashCapture,
    selfPid: process.pid,
    log: (m) => console.log('[guide]', m),
    // Keep = explicit consent: the session summary goes to the outbox the
    // desktop already ingests, whatever the reportToNus default says.
    onKeep: (record) => {
      const steps = (record.steps || []).map((st, i) => `${i + 1}. ${st.instruction}${st.name ? ' [' + st.name + ']' : ''}`).join('\n');
      const saved = appendEvent(app.getPath('userData'), {
        mode: 'guide',
        used_screenshot: true,
        answer: `Guided: ${record.task}` + (record.app && record.app.title ? ` in ${record.app.title}` : '') + ` (${(record.steps || []).length} step${(record.steps || []).length === 1 ? '' : 's'})\n` + steps,
        transcript_tail: '',
        id: record.id, kind: 'guide', app: record.app ? record.app.process : '', task: record.task,
      });
      if (!saved) throw new Error('Could not save the Nūs summary');
      if (hooks.onOutboxEvent) hooks.onOutboxEvent();
    },
  });
  return guide;
}

function wireProbeEvents() {
  if (!probe || probe._guideWired) return;
  probe._guideWired = true;
  probe.on('click', (e) => { if (guide) guide.onClick({ x: e.x, y: e.y }); });
  probe.on('key', (e) => {
    const vk = Number(e.vk);
    if (vk === 27 && e.down && ptt.held) { ptt.chunks = []; pttStop('cancel'); return; }
    if (vk === ptt.vk && !ptt.fromButton) { if (!e.down && ptt.held) pttStop('release'); if (vk !== 27) return; }
    if (guide) guide.onKey(vk, !!e.down);
  });
}

// -------- proactive: the Knot speaks first --------
// Two triggers only: the user's own plan (events within the hour, deadlines
// due today, overdue, due tomorrow from the evening) and an app coming to
// the front that has kept walkthroughs. One nudge per 20 minutes, one per
// key per day, "not now" snoozes for the day, nothing while a session runs,
// the overlay is hidden, or a meeting is being listened to.
const PROACTIVE_TICK_MS = 15000;
let proactive = null;
let proactiveTimer = null;
let activeNudge = null;   // { key, kind, text, task }

async function proactiveTick() {
  try {
    const settings = store.getSettings();
    if (settings.proactive === false || !win || win.isDestroyed()) return;
    if (!proactive) proactive = createProactive();
    const quiet = !win.isVisible() || state.capturing || state.busy || (guide && guide.active()) || !!activeNudge || harness.active;
    let fgWindow = null;
    if (probeReady()) {
      try { fgWindow = await probe.request('fg', { ignorePid: process.pid }, 1500); } catch (_) { fgWindow = null; }
      if (fgWindow && (fgWindow.pid === process.pid || !fgWindow.hwnd)) fgWindow = null;
    }
    const trig = proactive.tick({ snapshot: desktopSnapshot(), fgWindow, walkthroughs: getWalkthroughs(), snoozes: settings.snoozes || {}, quiet });
    if (!trig) return;
    console.log('[proactive]', trig.kind, trig.key);
    if (trig.kind === 'app') {
      send('guide:hint', { text: trig.text, hint: trig.hint, ms: 7000 });
      return;
    }
    activeNudge = trig;
    send('guide:state', { state: 'nudging', task: 'nudge' });
    send('guide:bubble', {
      kicker: 'from your Nūs plan',
      text: trig.text,
      anchor: 'knot',
      task: 'nudge',
      actions: [{ id: 'open', label: 'Open in Nūs', primary: true }, { id: 'notnow', label: 'Not now' }],
    });
    // A nudge nobody touches winds itself back after a while, unsnoozed.
    setTimeout(() => { if (activeNudge && activeNudge.key === trig.key) endNudge('timeout'); }, 45000);
  } catch (e) {
    console.log('[proactive] tick failed:', e.message);
  }
}

function endNudge(reason) {
  const n = activeNudge;
  activeNudge = null;
  if (!n) return;
  if (reason === 'notnow') {
    const snoozes = Object.assign({}, store.getSettings().snoozes || {});
    snoozes[n.key] = new Date().toISOString().slice(0, 10);
    store.setSettings({ snoozes });
  }
  send('guide:done', { sessionId: null, offerKeep: false });
}

function startProactive() {
  if (proactiveTimer) return;
  proactiveTimer = setInterval(proactiveTick, PROACTIVE_TICK_MS);
  if (proactiveTimer.unref) proactiveTimer.unref();
}
function stopProactive() {
  if (proactiveTimer) { clearInterval(proactiveTimer); proactiveTimer = null; }
  activeNudge = null;
}

// -------- push-to-talk --------
// Hold the chord, speak, release. The hotkey gives the down (Windows repeats
// it while held; ignored); the probe's key watch gives the up. Without the
// probe the chord toggles. Audio goes through the existing mic worklet, is
// transcribed once (local whisper first), and the words either wind the
// thread back ("thanks"), advance it ("next"), or start a guide session
// marked voice, which is the only case where the Knot speaks back.
const DEFAULT_PTT_SHORTCUT = 'CommandOrControl+Alt+Space';
const PTT_MAX_MS = 20000;
const HANDSFREE_MAX_MS = 120000;
const PTT_MIN_BYTES = Math.floor(16000 * 2 * 0.35);
const VK_SPACE = 32;
const ptt = { held: false, chunks: [], startedAt: 0, timer: null, accelerator: null, vk: VK_SPACE };

function flash(text, ms) { send('guide:hint', { text, ms: ms || 3000 }); }
function guidePointing() { return Boolean(guide && guide.status().state === 'pointing'); }
function restoreKnotState() {
  send('guide:state', { state: guide && guide.active() ? guide.status().state : null, task: 'guide' });
}

function pttStart(fromButton = false) {
  if (!win || win.isDestroyed() || !win.isVisible()) return;
  if (ptt.held) {
    // Key repeat while held (probe) or a second press to end (no probe).
    if (!probeReady() && Date.now() - ptt.startedAt > 700) pttStop('toggle');
    return;
  }
  if (state.capturing || captureFinalizing) { flash('Recording or saving a meeting right now. Stop that first to talk to me.', 3500); return; }
  const gs = guide ? guide.status().state : 'idle';
  if (guide && guide.active() && gs !== 'pointing' && gs !== 'explaining') return;   // mid-read: let it finish
  if (ptt.processing) { flash('Finishing your last voice question.', 2500); return; }
  if (!createSTT(store.getSettings()).available) {
    flash('Set up voice in Nūs, or add a speech provider in Settings.', 5000);
    if (hooks.showVoiceSetup) hooks.showVoiceSetup();
    return;
  }
  ptt.held = true;
  ptt.chunks = [];
  ptt.partialHead = null;
  ptt.startedAt = Date.now();
  ptt.generation = (ptt.generation || 0) + 1;
  ptt.abort = new AbortController();
  ptt.id = 'voice-' + ptt.startedAt + '-' + ptt.generation;
  ptt.revision = 0;
  ptt.retryPcm = null;
  ptt.fromButton = fromButton === true;
  const limitMs = ptt.fromButton ? HANDSFREE_MAX_MS : PTT_MAX_MS;
  send('ptt:state', { held: true, sessionId: ptt.id, startedAt: ptt.startedAt, limitMs, handsFree: ptt.fromButton });
  send('guide:state', { state: 'listening', task: 'guide' });
  if (probeReady()) {
    if (guidePointing()) guide.startWatch([ptt.vk]);
    else probe.watch({ keys: ptt.fromButton ? [27] : [27, ptt.vk], click: false, fg: false }).catch(() => {});
  }
  ptt.timer = setTimeout(() => pttStop('timeout'), limitMs);
  ptt.partialTimer = setInterval(transcribeVoicePartial, 3000);
}

async function transcribeVoicePartial() {
  if (!ptt.held || ptt.partialBusy || !ptt.chunks.length) return;
  const local = require('../src/stt-local');
  if (!local.status().available) return; // No extra cloud calls for preview text.
  const id = ptt.id, generation = ptt.generation;
  const whole = Buffer.concat(ptt.chunks);
  // Measured 2026-09-10 (synthetic mic): re-transcribing the whole buffer
  // every 3s stalled the live preview after ~15s because each pass took
  // longer than the interval. Past PARTIAL_WINDOW_S the preview keeps the
  // text confirmed while the buffer was still short and appends a fresh
  // pass over the last window only. The final pass after Stop still covers
  // everything and replaces this preview.
  const { head, pcm, freeze } = partialWindow(whole, ptt.partialHead, PARTIAL_WINDOW_S);
  ptt.partialBusy = true;
  const partialAbort = new AbortController();
  ptt.partialAbort = partialAbort;
  const t0 = Date.now();
  try {
    const result = await local.transcribePcm(pcm, { kind: 'partial', sessionId: id, signal: partialAbort.signal });
    console.log('[ptt] partial: ' + (pcm.length / 32000).toFixed(1) + 's after ' + (head ? 'head' : 'start') + ', ' + (Date.now() - t0) + 'ms, ' + (result && result.text ? result.text.trim().length + ' chars' : JSON.stringify(result)));
    if (!ptt.held || ptt.id !== id || ptt.generation !== generation || !result.text) return;
    const tail = cleanTranscript(result.text);
    const text = head ? head + ' ' + tail : tail;
    if (freeze) ptt.partialHead = { text, endSample: whole.length / 2 };
    publishVoiceTurn({ sessionId: id, text, revision: ++ptt.revision, final: false, startSample: 0, endSample: whole.length / 2 });
  } finally { ptt.partialBusy = false; }
}


function publishVoiceTurn(turn) {
  const index = voiceTurns.findIndex((item) => item.sessionId === turn.sessionId);
  if (index >= 0) voiceTurns[index] = turn; else voiceTurns.push(turn);
  if (voiceTurns.length > 40) voiceTurns.shift();
  send('voice:transcript', turn);
}

async function pttStop(reason) {
  // Every ender is named in the log so a session that ends "too soon" can be
  // traced to the cap, a key event, the device, cancellation or recovery.
  if (ptt.held) console.log('[ptt] stop: ' + reason + ' after ' + (Date.now() - ptt.startedAt) + 'ms (' + (ptt.fromButton ? 'hands-free' : 'hold') + ', ' + ptt.chunks.length + ' chunks)');
  if (reason === 'cancel') {
    ptt.generation = (ptt.generation || 0) + 1;
    if (ptt.abort) ptt.abort.abort();
    ptt.retryPcm = null;
    require('../src/stt-local').cancel(ptt.id);
    send('voice:status', { state: 'done', retry: false });
  }
  if (ptt.partialAbort) ptt.partialAbort.abort();
  if (!ptt.held) return;
  ptt.held = false;
  clearTimeout(ptt.timer);
  clearInterval(ptt.partialTimer);
  ptt.timer = null;
  send('ptt:state', { held: false });
  if (probeReady()) {
    if (guidePointing()) guide.startWatch();
    else probe.unwatch().catch(() => {});
  }
  const pcm = Buffer.concat(ptt.chunks);
  ptt.chunks = [];
  send('guide:state', { state: 'transcribing', task: 'guide' });
  if (reason === 'cancel') { ptt.retryPcm = null; restoreKnotState(); return; }
  if (pcm.length < PTT_MIN_BYTES || rms16(pcm) < RMS_GATE) { flash('I did not catch that. Hold the key and speak.', 3000); restoreKnotState(); return; }
  return transcribeVoice(pcm);
}

async function transcribeVoice(pcm) {
  const stt = createSTT(store.getSettings());
  ptt.retryPcm = pcm;
  send('voice:status', { sessionId: ptt.id, state: 'transcribing', retry: false });
  let res = null;
  const generation = ptt.generation || 0;
  const t0 = Date.now();
  ptt.processing = true;
  try { res = await stt.transcribe(pcm, { kind: 'final', sessionId: ptt.id, signal: ptt.abort && ptt.abort.signal }); } catch (e) { res = { text: '', error: { message: e.message } }; } finally { ptt.processing = false; }
  if (generation !== (ptt.generation || 0) || !win || win.isDestroyed()) return;
  const text = cleanTranscript(res && res.text);
  console.log('[ptt] ' + (Date.now() - t0) + 'ms via ' + (res && res.provider || '?') + ', transcript ' + (text ? 'received' : 'empty'));
  if (!text) {
    send('voice:status', { sessionId: ptt.id, state: 'failed', retry: true, text: 'No complete transcript. Audio is held in this session for Retry.' });
    restoreKnotState(); return;
  }
  ptt.retryPcm = null;
  const turn = { sessionId: ptt.id, text, revision: ++ptt.revision, final: true, startSample: 0, endSample: pcm.length / 2 };
  publishVoiceTurn(turn);
  send('voice:status', { sessionId: ptt.id, state: 'done', retry: false });
  if (win.isVisible()) routeUtterance(text);
}

function routeUtterance(text) {
  const kind = classifyUtterance(text);
  if (kind.kind === 'dismiss') {
    if (activeNudge) endNudge('notnow');
    else if (guide && guide.active()) guide.dismiss('voice');
    else if (harness.active) guideDismiss('voice');
    else restoreKnotState();
    return;
  }
  if (kind.kind === 'next') {
    if (guidePointing()) guide.onAction('next'); else restoreKnotState();
    return;
  }
  if (guide && guide.active()) { return guide.followUp(text); }
  if (state.busy) { send('llm:busy', {}); restoreKnotState(); return; }
  flash('"' + text.slice(0, 60) + '"', 2500);
  // An unscoped voice question is a question, not permission to capture.
  runFeature('ask', kind.text, ptt.id);
}

// The chord's final key is what the probe watches for the release.
const PTT_FALLBACKS = ['CommandOrControl+Alt+Space', 'CommandOrControl+Shift+M', 'Alt+Shift+Space', 'CommandOrControl+Alt+M'];
function setPttShortcut(value) {
  const accelerator = String(value || '').trim();
  const parts = accelerator.split('+');
  if (parts.length < 2 || !/^(?:[A-Z0-9]|Space|F(?:[1-9]|1[0-9]|2[0-4]))$/i.test(parts[parts.length - 1]) || !parts.slice(0, -1).every(p => /^(CommandOrControl|Control|Command|Alt|Shift|Super)$/i.test(p))) return { ok: false, error: 'Use modifiers with a letter, number, Space, or function key.' };
  if (ptt.held) return { ok: false, error: 'Finish your voice question before changing the shortcut.' };
  if (accelerator === ptt.accelerator) return { ok: true, accelerator };
  if (RESERVED_SHORTCUTS.has(accelerator.toLowerCase()) || accelerator.toLowerCase() === String(store.getSettings().shortcuts.assist || '').toLowerCase()) return { ok: false, error: 'That shortcut is already used by Nūs.' };
  try {
    if (!globalShortcut.register(accelerator, pttStart)) return { ok: false, error: 'That shortcut is unavailable. Try another combination.' };
    const old = ptt.accelerator;
    store.setSettings({ shortcuts: { ptt: accelerator } });
    ptt.accelerator = accelerator; ptt.vk = vkOf(accelerator);
    if (old) globalShortcut.unregister(old);
    return { ok: true, accelerator };
  } catch (_) { globalShortcut.unregister(accelerator); return { ok: false, error: 'Could not save the voice shortcut.' }; }
}

function walkthroughNote(key) {
  const entry = getWalkthroughs().get(String(key));
  if (!entry) return { ok: false, error: 'That walkthrough is no longer saved.' };
  const note = require('../src/vault-notes').buildNote({ title: entry.task, started_at: new Date(entry.createdAt).toISOString(), ended_at: new Date(entry.lastOk).toISOString() }, entry.steps.map(step => ({ channel: 'nus', mode: 'guide', text: step.instruction })));
  const vault = require('../src/vault-notes');
  return { ok: true, ...note, dir: vault.notesDir(), vaultOk: vault.vaultAvailable() };
}
function vkOf(accelerator) {
  const key = String(accelerator || '').split('+').pop();
  if (/^space$/i.test(key)) return 32;
  if (/^[a-z]$/i.test(key)) return key.toUpperCase().charCodeAt(0);
  if (/^[0-9]$/.test(key)) return key.charCodeAt(0);
  if (/^F([1-9]|1[0-9]|2[0-4])$/i.test(key)) return 111 + Number(key.slice(1));
  return 32;
}
function registerPttShortcut() {
  const settings = store.getSettings();
  const wanted = (settings.shortcuts && settings.shortcuts.ptt) || DEFAULT_PTT_SHORTCUT;
  const candidates = [wanted, ...PTT_FALLBACKS.filter((c) => c !== wanted)];
  for (const accel of candidates) {
    if (RESERVED_SHORTCUTS.has(accel.toLowerCase()) && accel.toLowerCase() !== 'commandorcontrol+alt+space') continue;
    let ok = false;
    try { ok = globalShortcut.register(accel, pttStart); } catch (_) { ok = false; }
    if (!ok) continue;
    ptt.accelerator = accel;
    ptt.vk = vkOf(accel);
    const stt = createSTT(settings);
    console.log('[ptt] chord ' + accel + (accel !== wanted ? ' (wanted ' + wanted + ', not available)' : '') + ', transcription: ' + (stt.available ? stt.providers.join(' > ') : 'none'));
    return;
  }
  console.log('[ptt] could not register any push-to-talk chord; tried ' + candidates.join(', '));
}

// -------- guide harness (founder) --------
// Ctrl+Shift+T walks a fake three-step guide at the cursor so the strand can
// be felt and tuned before any screen reading or pointing model exists. Each
// press: amber read, then the thread unwinds to a box under the cursor. The
// fourth press finishes and offers the keep/skip chip. Esc winds it back
// while it is out (registered only for that window of time, then released).
const HARNESS_STEPS = ['Start here', 'Do this next', 'Do this instead'];
const HARNESS_TASKS = ['guide', 'nudge', 'ask', 'remember'];
const harness = { active: false, step: 0, run: 0, task: 'guide', esc: false, arrivedAt: 0 };

function cursorBox(w, h) {
  const p = screen.getCursorScreenPoint();
  const b = win.getBounds();
  return { x: p.x - b.x - w / 2, y: p.y - b.y - h / 2, w, h };
}
function armEsc() {
  if (harness.esc) return;
  try { harness.esc = globalShortcut.register('Escape', () => {
    if (inspection || inspectionPreparing) { clearInspection(); send('guide:done', { offerKeep: false }); if (guide && guide.status().state === 'paused') setTimeout(() => guide && guide.showPaused(), 900); return; }
    if (ptt.held || ptt.processing) { pttStop('cancel'); restoreKnotState(); }
    if (guide && guide.active()) guide.dismiss('esc');
    else if (activeNudge) endNudge('notnow');
    else guideDismiss('esc');
  }); } catch (_) { harness.esc = false; }
}
function disarmEsc() {
  if (!harness.esc) return;
  try { globalShortcut.unregister('Escape'); } catch (_) { /* already gone */ }
  harness.esc = false;
}
function guideDismiss(reason) {
  disarmEsc();
  const wasActive = harness.active;
  harness.active = false;
  harness.step = 0;
  if (wasActive) console.log('[companion] guide dismissed:', reason);
  send('guide:done', { sessionId: null, offerKeep: false });
}
function harnessStep() {
  if (!win || win.isDestroyed() || !win.isVisible()) return;
  if (!harness.active) {
    harness.active = true;
    harness.step = 0;
    harness.task = HARNESS_TASKS[harness.run++ % HARNESS_TASKS.length];
  }
  harness.step += 1;
  const total = HARNESS_STEPS.length;
  if (harness.step > total) {
    harness.active = false;
    disarmEsc();
    send('guide:state', { state: 'done', task: harness.task });
    send('guide:done', { sessionId: 'harness-' + harness.run, summary: 'Harness run', offerKeep: true });
    return;
  }
  send('guide:state', { state: 'reading', task: harness.task });
  // With the probe up, the harness points at the REAL control under the
  // cursor and names it; without it, a box at the cursor.
  const started = Date.now();
  controlUnderCursor().then((hit) => {
    if (hit?.blocked) { flash('Point at a non-sensitive area instead.'); return; }
    const wait = Math.max(0, 700 - (Date.now() - started));
    setTimeout(() => {
      if (!harness.active || !win || win.isDestroyed()) return;
      const label = hit && hit.name ? hit.name : '';
      const kind = hit && hit.type ? hit.type.toLowerCase() : '';
      send('guide:target', {
        bbox: hit ? hit.bbox : cursorBox(150, 30),
        task: harness.task,
        step: harness.step,
        stepCount: total,
        instruction: label ? `Click "${label}"` : (hit ? `Click this ${kind || 'control'}` : HARNESS_STEPS[harness.step - 1]),
        hint: hit
          ? `${kind || 'control'} in ${hit.window && hit.window.title ? hit.window.title.slice(0, 40) : 'the app'} via UI Automation (${hit.ms || '?'}ms). Ctrl+Shift+T advances, Esc winds back.`
          : (probeReady() ? 'Nothing interactive under the cursor. Ctrl+Shift+T advances, Esc winds back.' : 'Harness (no probe): Ctrl+Shift+T advances, Esc or a click on the Knot winds back.'),
      });
      armEsc();
    }, wait);
  });
}

// Windows click-through probe: while transparent + click-through, mouse-move
// forwarding is unreliable, so poll the cursor from main and let the renderer
// answer through companion:mouse:ignore. Skipped while the overlay is hidden.
let cursorProbeTimer = null;
// Windows strips WS_EX_TOPMOST from the overlay around a fullscreen window
// taking or leaving the foreground (a video, a game) and never gives it back,
// so the Knot ended up buried under ordinary windows: "the Companion
// disappeared". isAlwaysOnTop() does track the OS bit, so check it and only
// then re-assert. Never call setAlwaysOnTop(true) unconditionally: measured on
// Electron 43, that call made while another window is the foreground window
// REMOVES topmost and parks the overlay just beneath that window. Called while
// stripped it at least lifts the Knot to the top of the normal band, and it
// fully restores topmost as soon as the overlay itself is foreground (the
// user clicks the Knot), which the focus handler below catches immediately.
const TOPMOST_GUARD_TICKS = 16; // every ~2s at the 120ms probe cadence
let topmostTick = 0;
const FOREGROUND_POLL_TICKS = 8; // ~1s: the last real app in front, for asks typed at the Knot
let foregroundTick = 0;
let foregroundPolling = false;
let lastForeground = null; // { fg, at }
function reassertTopmost() {
  if (process.platform !== 'win32' || !win || win.isDestroyed() || !win.isVisible()) return;
  try { if (!win.isAlwaysOnTop()) restoreTopmost('guard'); } catch (_) { /* window mid-teardown */ }
}
// Measured 2026-09-10: focus() while a maximized app (monitor-sized, taskbar
// auto-hidden) is in front drops the overlay to the bottom of the z-order and
// clears its topmost bit, and Chromium then refuses HWND_TOPMOST from inside
// this process for as long as that window is up. The Windows probe (another
// process) can set it, and that is honoured at once. Electron's own call
// stays as the fallback when the probe is down.
let topmostRestoring = false;
async function restoreTopmost(why) {
  if (topmostRestoring || !win || win.isDestroyed()) return false;
  topmostRestoring = true;
  try {
    if (probeReady()) {
      const hwnd = win.getNativeWindowHandle().readUInt32LE(0);
      const r = await probe.request('win.topmost', { hwnd }, 1500);
      console.log('[companion] topmost restored via probe (' + why + '): ' + JSON.stringify(r));
      if (r && r.topmost) return true;
    }
  } catch (e) { console.log('[companion] probe topmost failed (' + why + '): ' + e.message); }
  finally { topmostRestoring = false; }
  try { if (win && !win.isDestroyed()) win.setAlwaysOnTop(true); } catch (_) {}
  return Boolean(win && !win.isDestroyed() && win.isAlwaysOnTop());
}
function startCursorProbe() {
  if (cursorProbeTimer) return; // never stack probes across enable/disable
  cursorProbeTimer = setInterval(() => {
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    if (++topmostTick >= TOPMOST_GUARD_TICKS) { topmostTick = 0; reassertTopmost(); }
    // Remember the last real app in front (about once a second) so an ask
    // typed at the Knot, which takes focus, still knows which app it is for.
    if (++foregroundTick >= FOREGROUND_POLL_TICKS) {
      foregroundTick = 0;
      if (probeReady() && !foregroundPolling) {
        foregroundPolling = true;
        probe.request('fg', { ignorePid: process.pid }, 1500).then((fg) => { if (fg && fg.hwnd && fg.pid !== process.pid) lastForeground = { fg, at: Date.now() }; }).catch(() => {}).finally(() => { foregroundPolling = false; });
      }
    }
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
//   captureAllowanceMs()                  remaining listening time for this plan
//   onCaptureEnd(meta)                    records elapsed listening time
//   onOutboxEvent()                       an outbox event was appended (live ingest)
//   audioRoot() -> path                   folder for opt-in retained audio
//   showDesktop()                         focus/reopen the desktop window
function initCompanion(providedHooks = {}) {
  hooks = providedHooks;

  const allowMedia = (webContents, permission) => {
    if (isTrustedCompanionWebContents(webContents)) {
      return permission === 'media' || permission === 'microphone' || permission === 'audioCapture' || permission === 'display-capture';
    }
    if (isTrustedDesktopWebContents(webContents)) {
      // Mic only for Knot voice chat. Never display-capture from the dashboard.
      return permission === 'media' || permission === 'microphone' || permission === 'audioCapture';
    }
    return false;
  };
  session.defaultSession.setPermissionRequestHandler((webContents, permission, cb) => cb(allowMedia(webContents, permission)));
  session.defaultSession.setPermissionCheckHandler((webContents, permission) => allowMedia(webContents, permission));
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    if (!isTrustedCompanionUrl(request?.frame?.url)) { callback(); return; }
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
    startProbe();
    startProactive();
  }

  return {
    show: forceShow,
    startTour: () => { forceShow(); send('tour:start', {}); return companionStatus(); },
    hide: () => { if (win && !win.isDestroyed() && win.isVisible()) toggleOverlay(); return companionStatus(); },
    toggle: () => { toggleOverlay(); return companionStatus(); },
    panic: () => { panicHide(); return companionStatus(); },
    toggleKnot,
    setCapturing: (v) => {
      const requested = Boolean(v);
      const result = setCapturing(requested);
      return requested && result === false ? { ...companionStatus(), error: captureFinalizing ? 'capture_finalizing' : (ptt.held || ptt.processing || (guide && guide.active())) ? 'companion_busy' : !createSTT(store.getSettings()).available ? 'voice_setup_required' : 'limit_companion_minutes' } : companionStatus();
    },
    isCapturing: () => state.capturing,
    isFinalizing: () => captureFinalizing,
    drainCapture: () => captureDrain,
    isEnabled: () => store.getSettings().companionEnabled !== false,
    disable: disableCompanion,
    enable: enableCompanion,
    status: companionStatus,
    unregisterShortcuts: () => globalShortcut.unregisterAll(),
  };
}

module.exports = { initCompanion };
