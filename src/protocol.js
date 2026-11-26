const path = require('path');

// Personal build: the scheme is jarvis://. Sign-in, billing and referral links
// are gone, so the only routes that still resolve are kept for older links and
// answer with "not available" in main.js.
const PROTOCOL = 'jarvis';

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
  if (/PKCE code verifier/i.test(text)) return 'This sign-in was started by a different copy of J.A.R.V.I.S. Close the other window and try again.';
  if (/expired|invalid.*code|code.*invalid/i.test(text)) return 'That sign-in link has expired. Try Sign in with Google again.';
  if (/network|fetch|ENOTFOUND|ECONN/i.test(text)) return 'J.A.R.V.I.S could not reach the sign-in service. Check your connection and try again.';
  return text || 'The sign-in did not complete.';
}

// jarvis:// links. In this build sign-in, billing and referral links no longer
// do anything (main.js answers them without acting), but they still parse so an
// old bookmark cannot crash the handler. Anything unrecognised is ignored.
function routeProtocolUrl(url) {
  let parsed;
  try { parsed = new URL(String(url)); } catch { return 'ignore'; }
  if (parsed.protocol !== `${PROTOCOL}:`) return 'ignore';
  if (parsed.hostname === 'auth' && parsed.pathname === '/callback') return 'auth';
  if (parsed.hostname === 'billing' && parsed.pathname === '/success') return 'billing';
  if (parsed.hostname === 'acquire' && (parsed.pathname === '' || parsed.pathname === '/')) return 'acquire';
  return 'ignore';
}

module.exports = { PROTOCOL, findProtocolUrl, registerProtocolClient, routeProtocolUrl, dataDirFromArgv, friendlySignInError };
