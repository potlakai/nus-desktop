#!/usr/bin/env node
// Writes the Supabase project URL and anon key into src/config.js.
//
//   node scripts/configure-supabase.js <project-url> <anon-key>
//
// Why a script instead of hand-editing: the values have to be baked in as the
// literal fallback, not left as env vars. process.env works when you run
// `npm start`, but a packaged app launched from the Start menu has no such
// environment, so an env-only config silently ships as "not configured".
//
// src/config.js is gitignored, so nothing written here is committed. The anon
// key is designed to be public and ship inside clients; RLS is what protects
// the data, not the secrecy of this key.
//
// The one thing this refuses to do is write a service-role key. That key
// bypasses RLS entirely, and baking it into an installer would hand every
// downloader full read/write access to every user's row.

const fs = require('fs');
const path = require('path');

const CONFIG = path.join(__dirname, '..', 'src', 'config.js');

function die(message) {
  console.error('\n  ERROR  ' + message + '\n');
  process.exit(1);
}

function usage() {
  console.error(`
  Usage:
    node scripts/configure-supabase.js <project-url> <anon-key>

  Both are on Supabase -> Settings -> API:
    project-url   https://<ref>.supabase.co
    anon-key      the key labelled "anon" / "public"  (NOT service_role)
`);
  process.exit(1);
}

const [rawUrl, rawKey] = process.argv.slice(2);
if (!rawUrl || !rawKey) usage();

const url = rawUrl.trim().replace(/\/+$/, '');
const key = rawKey.trim();

/* ---------------------------------------------------------------- url ---- */

if (!/^https:\/\/[a-z0-9-]+\.supabase\.(co|in)$/i.test(url)) {
  die(`That does not look like a Supabase project URL: ${url}\n         Expected something like https://abcdefghijkl.supabase.co`);
}
const urlRef = url.match(/^https:\/\/([a-z0-9-]+)\./i)[1];

/* ---------------------------------------------------------------- key ---- */

function decodeJwtPayload(token) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const json = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

// New-style Supabase keys are prefixed rather than JWTs.
if (/^sb_secret_/.test(key)) {
  die('That is a SECRET key. It bypasses row-level security and must never ship\n         inside the app. Copy the "publishable" / "anon" key instead.');
}

let keyRef = null;
if (!/^sb_publishable_/.test(key)) {
  const payload = decodeJwtPayload(key);
  if (!payload) {
    die('That does not look like a Supabase key. Expected a JWT (three\n         dot-separated parts) or an sb_publishable_... key.');
  }
  if (payload.role === 'service_role') {
    die('That is the SERVICE ROLE key. It bypasses row-level security, and\n         baking it into the installer would give every downloader full\n         read/write access to every user\'s data.\n\n         Copy the key labelled "anon" / "public" instead.\n         The service_role key belongs only in the edge function secrets.');
  }
  if (payload.role !== 'anon') {
    die(`Unexpected key role "${payload.role}". Expected "anon".`);
  }
  keyRef = payload.ref || null;
  if (keyRef && keyRef !== urlRef) {
    die(`This key belongs to project "${keyRef}" but the URL is for "${urlRef}".\n         They must be from the same project.`);
  }
}

/* ------------------------------------------------------------- write ---- */

if (!fs.existsSync(CONFIG)) die(`src/config.js not found at ${CONFIG}`);
let source = fs.readFileSync(CONFIG, 'utf8');

const BLOCK = /supabase:\s*\{[\s\S]*?\},/;
if (!BLOCK.test(source)) die('Could not find the supabase block in src/config.js.');

const replacement =
`supabase: {
    // Set by scripts/configure-supabase.js. The env vars still win, so a dev
    // can point at a different project without editing this file. The literal
    // fallback is what the packaged app actually uses.
    url: process.env.NUS_SUPABASE_URL || ${JSON.stringify(url)},
    anonKey: process.env.NUS_SUPABASE_ANON_KEY || ${JSON.stringify(key)},
  },`;

fs.writeFileSync(CONFIG, source.replace(BLOCK, replacement));

/* ------------------------------------------------------------ verify ---- */

delete require.cache[require.resolve(CONFIG)];
const config = require(CONFIG);
const ok = config.isSupabaseConfigured
  ? config.isSupabaseConfigured(config)
  : Boolean(config.supabase && config.supabase.url && config.supabase.anonKey);

const masked = key.length > 12 ? key.slice(0, 6) + '...' + key.slice(-4) : '(short)';

console.log(`
  Supabase configured.

    project   ${urlRef}
    url       ${config.supabase.url}
    anon key  ${masked}   (role: anon, safe to ship)

    isSupabaseConfigured()  ->  ${ok}

  src/config.js is gitignored, so this is not committed.

  Reminder: your Google OAuth client secret does NOT go in any file here.
  It goes only in Supabase -> Authentication -> Providers -> Google.
`);

if (!ok) process.exit(1);
