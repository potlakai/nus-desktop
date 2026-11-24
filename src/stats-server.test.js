// The server half of TELEMETRY-CONTRACT.md amendment (c) (2026-10-17): the
// fourth-edition schema, the widened `track` allow-lists with their fixed
// value lists, and the `install-ledger` read function. Static checks over the
// files in supabase/, in the style of the contract checks in stats.test.js;
// the SQL itself was exercised against a Postgres fixture when it was written,
// but nothing here needs a database.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const quotedList = (text, regex) => {
  const match = text.match(regex);
  assert.ok(match, `found ${regex}`);
  return [...match[1].matchAll(/'([a-z_0-9]+)'/g)].map((m) => m[1]).sort();
};

// The contract's lists, copied here on purpose so a drift in any file shows.
const NAMES = [
  'install', 'app_open', 'source_answer', 'first_import', 'import', 'first_ask', 'ask',
  'key_connected', 'companion_session', 'signin', 'limit_hit', 'upgrade_click',
  'checkout_started', 'stats_off',
  'feature_session', 'app_session', 'onboarding_step', 'first_run_end', 'crash', 'update_installed',
  // Amendment (d), 2026-11-04, and the fifth edition, 2026-11-06 (Companion 0.1.16).
  'update_offered', 'notice_shown', 'notice_clicked',
  'first_win', 'engaged', 'ai_ready', 'hook_shown', 'hook_used',
  // The sixth edition, 2026-11-11 (amendment f): the sign-in door of Companion 0.1.19.
  'signin_shown', 'signin_clicked', 'signin_closed', 'signin_unreachable', 'ai_source',
  // The eighth edition, 2026-11-24: how a run of Companion 0.1.38 ended.
  'app_exit',
  // The tenth edition, 2026-11-24: how long an answered ask of Companion 0.1.40 took.
  'ask_speed',
].sort();
const PROP_KEYS = [
  'acq_action_id', 'utm_source', 'utm_medium', 'utm_campaign', 'source', 'mode',
  'provider', 'minutes', 'method', 'unit', 'reason', 'os_version', 'locale', 'dev',
  'feature', 'seconds', 'outcome', 'step', 'from',
  'surface', 'notice', 'via', 'hook', 'path', 'struggle', 'nudge_group',
  'cohort', 'screen',
  'speed', 'gap',
].sort();
const FEATURES = [
  'reflex', 'hands', 'memory', 'focus_guard', 'reminder', 'guide', 'plan', 'chat', 'voice', 'ask_bar', 'companion', 'import',
  'greeting', 'rewrite', 'page_read', 'recall', 'project',
  'dictation',
].sort();
const OUTCOMES = ['ok', 'failed', 'no_provider', 'cancelled', 'timeout'].sort();
const STEPS = [
  'welcome_seen', 'stats_notice_seen', 'key_prompt_seen', 'key_skipped', 'key_connected', 'first_window_closed',
  'tour_voice', 'tour_mic', 'tour_key', 'tour_questions', 'tour_home', 'tour_sharing', 'tour_ai', 'tour_guide',
  'tour_hands', 'tour_dashboard', 'tour_done', 'tour_skipped', 'struggle_picked', 'autostart_on', 'autostart_off',
  'tour_dictate',
  // The ninth edition, 2026-11-24 (Companion 0.1.40).
  'door_balance', 'door_plan', 'door_empty', 'door_nokey_seen', 'tour_ai_first', 'tour_get_key',
].sort();
const HOOKS = [
  'checkin', 'morning_line', 'continue_project', 'reminder_toast', 'autostart_offer', 'my_nus', 'knot_report',
  'notice', 'winback_d3', 'winback_d7', 'winback_d30', 'share_card', 'quiet_mode',
  'contact_card', 'contact_declined',
  'dictation_news',
].sort();
const AI_PATHS = ['key', 'claude_code', 'none', 'publik', 'own_key'].sort();
const STRUGGLES = ['homework_start', 'feeds', 'find_in_apps', 'writing', 'remember', 'other'].sort();
const ROLLUP_ROWS = [
  'install', 'first_import', 'first_ask', 'signin', 'upgrade_click', 'checkout_started',
  'companion_session', 'app_session', 'feature_ask', 'feature_minutes', 'onboarding_step',
  'first_run_end', 'ask_outcome', 'crash', 'update_installed', 'download_beacon', 'app_open',
  'd1_open', 'd7_open', 'paid',
];
const LEDGER_FIELDS = [
  'install_hash', 'product', 'install_day', 'last_open_day', 'days_opened', 'opens_7d', 'asks_total',
  'asks_by_feature', 'asks_failed', 'minutes_total', 'minutes_by_feature', 'first_ask_delay_min',
  'last_step', 'source', 'action_id', 'app_version', 'crashes', 'dormant',
];
const LEDGER_FIELDS_V5 = [
  ...LEDGER_FIELDS,
  'first_version', 'first_win_delay_min', 'first_win_feature', 'engaged_days_w1', 'engaged_days_28',
  'last_engaged_day', 'ai_ready_path', 'struggle', 'nudge_group', 'hooks_shown', 'hooks_used',
];
const LEDGER_FIELDS_V6 = [
  ...LEDGER_FIELDS_V5,
  'signin_shown', 'signin_cohort', 'signin_clicked', 'signin_delay_min', 'signin_closed', 'signin_unreachable', 'ai_source',
];
const ROLLUP_ROWS_V5 = [
  ...ROLLUP_ROWS, 'update_offered', 'notice_shown', 'notice_clicked',
  'first_win', 'first_win_feature', 'engaged', 'engaged_d1', 'engaged_d7', 'ai_ready', 'hook_shown', 'hook_used',
  'app_open_via',
];

