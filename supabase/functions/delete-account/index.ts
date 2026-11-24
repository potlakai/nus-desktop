// =============================================================================
// delete-account: the signed-in person deletes their Nūs account
// =============================================================================
//
// The Account card's Delete account button. Identity comes from the user JWT
// the gateway verified; the body is empty. Deleting the auth user cascades
// every row that hangs off it: profiles, subscriptions, devices,
// install_links, user_settings. install_events and feedback are keyed by the
// random install id, not the account, so they stay and are anonymous again
// once the link is gone.
//   POST {} -> 200 { deleted: true }
// 401 without a user; 409 while a paid plan is still running (cancel it in
// the Stripe portal first, so nobody is billed for an account that is gone).
//
// DEPLOY:  supabase functions deploy delete-account      (JWT verification ON)
// SECRETS: none of its own. SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are
//          injected automatically.
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
};

function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return reply(405, { error: 'method_not_allowed' });

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false, autoRefreshToken: false } });
  const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const { data: who, error: whoError } = jwt ? await admin.auth.getUser(jwt) : { data: null, error: true };
  const userId = who?.user?.id;
  if (whoError || !userId) return reply(401, { error: 'sign_in_required' });

  const { data: sub } = await admin.from('subscriptions')
    .select('status, current_period_end').eq('user_id', userId).maybeSingle();
  const running = sub && ['active', 'trialing', 'past_due'].includes(sub.status)
    && sub.current_period_end && Date.parse(sub.current_period_end) > Date.now();
  if (running) return reply(409, { error: 'cancel_plan_first' });

  const { error } = await admin.auth.admin.deleteUser(userId);
  if (error) return reply(500, { error: 'delete_failed' });
  return reply(200, { deleted: true });
});
