// =============================================================================
// track: anonymous usage stats -> public.install_events
// =============================================================================
//
// Both Nūs apps POST one small JSON event here (TELEMETRY-CONTRACT.md in the
// Growth OS repo is the contract). Callers are anonymous by design: the
// install id is a random UUID the client made on first launch and never ties
// to an account, so the gateway does not verify a JWT. Instead this function
//   - validates the shape, the event name, the props keys and the props size,
//   - rate-limits to 200 events per install per UTC day (count, then insert),
//   - inserts with the service role, because the table has no client policies,
//   - answers 204 on accept, 400 on a bad shape or name, 429 over the limit.
// The body never carries content: props values are short strings, numbers or
// booleans under allowed keys only, and anything else is dropped with 400.
//
// DEPLOY:  supabase functions deploy track --no-verify-jwt
// SECRETS: none of its own. SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are
//          injected automatically.
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
};

// Keep these lists identical to the CHECK constraints in schema.sql (fourth
// edition) and to the allowed names and props keys in TELEMETRY-CONTRACT.md.
// `dev` (boolean, 2026-10-15 b) marks the founder's own installs; the rollup
// excludes them. The six names after stats_off and the keys after dev are
// amendment (c), 2026-10-17: feature time, first-run leaks. Amendment (d),
// 2026-11-04, is the update and notice channel; the fifth edition, 2026-11-06,
// is Companion 0.1.16 retention (first win, engaged days, hooks, holdout).
// Amendment (f), 2026-11-11 (sixth edition), is the sign-in door of Companion
// 0.1.19 (Sign in with publik) and the contact card's two hook values.
const PRODUCTS = new Set(['desktop', 'companion']);
const NAMES = new Set([
  'install', 'app_open', 'source_answer', 'first_import', 'import', 'first_ask', 'ask',
  'key_connected', 'companion_session', 'signin', 'limit_hit', 'upgrade_click',
  'checkout_started', 'stats_off',
  'feature_session', 'app_session', 'onboarding_step', 'first_run_end', 'crash',
  'update_installed',
  // Amendment (d), 2026-11-04: the update and notice channel.
  'update_offered', 'notice_shown', 'notice_clicked',
  // Fifth edition, 2026-11-06: Companion 0.1.16 retention.
  'first_win', 'engaged', 'ai_ready', 'hook_shown', 'hook_used',
  // Sixth edition, 2026-11-11: the sign-in door. `signin` (above) is reused
  // for "signed in", with method publik.
  'signin_shown', 'signin_clicked', 'signin_closed', 'signin_unreachable', 'ai_source',
  // Eighth edition, 2026-11-24 (Companion 0.1.38): how a run ended.
  'app_exit',
  // Tenth edition, 2026-11-24 (Companion 0.1.40): how long an answered ask took, and how long
  // since the ask before it. {feature, speed, gap}, all three from fixed lists.
  'ask_speed',
]);
const PROP_KEYS = new Set([
  'acq_action_id', 'utm_source', 'utm_medium', 'utm_campaign', 'source', 'mode',
  'provider', 'minutes', 'method', 'unit', 'reason', 'os_version', 'locale', 'dev',
  'feature', 'seconds', 'outcome', 'step', 'from', 'surface', 'notice', 'via',
  'hook', 'path', 'struggle', 'nudge_group',
  'cohort', 'screen',
  // Tenth edition: on ask_speed only.
  'speed', 'gap',
]);
// Fixed lists (amendment c). A value outside them is a client bug: 400, like
// an unknown key. `from` is a version string, capped at 40 characters.
const FEATURES = new Set([
  'reflex', 'hands', 'memory', 'focus_guard', 'reminder', 'guide', 'plan', 'chat',
  'voice', 'ask_bar', 'companion', 'import',
  // Fifth edition. `greeting` is a hello: it never counts as a first win.
  'greeting', 'rewrite', 'page_read', 'recall', 'project',
  // Seventh edition (Companion 0.1.37): hold Ctrl+Win to dictate. An ask row
  // with mode voice and this feature; never a first ask or a first win.
  'dictation',
]);
const OUTCOMES = new Set(['ok', 'failed', 'no_provider', 'cancelled', 'timeout']);
const STEPS = new Set([
  'welcome_seen', 'stats_notice_seen', 'key_prompt_seen', 'key_skipped', 'key_connected',
  'first_window_closed',
  // Fifth edition: the 0.1.16 tour, the struggle question, start-with-Windows.
  'tour_voice', 'tour_mic', 'tour_key', 'tour_questions', 'tour_home', 'tour_sharing',
  'tour_ai', 'tour_guide', 'tour_hands', 'tour_dashboard', 'tour_done', 'tour_skipped',
  'struggle_picked', 'autostart_on', 'autostart_off',
  // Seventh edition: the dictation tour card, after the talk key's card.
  'tour_dictate',
  // Ninth edition (Companion 0.1.40): the choose screen publik showed (free use or a balance, a plan,
  // none left), the check before own key with no key on the computer, the tour's AI card first, and
  // its Get a free key button.
  'door_balance', 'door_plan', 'door_empty', 'door_nokey_seen', 'tour_ai_first', 'tour_get_key',
]);
// `notice` is a number we assign in the signed channel file: n1, n2, ...
const SURFACES = new Set(['bubble', 'card']);
// `via` means two things: how an update was installed (update_installed) and
// how the app was started (app_open, fifth edition). VIAS is the union, and
// VIA_BY_NAME narrows it per event; `via` on any other event is a 400.
const VIAS = new Set(['oneclick', 'manual', 'login', 'relaunch']);
const VIA_BY_NAME: Record<string, Set<string>> = {
  update_installed: new Set(['oneclick', 'manual']),
  app_open: new Set(['login', 'manual', 'relaunch']),
};
const NOTICE_ID = /^n[0-9]{1,6}$/;
// Fifth edition lists.
const HOOKS = new Set([
  'checkin', 'morning_line', 'continue_project', 'reminder_toast', 'autostart_offer', 'my_nus',
  'knot_report', 'notice', 'winback_d3', 'winback_d7', 'winback_d30', 'share_card', 'quiet_mode',
  // Sixth edition: the one ask for an email after a first win.
  'contact_card', 'contact_declined',
  // Eighth edition: the one line telling an updated install that dictation exists.
  'dictation_news',
]);
// Eighth edition: app_exit carries a reason from this list. Other events keep
// `reason` as a free short string, as before.
const EXIT_REASONS = new Set(['quit', 'shutdown', 'update', 'uninstall', 'exam', 'other']);
// Tenth edition: ask_speed. speed: seconds from the ask to the answer finished or the step pointed.
// gap: minutes since the ask before it in the same run of the app (first: none since it started).
// Both only on ask_speed; anywhere else they are a 400.
const SPEEDS = new Set(['under2', '2to4', '4to8', '8to15', 'over15']);
const GAPS = new Set(['first', 'under5', '5to30', 'over30']);
// `path` means two things: how answers are possible (ai_ready, once) and who
// answers after the sign-in door (ai_source, sixth edition). AI_PATHS is the
// union, and PATH_BY_NAME narrows it per event; `path` on any other event is a 400.
const AI_PATHS = new Set(['key', 'claude_code', 'none', 'publik', 'own_key']);
const PATH_BY_NAME: Record<string, Set<string>> = {
  ai_ready: new Set(['key', 'claude_code', 'none', 'publik']),
  ai_source: new Set(['publik', 'own_key']),
};
// Sixth edition lists. cohort: was a different version on this install before
// this one. screen: where the sign-in door stood when it was closed.
const COHORTS = new Set(['new', 'update']);
const GATE_SCREENS = new Set(['sign_in', 'waiting', 'choose', 'unreachable']);
const STRUGGLES = new Set(['homework_start', 'feeds', 'find_in_apps', 'writing', 'remember', 'other']);
const NUDGE_GROUPS = new Set(['on', 'off']);
const FIXED_LISTS: Record<string, Set<string>> = {
  feature: FEATURES, outcome: OUTCOMES, step: STEPS, surface: SURFACES, via: VIAS,
  hook: HOOKS, path: AI_PATHS, struggle: STRUGGLES, nudge_group: NUDGE_GROUPS,
  cohort: COHORTS, screen: GATE_SCREENS,
  speed: SPEEDS, gap: GAPS,
};
const MAX_FROM_CHARS = 40;
// Dedupe to one per install per UTC day, and to one per install ever; each
// must match its partial unique index in schema.sql (fifth edition).
const DAILY_UNIQUE = new Set(['app_open', 'engaged']);
const ONCE_PER_INSTALL = new Set(['first_win', 'ai_ready']);

