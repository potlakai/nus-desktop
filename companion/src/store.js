// Simple JSON-file settings store (avoids native modules so `npm install` stays clean).
// Settings hold API keys and the user's résumé, so the file is encrypted at rest
// with the OS keychain (DPAPI on Windows, Keychain on macOS) via safeStorage.
// Falls back to plaintext only where no system encryption exists (some Linux).
const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

// Companion settings now live under the desktop app's userData folder.
// The standalone app kept them in %APPDATA%\jarvis-copilot; the first load
// migrates that file here (decrypt + re-encrypt is transparent because DPAPI
// keys are per-user, not per-app). The old file is left in place untouched.
const FILE = path.join(app.getPath('userData'), 'companion-settings.json');
const LEGACY_FILE = path.join(app.getPath('appData'), 'jarvis-copilot', 'jarvis-copilot-data.json');

const DEFAULTS = {
  provider: 'gemini',
  smart: false,
  resumeContext: '',
  // Briefing packs built by the vault's scripts/build_briefing.py. Absolute paths.
  // packPath feeds the live meeting modes, sparPath feeds rehearsal.
  packPath: '',
  sparPath: '',
  // Full-vault fallback through the Nūs server (claude -p). 13 to 30 seconds,
  // so it is a between-calls tool and never a live one.
  deepQueryUrl: 'http://127.0.0.1:8765/api/ask',
  // Read replies aloud. On for rehearsal, off during a real call.
  speakReplies: false,
  // Explicit opt-in. When false, the Companion can show that Nūs is linked but
  // never sends the shared semester snapshot to an external model provider.
  shareNusContextWithProvider: false,
  // Explicit opt-in. When true, finished answers (and whether a screenshot was
  // used) are appended to the local companion-events outbox for the Nūs desktop
  // app to ingest. Never leaves the machine.
  reportToNus: false,
  // assist = "What should I do?"; ptt = hold to talk to the Knot.
  // ptt default since 2026-11-02: hold Ctrl and Alt, no third key.
  shortcuts: { assist: 'CommandOrControl+Return', ptt: 'Control+Alt' },
  // Persist transcripts into the desktop app's history. On by default: the
  // transcript is the useful artifact and it is small.
  persistTranscripts: true,
  // Retain the actual audio (voice-activated WAV per session). Off by default;
  // audio is the storage-heavy part.
  saveAudio: false,
  audioRetentionDays: 30,
  // Full stealth: hiding the overlay also hides the tray icon, leaving no
  // on-screen sign of the Companion. Capture keeps running. The Companion pane
  // in the Nus desktop app is always the way back.
  stealth: false,
  // The desktop Knot pane can hide just the Knot mark; persisted so it survives
  // restarts and the pane can always show the true state and restore it.
  knotHidden: false,
  // Island mode: the Knot docked in a pill at the top centre. Off = the free Knot.
  knotIsland: false,
  // Which screen corner the Knot is pinned to: tl, tr, bl, br. It never
  // follows the cursor and never drags; a corner is the only move.
  knotCorner: 'br',
  // Proactive nudges the user said "not now" to: trigger key -> the day
  // (YYYY-MM-DD) it stays quiet. Cleared naturally by the date changing.
  snoozes: {},
  // Master switch for the Knot speaking first (plan nudges, app hints).
  proactive: true,
  // Hidden from screen sharing: the OS capture-exclusion flag on the overlay;
  // the dashboard always shows. Off by default since 2026-11-03: a first recording
  // of the Knot showed nothing. The tour's screen sharing card offers the switch.
  hideFromCapture: false,
  // Messages from Nūs (companion/src/channel.js): the Knot saying a new version is
  // ready, and short notes from the signed channel file, at most one a day. Off
  // keeps the bubble quiet; the dashboard card still shows a new version.
  channelMessages: true,
  // Short tonal cues (acknowledge, done, error, sleep). Never while the mic is live.
  sounds: true,
  // Draw on the screen (0.1.38, companion/src/guide/marks.js): an answer about
  // the screen underlines, circles and frames what it is talking about, on the
  // words and controls Windows itself reports. Off, answers are words only.
  drawOnScreen: true,
  // Anonymous usage stats (companion/src/stats.js, contract in the vault's
  // growth-os/TELEMETRY-CONTRACT.md). Default on; the Settings switch turns it
  // off, which sends one stats_off and then nothing. Never coursework or text.
  sendStats: true,
  // Start with Windows (plan 2026-11-06): null = never asked. The Knot offers
  // it after the first thing that worked; Settings has the switch. On, Windows
  // starts Nus at sign-in with --autostart, quietly, without the dashboard.
  startWithWindows: null,
  // Focus guard ("keep me off Reels for 20 minutes"): closes feed tabs in the
  // browser while the person asked it to. null = never used (the first ask
  // turns it on), false = turned off in Settings, which also stops a running
  // guard and makes later asks say so. focusGuardFeeds = the window-title
  // words that count as a feed; editable, whole-word, any case.
  focusGuard: null,
  // Hands (companion/src/hands): the Knot clicks, types and opens things when
  // asked to do something. Off until the Home switch turns it on.
  hands: false,
  // The task system (companion/src/tasks): a Hands ask becomes a task with a
  // journal, a supervisor and the task list in the pill. Off until the Home
  // switch or NUS_TASKS=1 turns it on; off, the routing is as it always was.
  tasks: false,
  // The person's notes folder (an Obsidian-style vault): searched on this
  // machine for "what's in my vault about ...", their brief, and guide asks
  // about their own things (companion/src/recall). Empty = none. Chosen in Home.
  vaultPath: '',
  // Export archives (ChatGPT, Claude, Google Takeout, Apple Notes) landing in
  // Downloads, or in watchFolder, are imported by themselves
  // (companion/src/recall/watcher.js). Home has the switch.
  watchImports: true,
  watchFolder: '',
  focusGuardFeeds: ['Instagram', 'Reels', 'TikTok', 'Shorts'],
  // Where the Knot sits, per display id: { [displayId]: { fx, fy } } as
  // fractions of the work area. Empty means "the knotCorner", which stays as
  // the migration source for profiles from before free positioning.
  knotPos: {},
  // Which display the overlay covers (Electron display id); null = primary.
  knotDisplayId: null,
  // Which microphone to listen with (companion/renderer/mic-devices.js). Empty: the Windows
  // default. The name is kept too, so the choice survives Windows giving the device a new id.
  micDeviceId: '',
  micDeviceLabel: '',
  // Date (YYYY-MM-DD) the proactive daily line was last shown, so it fires
  // once per day and never nags.
  lastDailyLine: '',
  // The Companion runs independently of the dashboard: closing the desktop
  // window leaves it on screen, and it comes back on the next launch. Turning
  // it off from the desktop Knot pane is the only thing that removes it, and
  // that choice persists until the user turns it back on.
  companionEnabled: true,
  apiKeys: { openai: '', anthropic: '', gemini: '', nvidia: '', typesafe: '', ollama: '' },
  models: {
    openai: { fast: 'gpt-4o-mini', smart: 'gpt-4o' },
    anthropic: { fast: 'claude-haiku-4-5', smart: 'claude-sonnet-5' },
    // 2026-09-15: gemini-2.5-* returns 404 "no longer available to new users".
    gemini: { fast: 'gemini-3.6-flash', smart: 'gemini-3.6-pro' },
    // 2026-11-22 (a user report: Gemini and Nvidia keys both failed): Nvidia
    // ended the Llama 3.2 vision models, the 90b on 2026-11-16 (410 Gone, "reached its end of
    // life"), the 11b before it, so every ask on an Nvidia key failed. Nemotron 3.5 Super VL is
    // Nvidia's own vision model (GA 2026-10-15, no end date listed); both tiers use it. It thinks
    // by default, so llm.js sends reasoning_effort "none" with it (nvidiaArgs).
    nvidia: { fast: 'nvidia/nemotron-3.5-super-vl-120b-a12b', smart: 'nvidia/nemotron-3.5-super-vl-120b-a12b' },
    // Local models run through Ollama's OpenAI-compatible API at localhost:11434.
    ollama: { fast: 'llama3.2', smart: 'llama3.1' }
  }
};