const schema = read('supabase/schema.sql');
const track = read('supabase/functions/track/index.ts');
const ledger = read('supabase/functions/install-ledger/index.ts');
const config = read('supabase/config.toml');
// The fourth edition (live since 2026-10-21) runs up to the fifth (live), which
// runs up to the sixth: the last block of the file and the one to paste next.
const fifthAt = schema.lastIndexOf('-- Fifth edition (2026-11-06');
const sixthAt = schema.lastIndexOf('-- Sixth edition (2026-11-11');
const fourth = schema.slice(schema.lastIndexOf('-- Fourth edition (2026-10-17'), fifthAt);
const fifth = schema.slice(fifthAt, sixthAt);
const sixth = schema.slice(sixthAt);

test('the newest edition widens the live name check with an ALTER and the create table carries the same list', () => {
  assert.ok(fourth.length > 0 && fifthAt > 0 && sixthAt > fifthAt, 'fourth, fifth and sixth edition blocks present');
  assert.match(fifth, /drop constraint %I/, 'every old check on name is dropped first');
  assert.match(sixth, /drop constraint %I/, 'and again in the sixth');
  // The newest name check is the last one in the file (the eighth edition since 2026-11-24).
  const lastCheck = schema.slice(schema.lastIndexOf('add constraint install_events_name_check'));
  const live = quotedList(lastCheck, /add constraint install_events_name_check\s+check \(name in \(([\s\S]*?)\)\);/);
  const table = schema.slice(schema.indexOf('create table if not exists public.install_events'));
  const created = quotedList(table, /name\s+text not null\s+check \(name in \(([\s\S]*?)\)\)/);
  assert.deepEqual(live, NAMES);
  assert.deepEqual(created, NAMES);
});

