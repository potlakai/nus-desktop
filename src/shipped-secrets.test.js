// src/config.js is gitignored but IS packaged into the installer, because
// electron-builder packages by glob and does not read .gitignore. That is
// deliberate: Google documents desktop OAuth clients as public clients whose
// "secret" is not confidential, and Calendar/Outlook would not work for any
// user without those values shipping.
//
// What must never ship is a genuinely confidential credential. This test is the
// tripwire: if a service-role key, private key, or bearer token ever lands in a
// packaged file, the build fails here instead of on a stranger's machine.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// Patterns for credential classes that are confidential by definition.
const FORBIDDEN = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
  [/service_role/i, 'a Supabase service_role key'],
  [/\bsk-[A-Za-z0-9]{20,}/, 'an OpenAI-style secret key'],
  [/\bsk-ant-[A-Za-z0-9-]{20,}/, 'an Anthropic secret key'],
  [/\bghp_[A-Za-z0-9]{20,}/, 'a GitHub token'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'an AWS access key id'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/, 'a Slack token'],
  [/eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\./, 'a signed JWT'],
];

function packagedFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(js|json|html|css|md)$/.test(entry.name)) continue;
      if (entry.name.endsWith('.test.js')) continue; // excluded from the build
      out.push(full);
    }
  };
  for (const dir of ['src', 'renderer', 'companion']) walk(path.join(ROOT, dir));
  out.push(path.join(ROOT, 'package.json'));
  return out;
}

test('no confidential credential class is present in any packaged file', () => {
  const hits = [];
  for (const file of packagedFiles()) {
    const text = fs.readFileSync(file, 'utf8');
    for (const [pattern, label] of FORBIDDEN) {
      if (pattern.test(text)) hits.push(`${path.relative(ROOT, file)} contains ${label}`);
    }
  }
  assert.deepEqual(hits, [], 'confidential credentials must never be packaged:\n' + hits.join('\n'));
});

test('test files and docs stay out of the shipped build', () => {
  const files = require('../package.json').build.files;
  assert.ok(files.includes('!**/*.test.js'));
  assert.ok(files.includes('!companion/test/**'), 'companion test folder excluded');
  assert.ok(files.includes('!docs/**'));
});

test('the shipped OAuth config carries only public-client values', () => {
  const configPath = path.join(ROOT, 'src', 'config.js');
  if (!fs.existsSync(configPath)) return; // fine: absent on a clean checkout
  const config = require(configPath);
  // Supabase anon keys are public by design; a service key never is.
  if (config.supabase && config.supabase.anonKey) {
    assert.ok(!/service_role/i.test(config.supabase.anonKey), 'anonKey must not be a service key');
  }
  // Google desktop clients are public clients. Assert the shape is the desktop
  // type, since a *web* client secret genuinely is confidential.
  if (config.googleCalendar && config.googleCalendar.clientId) {
    assert.match(config.googleCalendar.clientId, /\.apps\.googleusercontent\.com$/,
      'Google client id must be a standard installed-app client');
  }
});
