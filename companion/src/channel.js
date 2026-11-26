'use strict';
// One small channel from Nūs to an installed Companion: a daily fetch of one
// static signed JSON file that says what the newest version is and carries a
// few short messages. Full design: docs/update-channel.md.
//
// What the file can do is decided here, not in the file. It can name a version
// and a hash, and put plain text and one link in the Knot's bubble. It cannot
// run a command, change a setting, reach the model or the task runner, or open
// anything but a Nūs link: there is no field for any of that, unknown fields
// are dropped by parseManifest, and only { id, text, link } ever leaves it.
//
// The file is an envelope, { key, body, sig }: `body` is the JSON as one string
// and `sig` is an Ed25519 signature over exactly those bytes, from a private
// key kept off GitHub. An unsigned, altered or older file is thrown away whole,
// so whoever can write to the website or the release page still cannot speak
// through the Knot or swap the installer. Electron-free, so node --test runs it.
const crypto = require('crypto');
const { newer, parse } = require('./updates');

const CHANNEL_URL = 'https://potlakai.github.io/nus/companion/channel.json';
// Public half of the signing key(s), SPKI DER in base64, by name. More than one
// lets a new key be rolled in by a release before the old one is retired.
const PUBLIC_KEYS = { 'nus-channel-2026-a': 'MCowBQYDK2VwAyEA0744sbI3IupENJUhNEM1qqB7WGzFL9pnYMaXADfYLsM=' };
const INSTALLER_BASE = 'https://github.com/potlakai/nus-desktop/releases/download/';
// The only places a message may link to, and a release page may be. No Nūs
// domain of its own exists yet; add it here when it does.
const LINK_RULES = [
  { host: 'potlakai.github.io', prefix: '/nus' },
  { host: 'github.com', prefix: '/potlakai/nus-desktop/releases' },
];
const DAY_MS = 86400000;
const WEEK_MS = 7 * DAY_MS;
const TIMEOUT_MS = 8000;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_TEXT = 240;
const MAX_MESSAGES = 20;
const MAX_SHOWN_IDS = 200;
const ID_RE = /^n[0-9]{1,6}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const SHA512_RE = /^[A-Za-z0-9+/]{86}==$/;
// C0 and C1 controls, and the marks that reverse or hide text.
// eslint-disable-next-line no-control-regex
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/;

// Packaged test builds carry their own URL, keys and installer base in
// package.json (scripts/update-test), so a real update can be run on this
// computer. The release config has no such block, and a test asserts that.
function channelConfig(pkg) {
  const b = (pkg && pkg.nusBuild) || {};
  return {
    url: b.channelUrl || CHANNEL_URL,
    keys: b.channelKeys || PUBLIC_KEYS,
    installerBase: b.installerBase || INSTALLER_BASE,
  };
}

// -> the link as a clean string, or null. https, no login part, no port, one of
// the allowed places, and on a path boundary so /nusty is not /nus.
function safeLink(value) {
  if (typeof value !== 'string' || value.length > 300) return null;
  let u;
  try { u = new URL(value); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
  const ok = LINK_RULES.some(r => u.hostname === r.host && (u.pathname === r.prefix || u.pathname.startsWith(r.prefix + '/')));
  return ok ? u.href : null;
}

function safeText(value) {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  return t && t.length <= MAX_TEXT && !UNSAFE_TEXT.test(t) ? t : null;
}

function safeVersion(value) { return typeof value === 'string' && VERSION_RE.test(value) ? value : null; }

// Inclusive; either end may be missing. A bad bound drops the message rather
// than widening who sees it.
function safeRange(range) {
  if (range == null) return {};
  if (typeof range !== 'object' || Array.isArray(range)) return null;
  const out = {};
  for (const key of ['min', 'max']) {
    if (range[key] == null) continue;
    if (!safeVersion(range[key])) return null;
    out[key] = range[key];
  }
  return out;
}

function inRange(version, range) {
  if (!parse(version)) return false;
  if (range.min && newer(range.min, version)) return false;
  if (range.max && newer(version, range.max)) return false;
  return true;
}

function safeMessage(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
  const id = typeof m.id === 'string' && ID_RE.test(m.id) ? m.id : null;
  const text = safeText(m.text);
  const versions = safeRange(m.versions);
  const ends = typeof m.ends === 'string' && DAY_RE.test(m.ends) && Number.isFinite(Date.parse(m.ends + 'T23:59:59Z')) ? m.ends : null;
  if (!id || !text || !versions || !ends) return null;
  // A message may have no link. One that has a link we would not open is wrong,
  // and is dropped whole rather than shown without it.
  if (m.link == null) return { id, text, link: null, versions, ends };
  const link = safeLink(m.link);
  return link ? { id, text, link, versions, ends } : null;
}

function safeInstaller(raw, version, cfg) {
  if (!raw || typeof raw !== 'object' || !version) return null;
  const url = cfg.installerBase + 'companion-v' + version + '/Nus-Companion-Setup.exe';
  if (raw.url !== url) return null;
  if (typeof raw.sha512 !== 'string' || !SHA512_RE.test(raw.sha512)) return null;
  if (!Number.isSafeInteger(raw.size) || raw.size < 1024 * 1024 || raw.size > 2 * 1024 * 1024 * 1024) return null;
  return { url, sha512: raw.sha512, size: raw.size };
}

// Everything the file may say, field by field. Throws only when the file as a
// whole makes no sense; one bad message is dropped and the rest stand.
function parseManifest(body, cfg) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || body.schema !== 1) throw new Error('not a channel file');
  const issuedAt = Date.parse(String(body.issued_at || ''));
  if (!Number.isFinite(issuedAt)) throw new Error('no issued_at');
  const latest = safeVersion(body.latest);
  const raw = Array.isArray(body.messages) ? body.messages.slice(0, MAX_MESSAGES) : [];
  return {
    issuedAt,
    latest,
    minSupported: safeVersion(body.min_supported),
    releaseUrl: safeLink(body.release_url),
    installer: safeInstaller(body.installer, latest, cfg),
    messages: raw.map(safeMessage).filter(Boolean),
  };
}

