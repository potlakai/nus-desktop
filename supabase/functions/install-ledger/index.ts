// =============================================================================
// install-ledger: one hashed summary row per install for the Growth OS
// =============================================================================
//
// GET ?since=YYYY-MM-DD (optional; default every install) returns a JSON list
// with one object per install that sent `install`, excluding the founder's
// own installs, computed on completed UTC days only by
// public.install_ledger(since, salt) in schema.sql (sixth edition). Shape, per
// TELEMETRY-CONTRACT.md amendment (c) plus the fifth-edition retention fields
// (Companion 0.1.16, 2026-11-06) and the sixth-edition sign-in fields
// (Companion 0.1.19, amendment f, 2026-11-11):
//
//   {"install_hash":"3f9a1c2b7d4e6f80","product":"companion","install_day":"2026-10-06",
//    "last_open_day":"2026-10-15","days_opened":7,"opens_7d":4,"asks_total":31,
//    "asks_by_feature":{"hands":18},"asks_failed":3,"minutes_total":212,
//    "minutes_by_feature":{"hands":40},"first_ask_delay_min":3,"last_step":"key_connected",
//    "source":"instagram","action_id":"act-20261005-0f627fb","app_version":"0.1.8",
//    "crashes":0,"dormant":false,
//    "first_version":"0.1.16","first_win_delay_min":2,"first_win_feature":"hands",
//    "engaged_days_w1":4,"engaged_days_28":9,"last_engaged_day":"2026-11-05",
//    "ai_ready_path":"key","struggle":"homework_start","nudge_group":"on",
//    "hooks_shown":{"checkin":3,"morning_line":5},"hooks_used":{"checkin":1},
//    "signin_shown":2,"signin_cohort":"new","signin_clicked":1,"signin_delay_min":3,
//    "signin_closed":{"sign_in":1},"signin_unreachable":0,"ai_source":"publik"}
//
// The raw install id never leaves the database: install_hash is the first 16
// hex characters of sha256(install_id || LEDGER_SALT), and the salt is a
// function secret handed to the SQL function per call. Rows reflect completed
// days, so a row can change from one pull to the next; the Growth OS upserts
// by install_hash.
//
// Auth: same as daily-metrics. The gateway does not verify a JWT (the puller
// has no Supabase user); every request must carry
// `Authorization: Bearer <METRICS_TOKEN>`, compared in constant time.
//
// DEPLOY:  supabase functions deploy install-ledger --no-verify-jwt
// SECRETS: METRICS_TOKEN (shared with daily-metrics), LEDGER_SALT (32 random
//          bytes as hex; rotating it changes every install_hash, so set it
//          once and keep it).
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically.
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';

const MIN_SALT_CHARS = 16;

type LedgerRow = {
  install_hash: string;
  product: string;
  install_day: string;
  last_open_day: string | null;
  days_opened: number;
  opens_7d: number;
  asks_total: number;
  asks_by_feature: Record<string, number>;
  asks_failed: number;
  minutes_total: number;
  minutes_by_feature: Record<string, number>;
  first_ask_delay_min: number | null;
  last_step: string | null;
  source: string | null;
  action_id: string;
  app_version: string | null;
  crashes: number;
  dormant: boolean;
  first_version: string | null;
  first_win_delay_min: number | null;
  first_win_feature: string | null;
  engaged_days_w1: number;
  engaged_days_28: number;
  last_engaged_day: string | null;
  ai_ready_path: string | null;
  struggle: string | null;
  nudge_group: string | null;
  hooks_shown: Record<string, number>;
  hooks_used: Record<string, number>;
  signin_shown: number;
  signin_cohort: string | null;
  signin_clicked: number;
  signin_delay_min: number | null;
  signin_closed: Record<string, number>;
  signin_unreachable: number;
  ai_source: string | null;
  // Seventh edition (Companion 0.1.37, dictation).
  dictate_arm: string | null;
  dictation_asks: number;
  dictation_days_w1: number;
  engaged_days_w1_nodict: number;
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left[i] ^ right[i];
  return diff === 0;
}

function utcDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// `since` is optional here: no value, or a value that is not a calendar date,
// means every install. The puller upserts by install_hash, so a wide answer is
// always safe.
function parseSince(value: string | null): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || utcDateString(parsed) !== value) return null;
  return value;
}

function dayString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value).slice(0, 10);
}

function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

function int(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function intOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function numberMap(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const n = Number(raw);
    if (Number.isFinite(n)) out[key] = Math.round(n);
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);

  const expected = Deno.env.get('METRICS_TOKEN') || '';
  const authorization = req.headers.get('Authorization') || '';
  const given = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length).trim() : '';
  if (!expected || !given || !constantTimeEqual(given, expected)) return json({ error: 'unauthorized' }, 401);

  // Never answer unsalted: a short or missing salt would make install_hash
  // guessable from an install id, and the SQL function refuses it too.
  const salt = Deno.env.get('LEDGER_SALT') || '';
  if (salt.length < MIN_SALT_CHARS) {
    console.error('[install-ledger] LEDGER_SALT is not set');
    return json({ error: 'salt_missing' }, 500);
  }

  const since = parseSince(new URL(req.url).searchParams.get('since'));

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  const { data, error } = await admin.rpc('install_ledger', { since, salt });
  if (error) {
    console.error('[install-ledger] ledger failed', error.message);
    return json({ error: 'ledger_failed' }, 500);
  }

  // Reshape explicitly so the wire format never drifts with the SQL function
  // (bigint and numeric can arrive as strings, dates as timestamps).
  const rows: LedgerRow[] = (Array.isArray(data) ? data : []).map((r: Record<string, unknown>) => ({
    install_hash: String(r.install_hash ?? ''),
    product: String(r.product ?? ''),
    install_day: dayString(r.install_day) ?? '',
    last_open_day: dayString(r.last_open_day),
    days_opened: int(r.days_opened),
    opens_7d: int(r.opens_7d),
    asks_total: int(r.asks_total),
    asks_by_feature: numberMap(r.asks_by_feature),
    asks_failed: int(r.asks_failed),
    minutes_total: int(r.minutes_total),
    minutes_by_feature: numberMap(r.minutes_by_feature),
    first_ask_delay_min: intOrNull(r.first_ask_delay_min),
    last_step: text(r.last_step),
    source: text(r.source),
    action_id: String(r.action_id ?? ''),
    app_version: text(r.app_version),
    crashes: int(r.crashes),
    dormant: Boolean(r.dormant),
    first_version: text(r.first_version),
    first_win_delay_min: intOrNull(r.first_win_delay_min),
    first_win_feature: text(r.first_win_feature),
    engaged_days_w1: int(r.engaged_days_w1),
    engaged_days_28: int(r.engaged_days_28),
    last_engaged_day: dayString(r.last_engaged_day),
    ai_ready_path: text(r.ai_ready_path),
    struggle: text(r.struggle),
    nudge_group: text(r.nudge_group),
    hooks_shown: numberMap(r.hooks_shown),
    hooks_used: numberMap(r.hooks_used),
    signin_shown: int(r.signin_shown),
    signin_cohort: text(r.signin_cohort),
    signin_clicked: int(r.signin_clicked),
    signin_delay_min: intOrNull(r.signin_delay_min),
    signin_closed: numberMap(r.signin_closed),
    signin_unreachable: int(r.signin_unreachable),
    ai_source: text(r.ai_source),
    dictate_arm: text(r.dictate_arm),
    dictation_asks: int(r.dictation_asks),
    dictation_days_w1: int(r.dictation_days_w1),
    engaged_days_w1_nodict: int(r.engaged_days_w1_nodict),
  }));
  return json(rows);
});
