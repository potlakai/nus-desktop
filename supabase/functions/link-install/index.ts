// =============================================================================
// link-install: tie this computer's anonymous install id to the signed-in user
// =============================================================================
//
// The Companion calls this right after Sign in with Google (and at a later
// launch if that first call missed), only while the person's stats switch is
// on. Identity comes from the Supabase user JWT the gateway verified; the body
// carries the install id, the consent words' version, the app version and the
// platform, nothing else.
//   POST   { install_id, consent_version, app_version, platform } -> 200 { linked: true }
//          writes public.install_links (one account per install, a new sign-in
//          moves it) and upserts the person's public.devices row.
//   DELETE { install_id } -> 200 { linked: false }   Unlink: both rows go.
// 400 on a bad shape, 401 without a user, 409 past 20 linked installs.
//
// DEPLOY:  supabase functions deploy link-install        (JWT verification ON)
// SECRETS: none of its own. SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are
//          injected automatically.
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, DELETE, OPTIONS',
};

// The consent lines the Account card has shown. A version not listed here was
// never shown to anyone, so it is refused.
const CONSENT_VERSIONS = new Set(['2026-10-31']);
const PLATFORMS = new Set(['win32', 'darwin', 'linux']);
const MAX_LINKS_PER_USER = 20;
const MAX_BODY_BYTES = 2 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST' && req.method !== 'DELETE') return reply(405, { error: 'method_not_allowed' });

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false, autoRefreshToken: false } });
  const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const { data: who, error: whoError } = jwt ? await admin.auth.getUser(jwt) : { data: null, error: true };
  const userId = who?.user?.id;
  if (whoError || !userId) return reply(401, { error: 'sign_in_required' });

  const raw = await req.text();
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) return reply(400, { error: 'too_large' });
  let body: Record<string, unknown>;
  try { body = JSON.parse(raw); if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('shape'); }
  catch { return reply(400, { error: 'bad_json' }); }

  const installId = typeof body.install_id === 'string' ? body.install_id.trim() : '';
  if (!UUID_RE.test(installId)) return reply(400, { error: 'bad_install_id' });

  if (req.method === 'DELETE') {
    const gone = await admin.from('install_links').delete().eq('install_id', installId).eq('user_id', userId);
    if (gone.error) return reply(500, { error: 'unlink_failed' });
    await admin.from('devices').delete().eq('user_id', userId).eq('device_id', installId);
    return reply(200, { linked: false });
  }

  const consent = typeof body.consent_version === 'string' ? body.consent_version : '';
  if (!CONSENT_VERSIONS.has(consent)) return reply(400, { error: 'bad_consent_version' });
  const appVersion = typeof body.app_version === 'string' ? body.app_version.slice(0, 40) : null;
  const platform = typeof body.platform === 'string' && PLATFORMS.has(body.platform) ? body.platform : null;

  // The cap counts the person's other installs; relinking this one is free.
  const { count, error: countError } = await admin.from('install_links')
    .select('install_id', { count: 'exact', head: true }).eq('user_id', userId).neq('install_id', installId);
  if (countError) return reply(500, { error: 'link_failed' });
  if ((count ?? 0) >= MAX_LINKS_PER_USER) return reply(409, { error: 'too_many_installs' });

  // A link that moves to this person leaves the previous account's device row.
  await admin.from('devices').delete().eq('device_id', installId).neq('user_id', userId);
  const link = await admin.from('install_links').upsert({
    install_id: installId, user_id: userId, product: 'companion', consent_version: consent,
    app_version: appVersion, linked_at: new Date().toISOString(),
  }, { onConflict: 'install_id' });
  if (link.error) return reply(500, { error: 'link_failed' });
  await admin.from('devices').upsert({
    user_id: userId, device_id: installId, os: platform, app_version: appVersion, last_seen: new Date().toISOString(),
  }, { onConflict: 'user_id,device_id' });
  return reply(200, { linked: true });
});