// Checks the envelope and returns the body. `keys` is { name: base64 SPKI }.
function openEnvelope(text, keys) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_FILE_BYTES) throw new Error('channel file too large');
  let env;
  try { env = JSON.parse(text); } catch { throw new Error('channel file is not JSON'); }
  if (!env || typeof env.body !== 'string' || typeof env.sig !== 'string' || typeof env.key !== 'string') throw new Error('channel file is not signed');
  if (!Object.prototype.hasOwnProperty.call(keys, env.key)) throw new Error('unknown signing key');
  const publicKey = crypto.createPublicKey({ key: Buffer.from(keys[env.key], 'base64'), format: 'der', type: 'spki' });
  if (!crypto.verify(null, Buffer.from(env.body, 'utf8'), publicKey, Buffer.from(env.sig, 'base64'))) throw new Error('bad signature');
  try { return JSON.parse(env.body); } catch { throw new Error('signed body is not JSON'); }
}

// The other half, for the publishing tool and the tests.
function signEnvelope(bodyObject, keyName, privateKey) {
  const body = JSON.stringify(bodyObject);
  const sig = crypto.sign(null, Buffer.from(body, 'utf8'), privateKey).toString('base64');
  return JSON.stringify({ key: keyName, body, sig }, null, 1) + '\n';
}

function dayKey(t) {
  const d = new Date(t);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// store: { get(key), set(key, value) } over the preferences table.
function createChannel({ current, store, cfg, fetchImpl = global.fetch, now = () => Date.now(), log = () => {} }) {
  const read = () => (store.get && store.get('channel')) || {};
  const write = patch => store.set('channel', { ...read(), ...patch });

  // Stored as already-checked data, so a later launch never re-reads the network
  // to know what it was told, and the stored copy is parsed again on read.
  function manifest() {
    const m = read().manifest;
    if (!m) return null;
    try { return parseManifest(m, cfg); } catch { return null; }
  }

  // One GET, no cookie, no version, no id: the file is the same for everyone.
  async function check(force = false) {
    const s = read();
    if (!force && s.checkedAt && now() - s.checkedAt < DAY_MS) return { ok: !!s.lastOk, fetched: false };
    try {
      const res = await fetchImpl(cfg.url, { headers: { Accept: 'application/json', 'User-Agent': 'nus-companion' }, credentials: 'omit', cache: 'no-store', redirect: 'follow', signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(TIMEOUT_MS) : undefined });
      if (!res.ok) throw new Error('http ' + res.status);
      const text = await res.text();
      const body = openEnvelope(text, cfg.keys);
      const parsed = parseManifest(body, cfg);
      // An older signed file is someone replaying history: keep what we have.
      if (s.issuedAt && parsed.issuedAt < s.issuedAt) throw new Error('older than the file already held');
      write({ checkedAt: now(), lastOk: true, issuedAt: parsed.issuedAt, manifest: body });
      return { ok: true, fetched: true };
    } catch (e) {
      log('channel check failed: ' + e.message);
      write({ checkedAt: now(), lastOk: false });   // try again tomorrow, not every minute
      return { ok: false, fetched: true };
    }
  }

  // Null, or what this install should be offered.
  function update() {
    const m = manifest();
    if (!m || !m.latest || !newer(m.latest, current)) return null;
    return { version: m.latest, url: m.releaseUrl, installer: m.installer, belowMinimum: !!(m.minSupported && newer(m.minSupported, current)) };
  }

  // What the Knot may say now. `enabled` is the Messages from Nūs switch. At
  // most one a day across updates and messages. An update is offered once per
  // version; below min_supported it may come back once a week. A message once
  // per id, in file order, while the version fits and the end date has not gone.
  function next(enabled = true) {
    if (!enabled) return null;
    const s = read();
    const t = now();
    if (s.lastSaidDay === dayKey(t)) return null;
    const u = update();
    if (u) {
      const offer = s.offer || {};
      if (offer.version !== u.version || (u.belowMinimum && t - (offer.at || 0) >= WEEK_MS)) return { kind: 'update', version: u.version, oneClick: !!u.installer, belowMinimum: u.belowMinimum };
    }
    const m = manifest();
    const shown = new Set(Array.isArray(s.shown) ? s.shown : []);
    for (const msg of m ? m.messages : []) {
      if (shown.has(msg.id) || !inRange(current, msg.versions)) continue;
      if (t > Date.parse(msg.ends + 'T23:59:59Z')) continue;
      return { kind: 'notice', id: msg.id, text: msg.text, link: msg.link };
    }
    return null;
  }

  // The bubble went up: spend today's turn, and this id or this version.
  function said(item) {
    const s = read();
    const patch = { lastSaidDay: dayKey(now()) };
    if (item.kind === 'update') patch.offer = { version: item.version, at: now() };
    if (item.kind === 'notice') patch.shown = [...(Array.isArray(s.shown) ? s.shown : []), item.id].slice(-MAX_SHOWN_IDS);
    write(patch);
  }

  return { check, update, next, said, manifest };
}

module.exports = { createChannel, channelConfig, parseManifest, openEnvelope, signEnvelope, safeLink, safeText, inRange, CHANNEL_URL, PUBLIC_KEYS, INSTALLER_BASE, ID_RE, MAX_FILE_BYTES };
