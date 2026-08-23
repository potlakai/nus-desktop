// The webhook and the database schema have to agree, and nothing at runtime
// will tell you when they stop.
//
// Two ways this drifts into a money bug:
//   1. Stripe sends a subscription status the CHECK constraint rejects. Every
//      upsert for that user fails, the webhook 500s, Stripe retries forever,
//      and the person who paid never gets Pro.
//   2. entitlement() and the webhook disagree about which statuses count as
//      entitled. Then the row says 'pro' and the app says free, or worse.
//
// These are static files, so grep is enough and it costs nothing to run.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const schema = read('supabase/schema.sql');
const webhook = read('supabase/functions/stripe-webhook/index.ts');
const checkout = read('supabase/functions/create-checkout/index.ts');
const functionConfig = read('supabase/config.toml');

// Every status a Stripe Subscription object can carry.
const STRIPE_SUBSCRIPTION_STATUSES = [
  'incomplete', 'incomplete_expired', 'trialing', 'active',
  'past_due', 'canceled', 'unpaid', 'paused',
];

test('the schema accepts every status Stripe can send', () => {
  const match = schema.match(/check \(status in \(([^)]+)\)\)/s);
  assert.ok(match, 'subscriptions.status has a CHECK constraint');
  const allowed = new Set(
    match[1].split(',').map((s) => s.trim().replace(/'/g, '').replace(/\s+/g, '')).filter(Boolean),
  );
  for (const status of STRIPE_SUBSCRIPTION_STATUSES) {
    assert.ok(allowed.has(status), `CHECK constraint accepts Stripe status "${status}"`);
  }
  assert.ok(allowed.has('none'), "'none' is kept for users who never checked out");
});

test('entitlement() and the webhook agree on what counts as entitled', () => {
  const sqlSet = schema.match(/s\.status in \(([^)]+)\)/);
  assert.ok(sqlSet, 'entitlement() gates on a status list');
  const fromSql = sqlSet[1].replace(/'/g, '').split(',').map((s) => s.trim()).sort();

  const tsSet = webhook.match(/ACTIVE_STATUSES = new Set\(\[([^\]]+)\]\)/);
  assert.ok(tsSet, 'the webhook declares ACTIVE_STATUSES');
  const fromTs = tsSet[1].replace(/'/g, '').split(',').map((s) => s.trim()).filter(Boolean).sort();

  assert.deepEqual(fromTs, fromSql,
    'the webhook and entitlement() must gate on the same statuses');
});

test('entitlement fails closed when Stripe provides no period end', () => {
  assert.match(schema, /s\.current_period_end is not null\s+and s\.current_period_end > now\(\)/,
    'an active status without a verified future period end must not grant Pro');
  assert.doesNotMatch(schema, /current_period_end is null or/,
    'a missing billing period must never become permanent Pro');
});

test('only the webhook can grant Pro', () => {
  // A client-writable subscriptions table is a client that grants itself Pro.
  const policies = [...schema.matchAll(/create policy "([^"]+)"\s+on public\.subscriptions for (\w+)/g)];
  assert.ok(policies.length > 0, 'subscriptions has at least one policy');
  for (const [, name, action] of policies) {
    assert.equal(action, 'select', `policy "${name}" is read-only`);
  }
  assert.match(schema, /alter table public\.subscriptions enable row level security/);
});

test('the webhook verifies the Stripe signature before trusting the body', () => {
  // With --no-verify-jwt this check is the entire security boundary.
  assert.match(webhook, /constructEventAsync/,
    'uses the async verifier, since Deno crypto is promise-based');
  assert.match(webhook, /STRIPE_WEBHOOK_SECRET/);
  // The body must not be parsed before it is verified.
  const verifyAt = webhook.indexOf('constructEventAsync');
  const parseAt = webhook.indexOf('JSON.parse(raw');
  assert.ok(parseAt === -1 || parseAt > verifyAt, 'raw body is never parsed before verification');
  assert.match(webhook, /req\.text\(\)/, 'reads the exact bytes the signature covers');
});

test('checkout derives its Stripe mapping from the signed-in Supabase user', () => {
  assert.match(functionConfig, /\[functions\.create-checkout\]\s+verify_jwt = true/,
    'the checkout function requires a valid Supabase JWT at the gateway');
  assert.match(checkout, /supabase\.auth\.getUser\(\)/,
    'checkout resolves the caller from Supabase Auth');
  assert.match(checkout, /client_reference_id: user\.id/);
  assert.match(checkout, /subscription_data: \{ metadata: \{ nus_user_id: user\.id \} \}/);
  assert.doesNotMatch(checkout, /client_reference_id[^\n]*req|nus_user_id[^\n]*req/,
    'checkout never accepts a user mapping from request input');
  assert.match(webhook, /checkout user mapping mismatch/,
    'the webhook rejects conflicting signed-in mappings');
  assert.match(webhook, /if \(!metadataUserId\).*authenticated user metadata/s,
    'the webhook does not fall back to a URL-controlled client reference');
  assert.match(checkout, /idempotencyKey: `nus-checkout:\$\{user\.id\}`/,
    'repeat Upgrade clicks reuse one Checkout Session');
});

test('only the configured Nūs Pro price can grant entitlement', () => {
  assert.match(webhook, /hasConfiguredProPrice\(sub\)/);
  assert.match(webhook, /item\.price\.id === priceId/);
  assert.match(webhook, /ignoring subscription with an unrecognized price/);
});

test('an older subscription cannot overwrite the canonical newer subscription', () => {
  assert.match(schema, /stripe_subscription_created_at\s+timestamptz/);
  assert.match(webhook, /existing\.stripe_subscription_id !== row\.stripe_subscription_id/);
  assert.match(webhook, /Date\.parse\(existing\.stripe_subscription_created_at\) >= Date\.parse\(row\.stripe_subscription_created_at\)/);
});

test('only the Stripe webhook bypasses Supabase JWT verification', () => {
  assert.match(functionConfig, /\[functions\.stripe-webhook\]\s+verify_jwt = false/);
  assert.match(functionConfig, /\[functions\.create-checkout\]\s+verify_jwt = true/);
});

test('the service role key never leaves the edge function', () => {
  // If this ever appears in shipped app code, the paywall is decorative.
  for (const file of ['src/config.js', 'src/auth.js', 'src/main.js', 'src/preload.js']) {
    let source;
    try { source = read(file); } catch { continue; }
    assert.ok(!/SERVICE_ROLE|service_role/.test(source),
      `${file} carries no service-role key`);
  }
});
