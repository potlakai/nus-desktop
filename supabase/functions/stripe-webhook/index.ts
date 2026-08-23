// =============================================================================
// Stripe webhook -> public.subscriptions
// =============================================================================
//
// This is the ONLY thing that may grant Pro. The `subscriptions` table has a
// SELECT policy and no write policy at all, so clients cannot touch it; this
// function writes with the service-role key, which bypasses RLS.
//
// Because of that, the signature check below is the entire security boundary.
// Without it anyone who learns this URL can POST themselves a subscription.
//
// DEPLOY (note the flag):
//
//   supabase functions deploy stripe-webhook --no-verify-jwt
//
// Stripe does not send a Supabase JWT, so the platform's default JWT gate would
// reject every delivery with a 401 and the endpoint would look dead. Turning it
// off does not make this open: the request is still authenticated, just by
// Stripe's signature instead of a JWT.
//
// SECRETS (set with `supabase secrets set`):
//   STRIPE_SECRET_KEY        sk_test_... then sk_live_...
//   STRIPE_WEBHOOK_SECRET    whsec_... from the endpoint you created
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically.
//
// EVENTS this expects to be subscribed to:
//   checkout.session.completed
//   customer.subscription.created
//   customer.subscription.updated
//   customer.subscription.deleted
//   invoice.payment_failed
// =============================================================================

import Stripe from 'https://esm.sh/stripe@17.7.0?target=deno';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  // Deno has no long-lived sockets here; the fetch client is the supported one.
  httpClient: Stripe.createFetchHttpClient(),
  apiVersion: '2025-03-31.basil',
});

const WEBHOOK_SECRET = Deno.env.get('STRIPE_WEBHOOK_SECRET')!;

const admin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

// Statuses that mean "this person is currently entitled". Kept identical to the
// set in supabase/schema.sql's entitlement(); if one changes, change both.
const ACTIVE_STATUSES = new Set(['active', 'trialing']);

type SubRow = {
  user_id: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  stripe_subscription_created_at: string;
  status: string;
  plan: 'free' | 'pro';
  current_period_end: string | null;
  cancel_at_period_end: boolean;
};

