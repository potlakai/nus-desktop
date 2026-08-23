#!/usr/bin/env node
// End-to-end billing test that does not depend on the desktop Google sign-in.
//
//   node scripts/test-checkout.js <test-email> <test-password>
//
// Create the test user first in Supabase -> Authentication -> Users -> Add user
// (tick "Auto Confirm User"). Use a throwaway password; it is passed straight to
// Supabase and never stored or printed by this script.
//
// What this proves, in order:
//   1. Auth works and the user exists.
//   2. handle_new_user() fired, so profiles + subscriptions rows were seeded.
//   3. entitlement() is callable by an authenticated user and reports free.
//   4. create-checkout accepts a real JWT and returns a Stripe Checkout URL.
//
// It deliberately stops before payment. Open the printed URL, pay with the test
// card 4242 4242 4242 4242, then re-run this script: step 3 should flip to pro,
// which is the webhook proving itself.

const config = require('../src/config');

const URL = config.supabase && config.supabase.url;
const ANON = config.supabase && config.supabase.anonKey;

const [email, password] = process.argv.slice(2);
if (!email || !password) {
  console.error(`
  Usage:
    node scripts/test-checkout.js <test-email> <test-password>

  Create the user first: Supabase -> Authentication -> Users -> Add user,
  with "Auto Confirm User" ticked.
`);
  process.exitCode = 1;
  return;
}

// Pasting the usage line verbatim is the obvious mistake, and Supabase just
// answers "Invalid login credentials", which sends you hunting the wrong thing.
if (/^(YOUR_TEST_PASSWORD|<password>|YOUR_PASSWORD|password)$/i.test(password)) {
  console.error(`
  That is the placeholder, not your password.

  Replace YOUR_TEST_PASSWORD with the password you actually typed when you
  created the user in Supabase -> Authentication -> Users -> Add user.

  Forgot it? Open that user in the dashboard and set a new one, or delete the
  user and add it again.
`);
  process.exitCode = 1;
  return;
}

const H = { apikey: ANON, 'content-type': 'application/json' };

function ok(label, detail) { console.log(`  PASS  ${label.padEnd(38)} ${detail}`); }
function bad(label, detail) { console.log(`  FAIL  ${label.padEnd(38)} ${detail}`); }

(async () => {
  console.log(`\n  Project: ${URL}\n`);

  /* 1. sign in ---------------------------------------------------------- */
  const signIn = await fetch(`${URL}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: H, body: JSON.stringify({ email, password }),
  });
  const session = await signIn.json();
  if (!signIn.ok || !session.access_token) {
    bad('sign in', `HTTP ${signIn.status} ${session.error_description || session.msg || session.error || ''}`);
    console.log(`
  If this says "Invalid login credentials", the user does not exist yet or the
  password is different. Create it under Authentication -> Users -> Add user
  and tick "Auto Confirm User" so no email confirmation is required.
`);
    process.exitCode = 1;
    return;
  }
  const jwt = session.access_token;
  const userId = session.user && session.user.id;
  ok('sign in', `user ${userId}`);

  const auth = { ...H, Authorization: `Bearer ${jwt}` };

  /* 2. did the signup trigger seed the rows? ----------------------------- */
  const prof = await (await fetch(`${URL}/rest/v1/profiles?select=user_id,email`, { headers: auth })).json();
  if (Array.isArray(prof) && prof.length === 1) ok('handle_new_user seeded profile', prof[0].email || '(no email)');
  else bad('handle_new_user seeded profile', 'no profile row - re-run the backfill at the end of schema.sql');

  const subs = await (await fetch(`${URL}/rest/v1/subscriptions?select=plan,status,current_period_end`, { headers: auth })).json();
  if (Array.isArray(subs) && subs.length === 1) ok('subscriptions row exists', `plan=${subs[0].plan} status=${subs[0].status}`);
  else bad('subscriptions row exists', JSON.stringify(subs));

  /* 3. entitlement ------------------------------------------------------- */
  const entRes = await fetch(`${URL}/rest/v1/rpc/entitlement`, { method: 'POST', headers: auth, body: '{}' });
  const ent = await entRes.json();
  if (entRes.ok && Array.isArray(ent) && ent.length) {
    const e = ent[0];
    ok('entitlement()', `plan=${e.plan} is_pro=${e.is_pro} period_end=${e.current_period_end || 'none'}`);
    if (e.is_pro) {
      console.log('\n  is_pro is TRUE. If you just paid, the webhook worked end to end.\n');
      return;
    }
  } else {
    bad('entitlement()', `HTTP ${entRes.status} ${JSON.stringify(ent)}`);
  }

  /* 4. create-checkout --------------------------------------------------- */
  const coRes = await fetch(`${URL}/functions/v1/create-checkout`, {
    method: 'POST', headers: auth, body: '{}',
  });
  const co = await coRes.json().catch(() => ({}));

  if (coRes.ok && co.url) {
    ok('create-checkout', 'returned a Checkout URL');
    console.log(`\n  Open this and pay with test card 4242 4242 4242 4242 (any future expiry, any CVC):\n\n  ${co.url}\n`);
    console.log('  Then re-run this script. entitlement() should come back is_pro=true.\n');
  } else {
    bad('create-checkout', `HTTP ${coRes.status} ${JSON.stringify(co)}`);
    const hint = {
      billing_not_configured: 'STRIPE_PRICE_ID is not set. Run:\n           supabase secrets set STRIPE_PRICE_ID=price_xxx',
      method_not_allowed: 'The function rejected the method; redeploy it.',
    }[co.error];
    if (hint) console.log(`\n  Fix: ${hint}\n`);
    else if (coRes.status === 401) console.log('\n  Fix: create-checkout must be deployed WITH jwt verification:\n           supabase functions deploy create-checkout\n');
    else if (coRes.status === 404) console.log('\n  Fix: the function is not deployed yet:\n           supabase functions deploy create-checkout\n');
    else if (/CHECKOUT_SUCCESS_URL|CHECKOUT_CANCEL_URL/.test(JSON.stringify(co))) {
      console.log(`\n  Fix: set the redirect URLs, any https page works for a test:
           supabase secrets set STRIPE_CHECKOUT_SUCCESS_URL=https://potlakai.github.io/nus/
           supabase secrets set STRIPE_CHECKOUT_CANCEL_URL=https://potlakai.github.io/nus/\n`);
    }
    process.exitCode = 1;
    return;
  }
})();