test('track accepts exactly the contract names and props keys', () => {
  assert.deepEqual(quotedList(track, /const NAMES = new Set\(\[([\s\S]*?)\]\)/), NAMES);
  assert.deepEqual(quotedList(track, /const PROP_KEYS = new Set\(\[([\s\S]*?)\]\)/), PROP_KEYS);
  assert.match(track, /RATE_LIMIT_PER_DAY = 200/);
  assert.match(track, /MAX_PROPS_BYTES = 1024/);
  assert.match(track, /reply\(204\)/);
  assert.match(track, /reply\(400, \{ error: 'bad_props' \}\)/);
  assert.match(track, /reply\(429/);
});

test('track enforces the fixed feature, outcome and step lists and caps `from` at 40 characters', () => {
  assert.deepEqual(quotedList(track, /const FEATURES = new Set\(\[([\s\S]*?)\]\)/), FEATURES);
  assert.deepEqual(quotedList(track, /const OUTCOMES = new Set\(\[([\s\S]*?)\]\)/), OUTCOMES);
  assert.deepEqual(quotedList(track, /const STEPS = new Set\(\[([\s\S]*?)\]\)/), STEPS);
  assert.deepEqual(quotedList(track, /const HOOKS = new Set\(\[([\s\S]*?)\]\)/), HOOKS);
  assert.deepEqual(quotedList(track, /const AI_PATHS = new Set\(\[([\s\S]*?)\]\)/), AI_PATHS);
  assert.deepEqual(quotedList(track, /const STRUGGLES = new Set\(\[([\s\S]*?)\]\)/), STRUGGLES);
  assert.deepEqual(quotedList(track, /const NUDGE_GROUPS = new Set\(\[([\s\S]*?)\]\)/), ['off', 'on']);
  assert.match(track, /const FIXED_LISTS[^=]*= \{\s+feature: FEATURES, outcome: OUTCOMES, step: STEPS, surface: SURFACES, via: VIAS,\s+hook: HOOKS, path: AI_PATHS, struggle: STRUGGLES, nudge_group: NUDGE_GROUPS,\s+cohort: COHORTS, screen: GATE_SCREENS,\s+speed: SPEEDS, gap: GAPS,\s+\}/);
  assert.deepEqual(quotedList(track, /const COHORTS = new Set\(\[([\s\S]*?)\]\)/), ['new', 'update']);
  assert.deepEqual(quotedList(track, /const GATE_SCREENS = new Set\(\[([\s\S]*?)\]\)/), ['choose', 'sign_in', 'unreachable', 'waiting']);
  assert.match(track, /ai_ready: new Set\(\['key', 'claude_code', 'none', 'publik'\]\)/, 'ai_ready path list');
  assert.match(track, /ai_source: new Set\(\['publik', 'own_key'\]\)/, 'ai_source path list');
  assert.match(track, /key === 'path' && !PATH_BY_NAME\[name\]\?\.has\(raw as string\)/, 'path is checked per event');
  assert.match(track, /update_installed: new Set\(\['oneclick', 'manual'\]\)/, 'update via list');
  assert.match(track, /app_open: new Set\(\['login', 'manual', 'relaunch'\]\)/, 'app_open via list');
  assert.match(track, /key === 'via' && !VIA_BY_NAME\[name\]\?\.has\(raw as string\)/, 'via is checked per event');
  assert.match(track, /const MAX_FROM_CHARS = 40/);
  assert.match(track, /if \(list && !\(typeof raw === 'string' && list\.has\(raw\)\)\) return null/, 'off-list value is a 400');
  assert.match(track, /key === 'from' && !\(typeof raw === 'string' && raw\.length <= MAX_FROM_CHARS\)/, 'from is a short string');
});

test('the fourth-edition rollup emits every contract row on completed days, founder excluded, service role only', () => {
  const rollup = fourth.slice(fourth.indexOf('create or replace function public.install_daily_metrics(since date)'), fourth.indexOf('-- 4. install_ledger'));
  for (const row of ROLLUP_ROWS) assert.ok(rollup.includes(`'${row}'`), `rollup emits ${row}`);
  assert.match(rollup, /'w' \|\| k\.k \|\| '_open'/, 'w1_open, w2_open, w3_open');
  assert.match(rollup, /\(iw\.week_start \+ 6 \+ 7 \* k\.k\) < current_date/, 'cohort rows only once their Sunday has completed');
  assert.match(rollup, /'feature:' \|\| \(e\.props->>'feature'\)/);
  assert.match(rollup, /'step:' \|\| \(e\.props->>'step'\)/);
  assert.match(rollup, /'step:' \|\| coalesce\(nullif\(e\.props->>'step', ''\), 'none'\)/, 'first_run_end names the last step');
  assert.match(rollup, /'outcome:' \|\| \(e\.props->>'outcome'\)/);
  assert.match(rollup, /percentile_cont\(0\.5\)/, 'first_run_end value is the median seconds');
  assert.match(rollup, /where e\.day < current_date/, 'completed days only');
  assert.match(rollup, /from public\.owner_installs/, 'owner installs excluded');
  assert.match(rollup, /\(props->>'dev'\) = 'true'/, 'dev installs excluded');
  assert.match(rollup, /abi\.action_id,\s+case when m\.action_id <> '' then 'probable:' \|\| m\.action_id end,\s+'source:' \|\| sbi\.source,\s+case when m\.tier = 'ambiguous' then 'ambiguous' end,\s+''/, 'action_id precedence');
  assert.match(rollup, /revoke all on function public\.install_daily_metrics\(date\) from public, anon, authenticated/);
});

test('install_ledger is salted, refuses to run unsalted, and is service role only', () => {
  const section = fourth.slice(fourth.indexOf('-- 4. install_ledger'));
  assert.match(section, /create or replace function public\.install_hash\(install_id uuid, salt text\)/);
  assert.match(section, /length\(salt\) < 16[\s\S]*?raise exception/, 'no salt, no hash');
  assert.match(section, /left\(encode\(sha256\(\(install_id::text \|\| salt\)::bytea\), 'hex'\), 16\)/);
  assert.match(section, /create or replace function public\.install_ledger\(since date default null, salt text default null\)/);
  assert.match(section, /public\.install_hash\(i\.install_id, salt\) as install_hash/);
  assert.match(section, /where e\.day < current_date/, 'completed days only');
  assert.match(section, /bool_or\(e\.day >= current_date - 14\) as opened_14d/, 'dormant window');
  assert.match(section, /filter \(where e\.day >= current_date - 7\)/, 'opens_7d window');
  assert.match(section, /where since is null or i\.install_day >= since/);
  for (const field of LEDGER_FIELDS) assert.match(section, new RegExp(`\\b${field}\\s`), `ledger returns ${field}`);
  assert.match(section, /revoke all on function public\.install_hash\(uuid, text\) from public, anon, authenticated/);
  assert.match(section, /revoke all on function public\.install_ledger\(date, text\) from public, anon, authenticated/);
});

test('the install-ledger function guards like daily-metrics and reshapes every field', () => {
  assert.match(config, /\[functions\.install-ledger\]\s+verify_jwt = false/);
  assert.match(ledger, /Deno\.env\.get\('METRICS_TOKEN'\)/);
  assert.match(ledger, /constantTimeEqual\(given, expected\)/);
  assert.match(ledger, /json\(\{ error: 'unauthorized' \}, 401\)/);
  assert.match(ledger, /Deno\.env\.get\('LEDGER_SALT'\)/);
  assert.match(ledger, /json\(\{ error: 'salt_missing' \}, 500\)/, 'never answers unsalted');
  assert.match(ledger, /rpc\('install_ledger', \{ since, salt \}\)/);
  assert.match(ledger, /if \(req\.method !== 'GET'\)/);
  for (const field of LEDGER_FIELDS_V6) assert.match(ledger, new RegExp(`^\\s+${field}: `, 'm'), `wire row carries ${field}`);
  assert.doesNotMatch(ledger, /\binstall_id:/, 'the wire row never carries a raw install id');
});

test('the fifth edition dedupes engaged per day and first_win / ai_ready per install, and track answers 204 on the repeat', () => {
  assert.match(fifth, /create unique index if not exists install_events_one_per_day\s+on public\.install_events \(install_id, name, day\)\s+where name in \('app_open', 'engaged'\)/);
  assert.match(fifth, /drop index if exists public\.install_events_one_open_per_day/);
  assert.ok(fifth.indexOf('install_events_one_per_day') < fifth.indexOf('drop index if exists public.install_events_one_open_per_day'), 'new index before the old one goes');
  assert.match(fifth, /create unique index if not exists install_events_once_per_install\s+on public\.install_events \(install_id, name\)\s+where name in \('first_win', 'ai_ready'\)/);
  assert.match(track, /const DAILY_UNIQUE = new Set\(\['app_open', 'engaged'\]\)/);
  assert.match(track, /const ONCE_PER_INSTALL = new Set\(\['first_win', 'ai_ready'\]\)/);
  assert.match(track, /error\.code === '23505' && \(DAILY_UNIQUE\.has\(name\) \|\| ONCE_PER_INSTALL\.has\(name\)\)\) return reply\(204\)/);
});

