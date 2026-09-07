// Acquisition attribution: a short signed token from the website links this
// install to the post/video it came from. The token carries campaign labels
// only — no identity, no coursework, nothing about the student. Verification
// mirrors growth-os/growth_os/attribution.py exactly (shared test vectors).
//
// Assignment is write-once: the first valid token wins and reopening the app,
// or pasting a second code, never reassigns. A forged token can only mislabel
// a marketing counter; it grants nothing.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const VERSION = 'N1';
const ACTION_ID_RE = /^act-\d{8}-[a-f0-9]{7}$/;
const UTM_RE = /^[a-z0-9_-]{1,60}$/;
const STORE_FILE = 'acquisition.json';
const FIRST_IMPORT_FLAG = 'first-import-tracked.json';

function sign(secret, prefixedPayload) {
  return crypto.createHmac('sha256', secret).update(prefixedPayload, 'utf8').digest('hex').slice(0, 10);
}

function b64urlDecode(text) {
  const padded = text + '='.repeat((4 - (text.length % 4)) % 4);
  return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function verifyToken(secret, token, now = new Date()) {
  if (typeof token !== 'string' || token.length > 300 || !secret) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== VERSION) return null;
  const expected = sign(secret, `${parts[0]}.${parts[1]}`);
  const given = String(parts[2]);
  if (given.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(given, 'utf8'))) return null;
  let payload;
  try { payload = JSON.parse(b64urlDecode(parts[1]).toString('utf8')); } catch { return null; }
  if (!payload || typeof payload !== 'object') return null;
  if (!ACTION_ID_RE.test(String(payload.a || ''))) return null;
  for (const key of ['s', 'm', 'c']) {
    if (!UTM_RE.test(String(payload[key] || ''))) return null;
  }
  const x = String(payload.x || '');
  if (!/^\d{8}$/.test(x)) return null;
  const expiry = Date.UTC(Number(x.slice(0, 4)), Number(x.slice(4, 6)) - 1, Number(x.slice(6, 8)));
  if (Number.isNaN(expiry) || now.getTime() > expiry + 86400000) return null;
  return payload;
}

// The secret ships out-of-band: NUS_ACQ_SECRET for local testing, or a
// <userData>/acq_secret.txt file. Never committed, and its absence simply
// means tokens are ignored — the app works identically without it.
function getSecret(userDataDir) {
  if (process.env.NUS_ACQ_SECRET) return process.env.NUS_ACQ_SECRET.trim();
  try {
    return fs.readFileSync(path.join(userDataDir, 'acq_secret.txt'), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

function redeem(userDataDir, secret, token, now = new Date()) {
  const storePath = path.join(userDataDir, STORE_FILE);
  if (fs.existsSync(storePath)) return { ok: false, reason: 'already_assigned' };
  if (!secret) return { ok: false, reason: 'no_secret' };
  const payload = verifyToken(secret, String(token || '').trim(), now);
  if (!payload) return { ok: false, reason: 'invalid_token' };
  const dims = {
    acq_action_id: payload.a,
    utm_source: payload.s,
    utm_medium: payload.m,
    utm_campaign: payload.c,
  };
  try {
    fs.writeFileSync(storePath, JSON.stringify({ ...dims, redeemed_at: now.toISOString() }));
  } catch {
    return { ok: false, reason: 'write_failed' };
  }
  return { ok: true, dims };
}

function getDims(userDataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(userDataDir, STORE_FILE), 'utf8'));
    const dims = {};
    for (const key of ['acq_action_id', 'utm_source', 'utm_medium', 'utm_campaign']) {
      if (typeof raw[key] === 'string' && raw[key].length <= 80) dims[key] = raw[key];
    }
    return dims;
  } catch {
    return {};
  }
}

// first_import is the activation event: fired once per profile, ever, when the
// student confirms their first syllabus import.
function markFirstImportOnce(userDataDir) {
  const flagPath = path.join(userDataDir, FIRST_IMPORT_FLAG);
  if (fs.existsSync(flagPath)) return false;
  try {
    fs.writeFileSync(flagPath, JSON.stringify({ tracked_at: new Date().toISOString() }));
  } catch {
    return false; // if we cannot persist the flag, do not risk double counting
  }
  return true;
}

module.exports = { verifyToken, getSecret, redeem, getDims, markFirstImportOnce };
