const path = require('path');

const PROTOCOL = 'nus-desktop';

function findProtocolUrl(argv = []) {
  return argv.find((arg) => typeof arg === 'string' && arg.toLowerCase().startsWith(`${PROTOCOL}://`)) || null;
}

function registerProtocolClient(app, argv = process.argv) {
  if (process.defaultApp && argv[1]) {
    return app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(argv[1])]);
  }
  return app.setAsDefaultProtocolClient(PROTOCOL);
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

module.exports = { PROTOCOL, findProtocolUrl, registerProtocolClient, routeProtocolUrl };