test('the fifth-edition rollup emits every 0.1.16 and amendment (d) row on completed days, founder excluded', () => {
  const rollup = fifth.slice(fifth.indexOf('create or replace function public.install_daily_metrics(since date)'), fifth.indexOf('-- 4. install_ledger'));
  for (const row of ROLLUP_ROWS_V5) assert.ok(rollup.includes(`'${row}'`), `rollup emits ${row}`);
  assert.match(rollup, /where e\.name in \('install', 'first_import', 'first_ask', 'first_win', 'signin', 'upgrade_click', 'checkout_started'\)/, 'first_win is in the install family');
  assert.match(rollup, /'hook:' \|\| coalesce\(nullif\(e\.props->>'hook', ''\), 'none'\)/);
  assert.match(rollup, /'path:' \|\| coalesce\(nullif\(e\.props->>'path', ''\), 'none'\)/);
  assert.match(rollup, /'via:' \|\| coalesce\(nullif\(e\.props->>'via', ''\), 'none'\)/, 'app_open_via');
  assert.match(rollup, /'via:' \|\| coalesce\(nullif\(e\.props->>'via', ''\), 'manual'\)/, 'update_installed via');
  assert.match(rollup, /when o\.day = i\.install_day \+ 1 then 'engaged_d1'/);
  assert.match(rollup, /where e\.day < current_date/, 'completed days only');
  assert.match(rollup, /from public\.owner_installs/, 'owner installs excluded');
  assert.match(rollup, /\(props->>'dev'\) = 'true'/, 'dev installs excluded');
  assert.match(rollup, /revoke all on function public\.install_daily_metrics\(date\) from public, anon, authenticated/);
});