const MAX_BODY_BYTES = 8 * 1024;
const MAX_PROPS_BYTES = 1024;
const MAX_PROP_STRING = 80;
const RATE_LIMIT_PER_DAY = 200;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Props = Record<string, string | number | boolean>;

function reply(status: number, body?: unknown) {
  if (body === undefined) return new Response(null, { status, headers: corsHeaders });
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function shortText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

// Strict, not lenient: a client that sends an unknown key or a nested value is
// a client with a bug, and a 400 is how it finds out. Returns null on any
// violation.
function cleanProps(value: unknown, name: string): Props | null {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  const out: Props = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!PROP_KEYS.has(key)) return null;
    if (typeof raw === 'boolean') out[key] = raw;
    else if (typeof raw === 'number' && Number.isFinite(raw)) out[key] = raw;
    else if (typeof raw === 'string') {
      if (raw.length > MAX_PROP_STRING) return null;
      out[key] = raw;
    } else return null;
    // Fixed-list keys must be strings from their list; `from` is a short string.
    const list = FIXED_LISTS[key];
    if (list && !(typeof raw === 'string' && list.has(raw))) return null;
    if (key === 'from' && !(typeof raw === 'string' && raw.length <= MAX_FROM_CHARS)) return null;
    if (key === 'notice' && !(typeof raw === 'string' && NOTICE_ID.test(raw))) return null;
    if (key === 'via' && !VIA_BY_NAME[name]?.has(raw as string)) return null;
    if (key === 'path' && !PATH_BY_NAME[name]?.has(raw as string)) return null;
    if (key === 'reason' && name === 'app_exit' && !EXIT_REASONS.has(raw as string)) return null;
    if ((key === 'speed' || key === 'gap') && name !== 'ask_speed') return null;
  }
  if (new TextEncoder().encode(JSON.stringify(out)).length > MAX_PROPS_BYTES) return null;
  return out;
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

  const installId = shortText(body.install_id, 36);
  if (!installId || !UUID_RE.test(installId)) return reply(400, { error: 'bad_install_id' });
  const product = typeof body.product === 'string' && PRODUCTS.has(body.product) ? body.product : null;
  if (!product) return reply(400, { error: 'bad_product' });
  const name = typeof body.name === 'string' && NAMES.has(body.name) ? body.name : null;
  if (!name) return reply(400, { error: 'bad_name' });
  const props = cleanProps(body.props, name);
  if (!props) return reply(400, { error: 'bad_props' });

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  // Rate limit: per install, one UTC day window. Count first, then insert.
  const today = utcDay();
  const { count, error: countError } = await admin
    .from('install_events')
    .select('id', { count: 'exact', head: true })
    .eq('install_id', installId.toLowerCase())
    .eq('day', today);
  if (countError) {
    console.error('[track] rate check failed', countError.message);
    return reply(500, { error: 'rate_check_failed' });
  }
  if ((count ?? 0) >= RATE_LIMIT_PER_DAY) return reply(429, { error: 'rate_limited' });

  const row = {
    install_id: installId.toLowerCase(),
    product,
    name,
    app_version: shortText(body.app_version, 40),
    platform: shortText(body.platform, 20),
    props,
    day: today,
  };

  // app_open and engaged: one row per install per UTC day, enforced by the
  // partial unique index install_events_one_per_day; first_win and ai_ready:
  // one row per install, by install_events_once_per_install. PostgREST cannot express the index
  // predicate that `on conflict ... where name in ('app_open') do nothing`
  // needs to infer a partial index, so the "do nothing" lives here: a unique
  // violation on one of those names is the expected repeat and answers 204
  // like the first one did.
  const { error } = await admin.from('install_events').insert(row);
  if (error) {
    if (error.code === '23505' && (DAILY_UNIQUE.has(name) || ONCE_PER_INSTALL.has(name))) return reply(204);
    console.error('[track] insert failed', error.message);
    return reply(500, { error: 'insert_failed' });
  }
  return reply(204);
});