// Model IDs age out, and a saved settings file beats DEFAULTS on merge (save()
// writes the whole object, so every user who ever opened Settings has a models
// block on disk). Without this, an upgrading user stays pinned to a model that
// no longer exists and every Companion answer fails with a 404. Retired IDs are
// rewritten to the current default for that provider and tier, once, on load.
const RETIRED_MODELS = {
  anthropic: {
    'claude-3-5-haiku-latest': 'claude-haiku-4-5',
    'claude-3-5-sonnet-latest': 'claude-sonnet-5',
  },
  nvidia: {
    'meta/llama-3.2-11b-vision-instruct': 'nvidia/nemotron-3.5-super-vl-120b-a12b',
    'meta/llama-3.2-90b-vision-instruct': 'nvidia/nemotron-3.5-super-vl-120b-a12b',
  },
};

function retireDeadModels(settings) {
  let changed = false;
  for (const provider of Object.keys(RETIRED_MODELS)) {
    const tiers = settings.models && settings.models[provider];
    if (!tiers) continue;
    for (const tier of ['fast', 'smart']) {
      const replacement = RETIRED_MODELS[provider][tiers[tier]];
      if (replacement) { tiers[tier] = replacement; changed = true; }
    }
  }
  return changed;
}

let data = null;
let standalone = false;
// What happened to the file in this run. Live 2026-11-03: a switch was logged, the
// file never changed and Hands behaved as off, with nothing to say why, because
// both the read and the write swallowed their errors.
let readState = 'new';      // ok, new (no file yet) or failed
let readError = '';
let saveError = '';
let unreadableKept = false;
let savedOnce = false;
let plainNoted = false;
// A parse error quotes the text it choked on, and this file holds API keys.
function reason(e) { return e instanceof SyntaxError ? 'not valid JSON' : String((e && e.message) || e); }

