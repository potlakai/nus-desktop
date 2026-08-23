import Stripe from 'https://esm.sh/stripe@17.7.0?target=deno';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
};

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  httpClient: Stripe.createFetchHttpClient(),
  apiVersion: '2025-03-31.basil',
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function requiredUrl(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is not configured`);
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`${name} must be an http or https URL`);
  }
  return parsed.toString();
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const authorization = req.headers.get('Authorization');
  if (!authorization?.startsWith('Bearer ')) return json({ error: 'not_authenticated' }, 401);
  const publicKey = req.headers.get('apikey') || Deno.env.get('SUPABASE_ANON_KEY');
  if (!publicKey) return json({ error: 'not_authenticated' }, 401);

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    publicKey,
    {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: authorization } },
    },
  );

  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return json({ error: 'not_authenticated' }, 401);

  const { data: existing, error: lookupError } = await supabase
    .from('subscriptions')
    .select('stripe_customer_id,status,current_period_end')
    .maybeSingle();
  if (lookupError) return json({ error: 'subscription_lookup_failed' }, 500);

  const periodEnd = existing?.current_period_end ? Date.parse(existing.current_period_end) : 0;
  if (['active', 'trialing'].includes(existing?.status) && periodEnd > Date.now()) {
    return json({ error: 'already_subscribed' }, 409);
  }

  const priceId = Deno.env.get('STRIPE_PRICE_ID');
  if (!priceId?.startsWith('price_')) return json({ error: 'billing_not_configured' }, 503);

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: requiredUrl('STRIPE_CHECKOUT_SUCCESS_URL'),
      cancel_url: requiredUrl('STRIPE_CHECKOUT_CANCEL_URL'),
      client_reference_id: user.id,
      customer: existing?.stripe_customer_id || undefined,
      customer_email: existing?.stripe_customer_id ? undefined : user.email,
      subscription_data: { metadata: { nus_user_id: user.id } },
      metadata: { nus_user_id: user.id },
    }, {
      // Stripe retains idempotency keys for at least 24 hours, the same default
      // lifetime as a Checkout Session. Repeated Upgrade clicks return one
      // session instead of creating multiple subscriptions for one user.
      idempotencyKey: `nus-checkout:${user.id}`,
    });
    if (!session.url) throw new Error('Stripe returned no Checkout URL');
    return json({ url: session.url });
  } catch (error) {
    const message = (error as Error)?.message ?? String(error);
    console.error('[create-checkout]', message);
    // Surface Stripe's own reason. Only a signed-in user reaches this line, and
    // a bare 'checkout_unavailable' costs a trip through the edge function logs
    // to learn anything, which is exactly how a misconfigured price or an
    // unactivated account turns into an hour of guessing.
    return json({ error: 'checkout_unavailable', detail: message }, 502);
  }
});