test('the fifth-edition ledger drops and recreates install_ledger with the retention columns, salted, service role only', () => {
  const section = fifth.slice(fifth.indexOf('-- 4. install_ledger'));
  assert.match(section, /drop function if exists public\.install_ledger\(date, text\);\s/);
  assert.match(section, /create or replace function public\.install_ledger\(since date default null, salt text default null\)/);
  assert.match(section, /public\.install_hash\(i\.install_id, salt\) as install_hash/);
  assert.match(section, /where e\.day < current_date/, 'completed days only');
  assert.match(section, /from public\.owner_installs/, 'owner installs excluded');
  assert.match(section, /filter \(where e\.day >= i\.install_day and e\.day < i\.install_day \+ 7\)\)::integer as engaged_days_w1/);
  assert.match(section, /filter \(where e\.day >= current_date - 28\)\)::integer as engaged_days_28/);
  const returns = section.slice(section.indexOf('returns table ('), section.indexOf('language sql'));
  const columns = [...returns.matchAll(/^\s+([a-z_0-9]+)\s+[a-z]+,?$/gm)].map((m) => m[1]);
  assert.deepEqual(columns, LEDGER_FIELDS_V5, 'fourth-edition columns first, in order, then the new ones');
  assert.match(section, /revoke all on function public\.install_ledger\(date, text\) from public, anon, authenticated/);
});