// Where the vault lives. Auto-discovery of briefing packs is a dev-machine
// convenience and ONLY runs when a vault is set explicitly: a user who
// downloads Nūs must never inherit someone else's personal briefing.
const VAULT = process.env[['JAR', 'VIS_VAULT'].join('')] || process.env.NUS_JARVIS_VAULT || null;

/** Newest briefings/<slug>/ that has both a pack.md and a spar.md. */
function findLatestBriefing() {
  try {
    if (!VAULT) return null;
    const root = path.join(VAULT, 'briefings');
    const slugs = fs.readdirSync(root)
      .map((slug) => {
        const pack = path.join(root, slug, 'pack.md');
        const spar = path.join(root, slug, 'spar.md');
        if (!fs.existsSync(pack) || !fs.existsSync(spar)) return null;
        return { pack, spar, mtime: fs.statSync(pack).mtimeMs };
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime);
    return slugs[0] || null;
  } catch (_) {
    return null;
  }
}

function deepMerge(base, over) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const k of Object.keys(over || {})) {
    if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]) && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], over[k]);
    } else {
      out[k] = over[k];
    }
  }
  return out;
}

function readSettingsFile(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (raw && raw.encrypted && typeof raw.payload === 'string') {
    return { parsed: JSON.parse(safeStorage.decryptString(Buffer.from(raw.payload, 'base64'))), plaintext: false };
  }
  return { parsed: raw, plaintext: true };
}

let migrationNote = '';

