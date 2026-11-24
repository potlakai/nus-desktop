// =============================================================================
// click: a download-button click on the site -> public.download_clicks
// =============================================================================
//
// Half of the click-to-install bridge (2026-10-15). The landing page's attrib.js
// sends one small beacon when a download button is clicked, BEFORE the browser
// follows the GitHub release link, so the download never depends on this
// function being awake (the Supabase project paused itself once, 2026-09-06).
//
// What is stored: which file was clicked, the campaign labels the page held
// (first touch, validated again here), a coarse device family, and a server
// timestamp. What is not: IP, user agent string, cookie, referrer, anything
// typed. There is no identity on this side at all; install_click_matches()
// in schema.sql later joins a click to an install by product and time only,
// and that join is labelled probable on the wire.
//
// Body (JSON, sent as text/plain by navigator.sendBeacon so there is no CORS
// preflight; parsed regardless of Content-Type):
//   {"file":"companion-setup","action_id":"act-20261005-0f627fb",
//    "utm_source":"instagram","utm_medium":"organic",
//    "utm_campaign":"growth-os-act-20261005-0f627fb","device":"windows"}
// Answers 204 on accept, 400 on a bad shape, 429 over the daily cap.
//
// DEPLOY:  supabase functions deploy click --no-verify-jwt
// SECRETS: none of its own. SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are
//          injected automatically. Run the schema.sql bridge section first.
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Keep identical to FILE_PRODUCT in growth_os/bridge.py and fileKey() in
// nus-site/assets/attrib.js.
const FILE_PRODUCT: Record<string, string> = {
  'desktop-setup': 'desktop',
  'desktop-portable': 'desktop',
  'desktop-mac-arm64': 'desktop',
  'desktop-mac-x64': 'desktop',
  'companion-setup': 'companion',
  'companion-portable': 'companion',
};
const DEVICES = new Set(['windows', 'mac', 'iphone', 'android', 'other']);
const ACTION_RE = /^act-\d{8}-[a-f0-9]{7}$/;
const UTM_RE = /^[a-z0-9_-]{1,60}$/;

const MAX_BODY_BYTES = 2 * 1024;
// Abuse ceiling, not a product limit: the site sends a few clicks a day.
const DAILY_CAP = 5000;

function reply(status: number, body?: unknown) {
  if (body === undefined) return new Response(null, { status, headers: corsHeaders });
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

// '' is allowed (a direct click with no campaign is still a click); anything
// else must match the shape exactly.
function label(value: unknown, re: RegExp): string | null {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return '';
  return re.test(trimmed) ? trimmed : null;
}

function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return reply(405, { error: 'method_not_allowed' });

  const raw = await req.text();
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) return reply(400, { error: 'too_large' });
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('shape');
  } catch {
    return reply(400, { error: 'bad_json' });
  }

  const fileKey = typeof body.file === 'string' ? body.file.trim() : '';
  const product = FILE_PRODUCT[fileKey];
  if (!product) return reply(400, { error: 'bad_file' });
  const actionId = label(body.action_id, ACTION_RE);
  const utmSource = label(body.utm_source, UTM_RE);
  const utmMedium = label(body.utm_medium, UTM_RE);
  const utmCampaign = label(body.utm_campaign, UTM_RE);
  if (actionId === null || utmSource === null || utmMedium === null || utmCampaign === null) {
    return reply(400, { error: 'bad_labels' });
  }
  const device = typeof body.device === 'string' && DEVICES.has(body.device) ? body.device : 'other';

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  const today = utcDay();
  const { count, error: countError } = await admin
    .from('download_clicks')
    .select('id', { count: 'exact', head: true })
    .eq('day', today);
  if (countError) {
    console.error('[click] cap check failed', countError.message);
    return reply(500, { error: 'cap_check_failed' });
  }
  if ((count ?? 0) >= DAILY_CAP) return reply(429, { error: 'capped' });

  const { error } = await admin.from('download_clicks').insert({
    product,
    file_key: fileKey,
    action_id: actionId,
    utm_source: utmSource,
    utm_medium: utmMedium,
    utm_campaign: utmCampaign,
    device,
    day: today,
  });
  if (error) {
    console.error('[click] insert failed', error.message);
    return reply(500, { error: 'insert_failed' });
  }
  return reply(204);
});
