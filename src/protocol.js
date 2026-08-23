const path = require('path');

const PROTOCOL = 'nus-desktop';

function findProtocolUrl(argv = []) {
  return argv.find((arg) => typeof arg === 'string' && arg.toLowerCase().startsWith(`${PROTOCOL}://`)) || null;
}

// An isolated profile (NUS_DATA_DIR, or --data-dir) must survive the hop
// through the browser: Windows launches the registered exe with only the URL,
// so the profile is baked into the registration as an argument. Without this a
// test copy's callback lands in the real profile, which has no PKCE verifier.
function dataDirFromArgv(argv = process.argv) {
  for (let i = 0; i < argv.length; i++) {
    const arg = String(argv[i] || '');
    if (arg.startsWith('--data-dir=')) return arg.slice('--data-dir='.length);
    if (arg === '--data-dir' && argv[i + 1]) return argv[i + 1];
  }
  return process.env.NUS_DATA_DIR || null;
}

function registerProtocolClient(app, argv = process.argv) {
  const extra = [];
  const dataDir = dataDirFromArgv(argv);
  if (dataDir) extra.push(`--data-dir=${path.resolve(dataDir)}`);
  if (process.defaultApp && argv[1]) {
    return app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(argv[1]), ...extra]);
  }
  if (extra.length) return app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, extra);
  return app.setAsDefaultProtocolClient(PROTOCOL);
}

// Supabase's own wording is written for web developers. Students get this.
function friendlySignInError(message) {
  const text = String(message || '');
  if (/PKCE code verifier/i.test(text)) return 'This sign-in was started by a different copy of Nūs. Close any other Nūs window, then try Sign in with Google again.';
  if (/expired|invalid.*code|code.*invalid/i.test(text)) return 'That sign-in link has expired. Try Sign in with Google again.';
  if (/network|fetch|ENOTFOUND|ECONN/i.test(text)) return 'Nūs could not reach the sign-in service. Check your connection and try again.';
  return text || 'The sign-in did not complete.';
}

// nus-desktop:// links carry exactly two things: a sign-in callback from
// Supabase, or "billing finished" from the website after Stripe Checkout. The
// path decides; anything else is ignored so a stray link never reaches the
// OAuth exchange.
function routeProtocolUrl(url) {
  let parsed;
  try { parsed = new URL(String(url)); } catch { return 'ignore'; }
  if (parsed.protocol !== `${PROTOCOL}:`) return 'ignore';
  if (parsed.hostname === 'auth' && parsed.pathname === '/callback') return 'auth';
  if (parsed.hostname === 'billing' && parsed.pathname === '/success') return 'billing';
  return 'ignore';
}

module.exports = { PROTOCOL, findProtocolUrl, registerProtocolClient, routeProtocolUrl, dataDirFromArgv, friendlySignInError };
