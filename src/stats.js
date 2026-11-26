// Anonymous usage stats. The contract is TELEMETRY-CONTRACT.md in the Growth
// OS repo (ventures/nus/growth-os); event names, props keys, copy and server
// behaviour all come from there. Change it there first.
//
// What leaves the machine: a random per-install UUID, which build sent it, an
// event name from a closed list, the app version, the platform, and a flat
// props object under allowed keys (campaign labels, which feature, which
// provider, minutes). Never coursework, never anything the user typed, never
// an email or account id. The id lives in <userData>/install_id.txt; deleting
// it, or turning stats off in Settings, ends the link.
//
// Every send is fire-and-forget: a 4 s timeout, at most one retry, and every
// failure is swallowed. Nothing here ever blocks the UI or shows the user an
// error.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const INSTALL_ID_FILE = 'install_id.txt';
const PRODUCT = 'desktop';
const SEND_TIMEOUT_MS = 4000;
const DAY_CHECK_MS = 15 * 60 * 1000;

// Preference keys (the desktop's SQLite preferences table, via the injected
// store). `stats_enabled` is the switch; the rest are once-only bookkeeping.
const KEY_ENABLED = 'stats_enabled';
const KEY_INSTALL_SENT = 'stats_install_sent';
const KEY_FIRST_ASK_SENT = 'stats_first_ask_sent';
const KEY_SOURCE_ASKED = 'stats_source_asked';

const EVENT_NAMES = new Set([
  'install', 'app_open', 'source_answer', 'first_import', 'import', 'first_ask', 'ask',
  'key_connected', 'companion_session', 'signin', 'limit_hit', 'upgrade_click',
  'checkout_started', 'stats_off',
]);
const PROP_KEYS = new Set([
  'acq_action_id', 'utm_source', 'utm_medium', 'utm_campaign', 'source', 'mode',
  'provider', 'minutes', 'method', 'unit', 'reason', 'os_version', 'locale',
]);
const SOURCES = new Set(['instagram', 'friend', 'reddit', 'x', 'youtube', 'search', 'other', 'skipped']);
const ASK_MODES = new Set(['voice', 'text', 'guide']);
const MAX_PROP_STRING = 80;
const MAX_PROPS_BYTES = 1024;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function localDay(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// Allowed keys only, scalar values only, short strings, 1 KB total. Anything
// else is dropped here so the server never sees a 400 for a client slip.
function sanitizeProps(props) {
  const out = {};
  if (!props || typeof props !== 'object') return out;
  for (const [key, value] of Object.entries(props)) {
    if (!PROP_KEYS.has(key)) continue;
    if (typeof value === 'boolean') out[key] = value;
    else if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    else if (typeof value === 'string' && value) out[key] = value.slice(0, MAX_PROP_STRING);
  }
  while (Buffer.byteLength(JSON.stringify(out), 'utf8') > MAX_PROPS_BYTES) {
    const keys = Object.keys(out);
    if (!keys.length) break;
    delete out[keys[keys.length - 1]];
  }
  return out;
}

// Reads <userData>/install_id.txt, or makes a fresh UUID v4 and writes it.
// Returns { id, created }. A missing or damaged file means a new id, and the
// caller treats that as a fresh install.
function readOrCreateInstallId(userDataDir) {
  const file = path.join(userDataDir, INSTALL_ID_FILE);
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (UUID_RE.test(existing)) return { id: existing.toLowerCase(), created: false };
  } catch {}
  const id = crypto.randomUUID();
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(file, id + '\n');
  } catch {
    // Unwritable userData: still return an id for this process so the app
    // works; it will simply look like a new install next time.
  }
  return { id, created: true };
}

/**
 * @param {object} options
 * @param {string} options.userData           the app's userData dir
 * @param {{supabase:{url:string}}} options.config
 * @param {string} options.appVersion
 * @param {{get:(key:string)=>any, set:(key:string,value:any)=>void}} options.store  preferences
 * @param {boolean} options.packaged          app.isPackaged
 * @param {object} [options.env]              process.env
 * @param {string} [options.platform]
 * @param {Function} [options.fetchImpl]
 * @param {Function} [options.now]            () => Date
 * @param {Function} [options.setTimer]       setInterval replacement for tests
 * @param {Function} [options.clearTimer]
 */