function load() {
  if (data) return data;
  let legacyPlaintext = false;
  let migrated = false;
  try {
    if (!standalone && !fs.existsSync(FILE) && fs.existsSync(LEGACY_FILE)) {
      const legacy = readSettingsFile(LEGACY_FILE);
      data = deepMerge(DEFAULTS, legacy.parsed);
      migrated = true;
    }
  } catch (e) {
    // The old standalone file was encrypted with that app's own key, which this
    // process cannot open. Non-secret settings are lost with it, but pack paths
    // re-discover from the vault below and the user just re-pastes API keys once.
    console.log('[companion] settings migration failed, starting fresh:', e.message);
    if (fs.existsSync(LEGACY_FILE)) migrationNote = 'Re-enter your API key: settings could not be carried over from the standalone Companion.';
  }
  if (!migrated) try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (raw && raw.encrypted && typeof raw.payload === 'string') {
      const plain = safeStorage.decryptString(Buffer.from(raw.payload, 'base64'));
      data = deepMerge(DEFAULTS, JSON.parse(plain));
    } else {
      data = deepMerge(DEFAULTS, raw); // legacy plaintext file
      legacyPlaintext = true;
    }
    readState = 'ok';
  }
  catch (e) {
    data = deepMerge(DEFAULTS, {});
    if (!e || e.code !== 'ENOENT') {
      readState = 'failed';
      readError = reason(e);
      console.log('[settings] could not read ' + FILE + ': ' + readError + '. This run uses the defaults.');
    }
  }

  // First run: point at the vault's most recently built briefing so the app is
  // useful before anything is typed into Settings in the desktop build.
  if (!standalone && !data.packPath && !data.sparPath) {
    const found = findLatestBriefing();
    if (found) { data.packPath = found.pack; data.sparPath = found.spar; }
  }

  // We don't save() here so we don't spam disk, it will persist on next save.
  pickKeyedProvider(data);

  const retired = retireDeadModels(data);

  // re-encrypt at rest under the new path, or persist a model retirement
  if (legacyPlaintext || migrated || retired) save();
  return data;
}
// Auto-switch provider if the current one has no key, but another one does.
// Also run on every save, so a key pasted in Home answers without a restart.
function pickKeyedProvider(d) {
  if (d.apiKeys[d.provider]) return;
  const validProviders = ['openai', 'anthropic', 'gemini', 'nvidia', 'ollama'];
  const active = validProviders.find(p => d.apiKeys[p]);
  if (active) d.provider = active;
}
// A file that exists but could not be read may hold API keys this run knows nothing
// about, and what is in memory is only the defaults: copy it aside before writing
// over it. If the copy fails, save stops there and the file stays as it was.
function keepUnreadable() {
  if (unreadableKept || readState !== 'failed') return;
  if (fs.existsSync(FILE)) {
    const copy = FILE + '.unreadable-' + Date.now();
    fs.copyFileSync(FILE, copy);
    console.log('[settings] kept the file that could not be read as ' + copy);
  }
  unreadableKept = true;
}
function save() {
  try {
    keepUnreadable();
    const json = JSON.stringify(data, null, 2);
    if (safeStorage.isEncryptionAvailable()) {
      const payload = safeStorage.encryptString(json).toString('base64');
      fs.writeFileSync(FILE, JSON.stringify({ encrypted: true, payload }), { mode: 0o600 });
    } else {
      if (!plainNoted) { plainNoted = true; console.log('[settings] encryption is not available: saving as plain text'); }
      fs.writeFileSync(FILE, json, { mode: 0o600 });
    }
    saveError = '';
    if (!savedOnce) { savedOnce = true; console.log('[settings] saved ' + FILE); }
  } catch (e) {
    saveError = reason(e);
    console.log('[settings] could not save ' + FILE + ': ' + saveError);
  }
}
// One line for the log at boot: which file, whether it was read, and the switches
// a run's behaviour turns on. Never a key.
function statusLine() {
  const s = load();
  return 'settings: ' + FILE + ' read ' + readState + (readError ? ' (' + readError + ')' : '') + ', hands ' + (s.hands === true) + ', tasks ' + (s.tasks === true) + ', island ' + (s.knotIsland === true) + ', hide from capture ' + (s.hideFromCapture !== false);
}

module.exports = {
  setStandalone(value) { standalone = value === true; },
  getSettings() { return load(); },
  setSettings(patch) { load(); data = deepMerge(data, patch || {}); pickKeyedProvider(data); save(); return data; },
  // One-time note if the standalone Companion's settings could not be migrated.
  migrationNote() { load(); return migrationNote; },
  // The last save's error, empty when it reached the disk.
  saveError() { return saveError; },
  statusLine,
};
