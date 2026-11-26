// Selective settings sync for the optional account (docs/accounts-b.md,
// stage 4). Off until the person ticks "Sync my settings" on the Account
// card. Only the keys below ever leave, each as { v, at }: never API keys,
// memory, vault or folder paths, transcripts, chats or anything typed.
//
// Conflicts: last write wins, per key, by the time of the change. Ticking the
// box on a computer takes what the account already holds (that is the point
// of turning it on there) and adds what the account does not have yet. After
// that a change made here is stamped with the time it was seen and wins over
// anything older. Hands is the one exception: only "off" syncs, so a new
// computer never gets the clicking agent switched on without a tick there.
//
// Electron-free: the host passes the account, a settings reader, an apply
// function (which goes through the same validation as Home's own switches),
// and where to keep the sync state (the preferences table).
const KEYS = ['ptt', 'voice', 'knotIsland', 'knotCorner', 'proactive', 'sounds', 'focusGuard', 'focusGuardFeeds', 'hands'];
const LABELS = 'talk key, voice, island mode, Knot corner, nudges, sounds, focus guard and its feeds, Hands off';
const CORNERS = ['tl', 'tr', 'bl', 'br'];

const isBool = v => typeof v === 'boolean';
const VALID = {
  ptt: v => typeof v === 'string' && v.length > 0 && v.length <= 60 && /^[A-Za-z0-9+]+$/.test(v),
  voice: v => v === 'system' || v === 'fable',
  knotIsland: isBool, proactive: isBool, sounds: isBool, focusGuard: isBool,
  knotCorner: v => CORNERS.includes(v),
  focusGuardFeeds: v => Array.isArray(v) && v.length <= 20 && v.every(x => typeof x === 'string' && x.length > 0 && x.length <= 40),
  hands: v => v === false,
};

// The syncable view of the settings object. A value that is not syncable
// right now (Hands on, focus guard never used) is left out.
function pick(s) {
  const out = {
    ptt: s && s.shortcuts && s.shortcuts.ptt, voice: (s && s.voice) || 'system', knotIsland: s && s.knotIsland, knotCorner: s && s.knotCorner,
    proactive: s && s.proactive, sounds: s && s.sounds, focusGuard: s && s.focusGuard, focusGuardFeeds: s && s.focusGuardFeeds, hands: s && s.hands,
  };
  for (const k of KEYS) if (!VALID[k](out[k])) delete out[k];
  return out;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * @param {object} o
 * @param {{status: () => object, call: Function}} o.account
 * @param {() => object} o.settings
 * @param {(patch: object) => any} o.apply   keys from KEYS with checked values
 * @param {{get: () => object|null, set: (v: object) => void}} o.memory
 * @param {() => number} [o.now]
 */
function createSync(o) {
  const now = o.now || Date.now;
  let running = null;
  let lastError = '';
  let offline = false;

  function load() { let s = null; try { s = o.memory.get(); } catch { s = null; } return s && typeof s === 'object' ? s : { on: false }; }
  function save(s) { try { o.memory.set(s); } catch { /* next sync rebuilds it */ } }

  function setOn(on) {
    const s = load();
    // Every switch-on starts clean: what the account holds wins, once.
    save(on ? { on: true, userId: o.account.status().userId, values: {}, at: {}, version: 0, lastSyncAt: null } : { ...s, on: false });
    lastError = '';
    return on ? sync() : Promise.resolve(status());
  }

  async function run() {
    const a = o.account.status();
    let s = load();
    if (!s.on || !a.signedIn) return status();
    if (s.userId !== a.userId) s = { on: true, userId: a.userId, values: {}, at: {}, version: 0, lastSyncAt: null };
    const values = { ...(s.values || {}) }, at = { ...(s.at || {}) };
    const local = pick(o.settings());
    // A value that moved since the last sync is a change made here, now.
    for (const k of KEYS) {
      if (!(k in local)) continue;
      const j = JSON.stringify(local[k]);
      if (values[k] === undefined) { values[k] = j; at[k] = at[k] || 0; }
      else if (values[k] !== j) { values[k] = j; at[k] = now(); }
    }
    const got = await o.account.call('/rest/v1/user_settings?select=settings,version', { method: 'GET' });
    if (got.status === 0) { offline = true; save({ ...s, values, at }); return status(); }
    if (got.status !== 200) { lastError = 'Settings sync is not available yet. Nūs tries again later.'; save({ ...s, values, at }); return status(); }
    offline = false;
    const row = Array.isArray(got.json) ? got.json[0] : null;
    const remote = (row && row.settings && typeof row.settings === 'object') ? row.settings : {};
    const toApply = {}, toPush = {};
    for (const k of KEYS) {
      const r = remote[k];
      const rAt = r && Number.isFinite(Number(r.at)) ? Number(r.at) : -1;
      const la = Number(at[k]) || 0;
      // A tie (two computers stamped the same millisecond) goes to the
      // account, so every computer ends on the same value.
      if (r && VALID[k](r.v) && (rAt > la || (rAt === la && !same(r.v, local[k])))) {
        if (!same(r.v, local[k])) toApply[k] = r.v;
        at[k] = rAt;
      } else if (k in local && (!r || la > rAt)) {
        const stamp = la || now();
        toPush[k] = { v: local[k], at: stamp };
        at[k] = stamp;
      }
    }
    let version = Number(row && row.version) || 0;
    if (Object.keys(toPush).length) {
      const put = await o.account.call('/rest/v1/rpc/put_settings', { body: { patch: toPush } });
      if (put.status === 0) { offline = true; save({ ...s, values, at }); return status(); }
      if (put.status !== 200) { lastError = 'Nūs could not save your settings to your account. It tries again later.'; save({ ...s, values, at }); return status(); }
      version = Number(put.json && put.json.version) || version;
    }
    if (Object.keys(toApply).length) { try { await o.apply(toApply); } catch { /* a value the host refused stays local */ } }
    // The baseline is what the settings hold after applying, so a value the
    // host normalised is not mistaken for a change made here.
    const after = pick(o.settings());
    for (const k of KEYS) if (k in after) values[k] = JSON.stringify(after[k]);
    lastError = '';
    save({ on: true, userId: a.userId, values, at, version, lastSyncAt: new Date(now()).toISOString() });
    return { ...status(), applied: Object.keys(toApply), pushed: Object.keys(toPush) };
  }

  function sync() {
    if (running) return running;
    running = run().catch(() => status()).finally(() => { running = null; });
    return running;
  }

  function status() {
    const s = load();
    return { syncOn: !!s.on, syncLastAt: s.lastSyncAt || null, syncOffline: offline, syncError: lastError, syncKeys: LABELS };
  }

  return { sync, setOn, status };
}

module.exports = { createSync, pick, KEYS, LABELS, VALID };