function createStats({
  userData,
  config,
  appVersion = null,
  store,
  packaged = false,
  env = process.env,
  platform = process.platform,
  fetchImpl = global.fetch,
  now = () => new Date(),
  setTimer = setInterval,
  clearTimer = clearInterval,
} = {}) {
  const prefs = store || { get: () => undefined, set: () => {} };
  const endpoint = config && config.supabase && config.supabase.url
    ? `${String(config.supabase.url).replace(/\/+$/, '')}/functions/v1/track`
    : null;

  // NUS_STATS=0 always wins (tests, smoke runs, CI). Unpackaged dev runs send
  // nothing unless NUS_STATS=1, so hacking on the app never pollutes the data.
  //
  // Personal build: this is unconditional. Upstream let a packaged install send
  // unless NUS_STATS=0; here nothing is transmitted whatever the build or the
  // environment, because the telemetry belongs to someone else's product and
  // this machine is not a participant in it. The rest of the module is left
  // intact so status(), ask() and track() keep their shapes and callers do not
  // need to know telemetry is off.
  const envDisabled = true;

  let installId = null;
  let lastOpenDay = null;
  let dayTimer = null;
  const pending = new Set();

  function getInstallId() {
    if (installId) return installId;
    const result = readOrCreateInstallId(userData);
    installId = result.id;
    // A new id is a new install as far as the server is concerned, even if an
    // older preferences row says `install` already went out.
    if (result.created && prefs.get(KEY_INSTALL_SENT) === true) {
      try { prefs.set(KEY_INSTALL_SENT, false); } catch {}
    }
    return installId;
  }

  function isEnabled() {
    let value;
    try { value = prefs.get(KEY_ENABLED); } catch { value = undefined; }
    return value !== false;
  }

  function isActive() {
    return Boolean(endpoint) && !envDisabled && isEnabled() && typeof fetchImpl === 'function';
  }

  async function post(body) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = setTimeout(() => { if (controller) controller.abort(); }, SEND_TIMEOUT_MS);
    if (timer.unref) timer.unref();
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller ? controller.signal : undefined,
      });
      return { status: Number(response && response.status) || 0 };
    } catch {
      return { status: null };
    } finally {
      clearTimeout(timer);
    }
  }

  // Resolves to { sent, ok, status }. `sent` means the server answered at all
  // (204, 400, 429 all count: the event will not be retried); `ok` means it
  // was accepted. A network failure or timeout retries once, then gives up.
  async function track(name, props) {
    const skipped = { sent: false, ok: false, status: null };
    if (!EVENT_NAMES.has(name)) return skipped;
    if (!isActive()) return skipped;
    const body = {
      install_id: getInstallId(),
      product: PRODUCT,
      name,
      app_version: appVersion,
      platform,
      props: sanitizeProps(props),
    };
    let result = await post(body);
    if (result.status === null || result.status >= 500) result = await post(body);
    if (result.status === null) return skipped;
    return { sent: true, ok: result.status === 204, status: result.status };
  }

  // Once-only events keyed on a preference flag, written only after the
  // server answered, so an offline first run tries again next time.
  async function trackOnce(name, flagKey, props) {
    const skipped = { sent: false, ok: false, status: null };
    let already;
    try { already = prefs.get(flagKey) === true; } catch { already = false; }
    if (already || pending.has(flagKey)) return skipped;
    pending.add(flagKey);
    try {
      const result = await track(name, props);
      if (result.sent) { try { prefs.set(flagKey, true); } catch {} }
      return result;
    } finally {
      pending.delete(flagKey);
    }
  }

  // app_open: once per process start, then once per local calendar day while
  // the app stays alive in the tray. The server dedupes per UTC day on top.
  function openIfNewDay(props) {
    const today = localDay(now());
    if (lastOpenDay === today) return Promise.resolve({ sent: false, ok: false, status: null });
    lastOpenDay = today;
    return track('app_open', props);
  }

  // Boot: make sure the id exists, send `install` on the first run ever,
  // `app_open` for this process, and start the daily check.
  function start(openProps) {
    getInstallId();
    trackOnce('install', KEY_INSTALL_SENT, {}).catch(() => {});
    openIfNewDay(openProps).catch(() => {});
    if (!dayTimer) {
      dayTimer = setTimer(() => { openIfNewDay(openProps).catch(() => {}); }, DAY_CHECK_MS);
      if (dayTimer && dayTimer.unref) dayTimer.unref();
    }
  }

  function stop() {
    if (dayTimer) { clearTimer(dayTimer); dayTimer = null; }
  }

  // The first answered question or voice command is `first_ask`; every later
  // one is `ask` with its mode.
  function ask(mode) {
    const props = ASK_MODES.has(mode) ? { mode } : {};
    let first;
    try { first = prefs.get(KEY_FIRST_ASK_SENT) !== true && !pending.has(KEY_FIRST_ASK_SENT); } catch { first = false; }
    if (first) return trackOnce('first_ask', KEY_FIRST_ASK_SENT, props);
    return track('ask', props);
  }

  // Turning stats off sends `stats_off` once, then nothing, ever, until the
  // switch comes back on. Turning on sends nothing by itself; the next boot or
  // day tick sends app_open as usual.
  async function setEnabled(enabled) {
    const next = Boolean(enabled);
    if (!next && isEnabled()) {
      await track('stats_off', {}).catch(() => {});
      try { prefs.set(KEY_ENABLED, false); } catch {}
    } else if (next && !isEnabled()) {
      try { prefs.set(KEY_ENABLED, true); } catch {}
    }
    return status();
  }

  // The one-click "Where did you hear about Nūs?" row. Asked once per install;
  // Skip is an answer too.
  function sourceAsked() {
    try { return prefs.get(KEY_SOURCE_ASKED) === true; } catch { return false; }
  }

  async function answerSource(source) {
    const value = SOURCES.has(source) ? source : 'skipped';
    try { prefs.set(KEY_SOURCE_ASKED, true); } catch {}
    const result = await track('source_answer', { source: value });
    return { ok: true, sent: result.sent };
  }

  function status() {
    return {
      enabled: isEnabled(),
      active: isActive(),
      envDisabled,
      installId: getInstallId(),
      // Only ask the question when an answer could actually be sent.
      askSource: isActive() && !sourceAsked(),
    };
  }

  return { track, trackOnce, start, stop, ask, setEnabled, answerSource, status, getInstallId, isEnabled, isActive };
}

module.exports = {
  createStats,
  sanitizeProps,
  readOrCreateInstallId,
  localDay,
  EVENT_NAMES,
  PROP_KEYS,
  SOURCES,
  ASK_MODES,
  INSTALL_ID_FILE,
  KEY_ENABLED,
  KEY_INSTALL_SENT,
  KEY_FIRST_ASK_SENT,
  KEY_SOURCE_ASKED,
};
