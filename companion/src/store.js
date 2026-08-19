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
  // Full-vault fallback through the Jarvis server (claude -p). 13 to 30 seconds,
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
  shortcuts: { assist: 'CommandOrControl+Return' },
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
  // Ctrl+Shift+K hides just the Knot mark; persisted so it survives restarts
  // and the desktop pane can always show the true state and restore it.
  knotHidden: false,
  // The Companion runs independently of the dashboard: closing the desktop
  // window leaves it on screen, and it comes back on the next launch. Turning
  // it off from the desktop Knot pane is the only thing that removes it, and
  // that choice persists until the user turns it back on.
  companionEnabled: true,
  apiKeys: { openai: '', anthropic: '', gemini: '', nvidia: '' },
  models: {
    openai: { fast: 'gpt-4o-mini', smart: 'gpt-4o' },
    anthropic: { fast: 'claude-3-5-haiku-latest', smart: 'claude-3-5-sonnet-latest' },
    gemini: { fast: 'gemini-2.5-flash', smart: 'gemini-2.5-pro' },
    nvidia: { fast: 'meta/llama-3.2-11b-vision-instruct', smart: 'meta/llama-3.2-90b-vision-instruct' }
  }
};

let data = null;

// Where the vault lives. Auto-discovery of briefing packs is a dev-machine
// convenience and ONLY runs when JARVIS_VAULT is set explicitly: a user who
// downloads Nūs must never inherit someone else's personal briefing.
const VAULT = process.env.JARVIS_VAULT || null;

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
    if (!fs.existsSync(FILE) && fs.existsSync(LEGACY_FILE)) {
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
  }
  catch { data = deepMerge(DEFAULTS, {}); }

  // First run: point at the vault's most recently built briefing so the app is
  // useful before anything is typed into Settings. Set JARVIS_VAULT to override.
  if (!data.packPath && !data.sparPath) {
    const found = findLatestBriefing();
    if (found) { data.packPath = found.pack; data.sparPath = found.spar; }
  }

  // Auto-switch provider if the current one has no key, but another one does.
  if (!data.apiKeys[data.provider]) {
    const validProviders = ['openai', 'anthropic', 'gemini', 'nvidia'];
    const active = validProviders.find(p => data.apiKeys[p]);
    if (active) {
      data.provider = active;
      // We don't save() here so we don't spam disk, it will persist on next save.
    }
  }

  if (legacyPlaintext || migrated) save(); // re-encrypt at rest under the new path
  return data;
}
function save() {
  try {
    const json = JSON.stringify(data, null, 2);
    if (safeStorage.isEncryptionAvailable()) {
      const payload = safeStorage.encryptString(json).toString('base64');
      fs.writeFileSync(FILE, JSON.stringify({ encrypted: true, payload }), { mode: 0o600 });
    } else {
      fs.writeFileSync(FILE, json, { mode: 0o600 });
    }
  } catch (e) { /* ignore */ }
}

module.exports = {
  getSettings() { return load(); },
  setSettings(patch) { load(); data = deepMerge(data, patch || {}); save(); return data; },
  // One-time note if the standalone Companion's settings could not be migrated.
  migrationNote() { load(); return migrationNote; }
};