test('the sixth edition adds the sign-in door: five names, no new dedupe, the rollup untouched, seven ledger columns', () => {
  assert.doesNotMatch(sixth, /create unique index/, 'the door rows may repeat; signin is once by the client flag');
  assert.doesNotMatch(sixth, /function public\.install_daily_metrics/, 'the rollup is not replaced');
  assert.match(sixth, /drop function if exists public\.install_ledger\(date, text\);\s/);
  const section = sixth.slice(sixth.indexOf('-- 2. install_ledger'));
  const returns = section.slice(section.indexOf('returns table ('), section.indexOf('language sql'));
  const columns = [...returns.matchAll(/^\s+([a-z_0-9]+)\s+[a-z]+,?$/gm)].map((m) => m[1]);
  assert.deepEqual(columns, LEDGER_FIELDS_V6, 'fifth-edition columns first, in order, then the sign-in ones');
  assert.match(section, /where e\.name = 'signin' and e\.props->>'method' = 'publik'/, 'only a publik sign-in counts');
  assert.match(section, /greatest\(0, floor\(extract\(epoch from \(si\.signin_at - i\.installed_at\)\) \/ 60\)\)::integer/, 'a late install row never makes a negative delay');
  assert.match(section, /where e\.day < current_date/, 'completed days only');
  assert.match(section, /from public\.owner_installs/, 'owner installs excluded');
  assert.match(section, /public\.install_hash\(i\.install_id, salt\) as install_hash/);
  assert.match(section, /revoke all on function public\.install_ledger\(date, text\) from public, anon, authenticated/);
  // Everything the fifth-edition ledger computed is still computed, word for word.
  const fifthFn = fifth.slice(fifth.indexOf('create or replace function public.install_ledger('), fifth.indexOf('revoke all on function public.install_ledger'));
  for (const line of fifthFn.split('\n').filter((x) => /engaged_days_w1|engaged_days_28|first_win_delay_min|opens_7d|install_click_matches/.test(x))) assert.ok(section.includes(line), 'kept: ' + line.trim().slice(0, 60));
});

test('the eighth edition: app_exit and its reasons, the dictation_news hook, nothing else changed', () => {
  const eighth = schema.slice(schema.lastIndexOf('-- Eighth edition (2026-11-24'));
  assert.ok(eighth.length > 0, 'the eighth edition is the last block');
  assert.match(eighth, /drop constraint %I/, 'every old check on name is dropped first');
  assert.doesNotMatch(eighth, /create (or replace )?function|drop function|create (unique )?index|alter table public\.install_events add column/i, 'names only');
  assert.match(track, /const EXIT_REASONS = new Set\(\['quit', 'shutdown', 'update', 'uninstall', 'exam', 'other'\]\);/);
  assert.match(track, /if \(key === 'reason' && name === 'app_exit' && !EXIT_REASONS\.has\(raw as string\)\) return null;/);
});

test('the tenth edition: ask_speed with its speed and gap bands, those two keys on ask_speed only, names only in SQL', () => {
  const tenth = schema.slice(schema.lastIndexOf('-- Tenth edition (2026-11-24'));
  assert.ok(tenth.length > 0 && schema.lastIndexOf('-- Tenth edition (2026-11-24') > schema.lastIndexOf('-- Eighth edition (2026-11-24'), 'the tenth edition is the last block');
  assert.match(tenth, /drop constraint %I/, 'every old check on name is dropped first');
  assert.doesNotMatch(tenth, /create (or replace )?function|drop function|create (unique )?index|alter table public\.install_events add column/i, 'names only');
  assert.deepEqual(quotedList(track, /const SPEEDS = new Set\(\[([\s\S]*?)\]\)/), ['2to4', '4to8', '8to15', 'over15', 'under2']);
  assert.deepEqual(quotedList(track, /const GAPS = new Set\(\[([\s\S]*?)\]\)/), ['5to30', 'first', 'over30', 'under5']);
  assert.match(track, /if \(\(key === 'speed' \|\| key === 'gap'\) && name !== 'ask_speed'\) return null;/);
  assert.doesNotMatch(track, /'ask_speed'[^\n]*DAILY_UNIQUE|DAILY_UNIQUE = new Set\(\[[^\]]*'ask_speed'/, 'many a day, capped by the client at 20');
});
