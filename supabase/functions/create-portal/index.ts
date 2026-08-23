// =============================================================================
// Authenticated Stripe Customer Portal session
// =============================================================================
//
// "Manage subscription" in the app and on the site. The caller's identity comes
// from the Supabase JWT, the Stripe customer id comes from their own
// `subscriptions` row (readable under RLS), and the only thing returned is a
// short-lived billing.stripe.com URL. No card data, no plan data, no writes.
//
// DEPLOY:  supabase functions deploy create-portal
// SECRETS: STRIPE_SECRET_KEY, STRIPE_PORTAL_RETURN_URL (https page to land on)
// =============================================================================

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

function returnUrl(): string {
  const value = Deno.env.get('STRIPE_PORTAL_RETURN_URL') || Deno.env.get('STRIPE_CHECKOUT_SUCCESS_URL');
  if (!value) throw new Error('STRIPE_PORTAL_RETURN_URL is not configured');
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('STRIPE_PORTAL_RETURN_URL must be an http or https URL');
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
    .select('stripe_customer_id')
    .maybeSingle();
  if (lookupError) return json({ error: 'subscription_lookup_failed' }, 500);
  if (!existing?.stripe_customer_id) return json({ error: 'no_subscription' }, 404);

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: existing.stripe_customer_id,
      return_url: returnUrl(),
    });
    if (!session.url) throw new Error('Stripe returned no portal URL');
    return json({ url: session.url });
  } catch (error) {
    const message = (error as Error)?.message ?? String(error);
    console.error('[create-portal]', message);
    return json({ error: 'portal_unavailable', detail: message }, 502);
  }
});