function log(...parts: unknown[]) {
  console.log('[stripe-webhook]', ...parts);
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

/**
 * Stripe has moved `current_period_end` between the subscription and its items
 * across API versions. Read whichever one this account's version populates
 * rather than pinning the entitlement to a field that may be absent.
 */
function periodEndISO(sub: Stripe.Subscription): string | null {
  const top = (sub as unknown as { current_period_end?: number }).current_period_end;
  const item = sub.items?.data?.[0] as unknown as { current_period_end?: number } | undefined;
  const epoch = top ?? item?.current_period_end;
  return typeof epoch === 'number' ? new Date(epoch * 1000).toISOString() : null;
}

function subscriptionCreatedISO(sub: Stripe.Subscription): string {
  return new Date(sub.created * 1000).toISOString();
}

function hasConfiguredProPrice(sub: Stripe.Subscription): boolean {
  const priceId = Deno.env.get('STRIPE_PRICE_ID');
  if (!priceId?.startsWith('price_')) throw new Error('STRIPE_PRICE_ID is not configured');
  return sub.items.data.some((item: Stripe.SubscriptionItem) => item.price.id === priceId);
}

/** Resolve which Nus user a Stripe subscription belongs to. */
async function resolveUserId(sub: Stripe.Subscription): Promise<string | null> {
  // Set by the authenticated create-checkout function.
  const fromMetadata = sub.metadata?.nus_user_id;
  if (isUuid(fromMetadata)) return fromMetadata;
  if (fromMetadata) log('ignoring malformed nus_user_id metadata');

  // Otherwise the customer was already mapped by a previous checkout event.
  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
  if (!customerId) return null;

  const { data, error } = await admin
    .from('subscriptions')
    .select('user_id')
    .eq('stripe_customer_id', customerId)
    .maybeSingle();

  if (error) { log('lookup by customer failed', error.message); return null; }
  return data?.user_id ?? null;
}

async function writeSubscription(row: SubRow) {
  const { data: profile, error: profileError } = await admin
    .from('profiles')
    .select('user_id')
    .eq('user_id', row.user_id)
    .maybeSingle();
  if (profileError) throw new Error('user lookup failed: ' + profileError.message);
  if (!profile) { log('ignoring subscription for deleted or unknown user', row.user_id); return; }

  const { data: existing, error: existingError } = await admin
    .from('subscriptions')
    .select('stripe_subscription_id,stripe_subscription_created_at')
    .eq('user_id', row.user_id)
    .maybeSingle();
  if (existingError) throw new Error('subscription lookup failed: ' + existingError.message);
  if (existing?.stripe_subscription_id
      && existing.stripe_subscription_id !== row.stripe_subscription_id
      && existing.stripe_subscription_created_at
      && Date.parse(existing.stripe_subscription_created_at) >= Date.parse(row.stripe_subscription_created_at)) {
    log('ignoring event for older non-canonical subscription', row.stripe_subscription_id);
    return;
  }

  const { error } = await admin
    .from('subscriptions')
    .upsert(row, { onConflict: 'user_id' });
  if (error) throw new Error('subscriptions upsert failed: ' + error.message);
  log('wrote', row.user_id, row.plan, row.status);
}

/**
 * Always re-reads the live subscription from Stripe rather than trusting the
 * event payload. Webhook deliveries arrive out of order and can be retried
 * hours later; reading current state makes every handler idempotent and makes
 * a stale event harmless.
 */
async function syncFromSubscriptionId(subscriptionId: string, userIdHint?: string) {
  const sub = await stripe.subscriptions.retrieve(subscriptionId);
  if (!hasConfiguredProPrice(sub)) {
    log('ignoring subscription with an unrecognized price', subscriptionId);
    return;
  }
  const userId = userIdHint ?? (await resolveUserId(sub));
  if (!userId) {
    // Not an error worth retrying: without a mapping there is nothing to write,
    // and the checkout event that carries it will arrive on its own.
    log('no user mapping for subscription', subscriptionId, '- skipping');
    return;
  }

  const entitled = ACTIVE_STATUSES.has(sub.status);
  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id ?? null;

  await writeSubscription({
    user_id: userId,
    stripe_customer_id: customerId,
    stripe_subscription_id: sub.id,
    stripe_subscription_created_at: subscriptionCreatedISO(sub),
    status: sub.status,
    // `plan` records what they bought; `status` and the period end decide
    // whether it is currently in force. entitlement() gates on all three.
    plan: entitled || sub.status === 'past_due' ? 'pro' : 'free',
    current_period_end: periodEndISO(sub),
    cancel_at_period_end: Boolean(sub.cancel_at_period_end),
  });
}

async function handleCheckoutCompleted(session: Stripe.Checkout.Session) {
  const subscriptionId = typeof session.subscription === 'string'
    ? session.subscription
    : session.subscription?.id;

  if (!subscriptionId) { log('checkout completed with no subscription (one-off payment?)'); return; }

  const sub = await stripe.subscriptions.retrieve(subscriptionId);
  const metadataUserId = isUuid(sub.metadata?.nus_user_id) ? sub.metadata.nus_user_id : null;
  const referenceUserId = isUuid(session.client_reference_id) ? session.client_reference_id : null;
  if (metadataUserId && referenceUserId && metadataUserId !== referenceUserId) {
    log('checkout user mapping mismatch - skipping');
    return;
  }
  if (!metadataUserId) { log('checkout completed with no authenticated user metadata - skipping'); return; }

  await syncFromSubscriptionId(subscriptionId, metadataUserId);
}

async function handleSubscriptionDeleted(sub: Stripe.Subscription) {
  if (!hasConfiguredProPrice(sub)) {
    log('ignoring deleted subscription with an unrecognized price', sub.id);
    return;
  }
  const userId = await resolveUserId(sub);
  if (!userId) { log('deleted subscription with no mapping - skipping'); return; }

  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id ?? null;
  await writeSubscription({
    user_id: userId,
    stripe_customer_id: customerId,
    stripe_subscription_id: sub.id,
    stripe_subscription_created_at: subscriptionCreatedISO(sub),
    status: 'canceled',
    plan: 'free',
    current_period_end: periodEndISO(sub),
    cancel_at_period_end: false,
  });
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const signature = req.headers.get('stripe-signature');
  if (!signature) return new Response('Missing stripe-signature', { status: 400 });

  // The signature is computed over the exact bytes, so read the body as text
  // and never parse it before verifying.
  const raw = await req.text();

  let event: Stripe.Event;
  try {
    // Async variant is required: the Deno runtime's crypto is promise-based and
    // the synchronous constructEvent throws here.
    event = await stripe.webhooks.constructEventAsync(raw, signature, WEBHOOK_SECRET);
  } catch (error) {
    log('signature verification failed', (error as Error).message);
    return new Response('Invalid signature', { status: 400 });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
        break;

      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        await syncFromSubscriptionId((event.data.object as Stripe.Subscription).id);
        break;

      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event.data.object as Stripe.Subscription);
        break;

      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        // Stripe moved this. Through 2025-03-31.basil an invoice carried
        // `subscription` directly; from the 2026 versions on (dahlia and later)
        // it hangs off `parent.subscription_details.subscription`. Read both, or
        // this handler silently does nothing on a newer account and a failed
        // payment never marks the row past_due.
        const legacy = (invoice as unknown as { subscription?: string | { id: string } }).subscription;
        const parent = (invoice as unknown as {
          parent?: { subscription_details?: { subscription?: string | { id: string } } };
        }).parent;
        const subscriptionId = legacy ?? parent?.subscription_details?.subscription;
        const id = typeof subscriptionId === 'string' ? subscriptionId : subscriptionId?.id;
        // Re-reading gives us Stripe's own verdict (past_due vs unpaid vs
        // canceled) instead of guessing from the invoice.
        if (id) await syncFromSubscriptionId(id);
        break;
      }

      default:
        log('ignoring', event.type);
    }
  } catch (error) {
    // A 5xx makes Stripe retry with backoff, which is what we want for a
    // transient database or network failure.
    const message = (error as Error)?.message ?? String(error);
    log('handler failed', event.type, message);
    // Return the real reason, not a generic string. Only Stripe reaches this
    // line (the signature check above already rejected everything else), and
    // this body shows up directly in the Stripe delivery panel. A generic
    // 'Handler error' means every failure costs a trip through the edge
    // function logs to learn anything at all.
    return new Response(JSON.stringify({ error: message, event: event.type }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
});
