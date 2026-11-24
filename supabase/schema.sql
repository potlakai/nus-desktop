-- =============================================================================
-- Nus: identity and entitlement schema
-- =============================================================================
--
-- SCOPE. This holds who a user is and whether they pay. It deliberately holds
-- no user content: syllabi, courses, tasks, sources, chat, Companion
-- transcripts and audio all stay in the local SQLite file (src/db.js) and are
-- never uploaded. The landing page makes that promise in plain language, so
-- treat "no content column ever lands here" as a constraint, not a preference.
--
-- If a future developer builds real cross-device sync, it goes in NEW tables
-- alongside these. Do not widen these four. Every table is already keyed on
-- user_id with RLS, and `devices` exists so per-device sync state has an
-- anchor to hang off without redesigning identity first.
--
-- WRITE BOUNDARY. `subscriptions` is written by the Stripe webhook only, using
-- the service role key, which bypasses RLS. Clients get SELECT and nothing
-- else. A client that can write its own subscription row is a client that can
-- grant itself Pro.
--
-- Apply: paste into the Supabase SQL editor and run, or
--        supabase db execute --file supabase/schema.sql
-- Idempotent: safe to re-run.
-- =============================================================================


-- =============================================================================
-- Shared helpers
-- =============================================================================

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;


-- =============================================================================
-- profiles: one row per user, created automatically at signup
-- =============================================================================

create table if not exists public.profiles (
  user_id            uuid primary key references auth.users(id) on delete cascade,
  email              text,
  -- Which app build the account was created on. Useful for reading retention
  -- by cohort later without storing anything else about the person.
  first_seen_version text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "profiles: read own" on public.profiles;
create policy "profiles: read own"
  on public.profiles for select
  using (auth.uid() = user_id);

drop policy if exists "profiles: update own" on public.profiles;
create policy "profiles: update own"
  on public.profiles for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- No INSERT policy on purpose: rows are created by the signup trigger below,
-- never by a client.

drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch
  before update on public.profiles
  for each row execute function public.touch_updated_at();


-- =============================================================================
-- subscriptions: the entitlement record. Stripe webhook writes, client reads.
-- =============================================================================

create table if not exists public.subscriptions (
  user_id                uuid primary key references auth.users(id) on delete cascade,
  stripe_customer_id     text unique,
  stripe_subscription_id text unique,
  stripe_subscription_created_at timestamptz,

  -- Mirrors Stripe's subscription.status vocabulary, plus 'none' for a user
  -- who has never checked out. Anything not in the pro-granting set below is
  -- treated as free, so an unexpected value fails closed.
  status text not null default 'none'
    check (status in ('none','trialing','active','past_due','canceled',
                      'incomplete','incomplete_expired','unpaid','paused')),

  plan text not null default 'free'
    check (plan in ('free','pro')),

  current_period_end    timestamptz,
  cancel_at_period_end  boolean not null default false,
  updated_at            timestamptz not null default now()
);

alter table public.subscriptions
  add column if not exists stripe_subscription_created_at timestamptz;

alter table public.subscriptions enable row level security;

-- Read-only for the owner. No INSERT/UPDATE/DELETE policies exist, so the
-- anon and authenticated roles cannot write here at all. The webhook uses the
-- service role key and bypasses RLS.
drop policy if exists "subscriptions: read own" on public.subscriptions;
create policy "subscriptions: read own"
  on public.subscriptions for select
  using (auth.uid() = user_id);

drop trigger if exists subscriptions_touch on public.subscriptions;
create trigger subscriptions_touch
  before update on public.subscriptions
  for each row execute function public.touch_updated_at();

create index if not exists subscriptions_stripe_customer_idx
  on public.subscriptions (stripe_customer_id);


-- =============================================================================
-- devices: which machines an account runs on
-- =============================================================================
-- Not used for enforcement today. It exists so that seat limits, "sign out
-- everywhere", and per-device sync cursors have somewhere to live later
-- without a migration that touches identity.

create table if not exists public.devices (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  -- Stable per-install id generated by the app and kept in local preferences.
  device_id    text not null,
  os           text,
  app_version  text,
  last_seen    timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  unique (user_id, device_id)
);

alter table public.devices enable row level security;

drop policy if exists "devices: read own" on public.devices;
create policy "devices: read own"
  on public.devices for select
  using (auth.uid() = user_id);

drop policy if exists "devices: upsert own" on public.devices;
create policy "devices: upsert own"
  on public.devices for insert
  with check (auth.uid() = user_id);

drop policy if exists "devices: update own" on public.devices;
create policy "devices: update own"
  on public.devices for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);


-- =============================================================================
-- events: the funnel. Counters, not content.
-- =============================================================================
-- This is the whole reason identity is worth having: it answers "do 100 people
-- install, connect a key, and come back tomorrow", which no amount of free
-- downloads can tell you.
--
-- `name` is constrained to a closed list so a client cannot invent event names
-- and so the table stays queryable. `props` is for small dimensions only
-- (which limit was hit, which provider) and is size-capped. Never put user
-- content, prompt text, course names, or file names in it.
--
-- RETIRED as a write target in v0.2.7: the desktop app now sends anonymous
-- usage stats to `install_events` (bottom of this file) through the `track`
-- function, so anonymous installs count too. Nothing writes here any more; the
-- table and its rows stay for the dashboards that already read them.

create table if not exists public.events (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  name        text not null
    check (name in (
      'app_open',          -- retention: D1/D7 derive from this
      'signin',
      'key_connected',     -- BYO AI key accepted
      'first_import',      -- the "holy shit" moment
      'limit_hit',         -- props: {"unit":"syllabus_import"}
      'upgrade_click',
      'checkout_started',
      'companion_session'
    )),
  app_version text,
  -- Small dimensions only: {"unit":"syllabus_import"}, {"provider":"gemini"}.
  -- Object-ness is a CHECK because jsonb_typeof is plainly immutable; the size
  -- cap is a trigger below rather than a CHECK, because the obvious size
  -- functions are not immutable and Postgres is entitled to reject them there.
  props       jsonb not null default '{}'::jsonb
    check (jsonb_typeof(props) = 'object'),
  created_at  timestamptz not null default now()
);

-- Clients can insert their own events, so the payload needs a ceiling that does
-- not depend on the app behaving. 2 KB is far more than any legitimate event.
create or replace function public.check_event_props_size()
returns trigger
language plpgsql
as $$
begin
  if pg_column_size(new.props) > 2048 then
    raise exception 'events.props too large (% bytes, max 2048)', pg_column_size(new.props);
  end if;
  return new;
end;
$$;

drop trigger if exists events_props_size on public.events;
create trigger events_props_size
  before insert or update on public.events
  for each row execute function public.check_event_props_size();

alter table public.events enable row level security;

-- Insert-only, and only as yourself. Deliberately no SELECT policy: analytics
-- are read from the dashboard with the service role, not by clients.
drop policy if exists "events: insert own" on public.events;
create policy "events: insert own"
  on public.events for insert
  with check (auth.uid() = user_id);

create index if not exists events_name_created_idx on public.events (name, created_at desc);
create index if not exists events_user_created_idx on public.events (user_id, created_at desc);


-- =============================================================================
-- Signup trigger: every new user gets a profile and a free subscription row
-- =============================================================================
-- Giving everyone a row means the app never has to distinguish "no row" from
-- "free", and the entitlement function below has exactly one shape to return.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (user_id, email)
  values (new.id, new.email)
  on conflict (user_id) do nothing;

  insert into public.subscriptions (user_id, status, plan)
  values (new.id, 'none', 'free')
  on conflict (user_id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- =============================================================================
-- entitlement(): the single call the desktop app makes to learn its plan
-- =============================================================================
-- One round trip, one shape, and the pro-granting logic lives here rather than
-- in the client where it can be edited. The client still caches the result
-- (src/license.js) with an offline grace window, but this is the source of
-- truth it caches.
--
-- Fails closed: an unknown status, a missing row, or an expired period all
-- yield is_pro = false.

create or replace function public.entitlement()
returns table (
  plan                 text,
  status               text,
  is_pro               boolean,
  current_period_end   timestamptz,
  cancel_at_period_end boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select
    coalesce(s.plan, 'free')                                        as plan,
    coalesce(s.status, 'none')                                      as status,
    coalesce(
      s.status in ('active', 'trialing')
        and s.current_period_end is not null
        and s.current_period_end > now(),
      false
    )                                                               as is_pro,
    s.current_period_end,
    coalesce(s.cancel_at_period_end, false)                         as cancel_at_period_end
  from (select auth.uid() as uid) me
  left join public.subscriptions s on s.user_id = me.uid
  where me.uid is not null;
$$;

revoke all on function public.entitlement() from public, anon;
grant execute on function public.entitlement() to authenticated;


-- =============================================================================
-- Backfill, for anyone who signed up before the trigger existed
-- =============================================================================

insert into public.profiles (user_id, email)
select u.id, u.email from auth.users u
on conflict (user_id) do nothing;

insert into public.subscriptions (user_id, status, plan)
select u.id, 'none', 'free' from auth.users u
on conflict (user_id) do nothing;


-- =============================================================================
-- install_events: anonymous usage stats (ADDITIVE, 2026-10-05)
-- =============================================================================
-- Everything in this section is additive and idempotent: it creates new
-- objects only and never alters the tables above, so it is safe to paste into
-- the live project's SQL editor on its own.
--
-- Contract: TELEMETRY-CONTRACT.md, kept with the growth notes.
-- Change the contract first, then this file, then the `track` function.
--
-- One row per event, keyed on a random per-install UUID that the client makes
-- on first launch and never ties to an account. Counters, not content: `props`
-- is a flat object of allowed keys (campaign labels, which feature, which
-- provider, minutes) and is capped at 1 KB by the trigger below. Coursework and
-- anything the user types never land here.
--
-- WRITE BOUNDARY. RLS is on and there are NO policies, so the anon and
-- authenticated roles can neither read nor write. The only writer is the
-- `track` Edge Function and the only reader is `daily-metrics`, both using the
-- service role key, which bypasses RLS.

create table if not exists public.install_events (
  id          bigint generated always as identity primary key,
  install_id  uuid not null,
  product     text not null
    check (product in ('desktop', 'companion')),
  name        text not null
    check (name in (
      'install',            -- first launch ever on this install id
      'app_open',           -- once per process start and once per day in the tray
      'source_answer',      -- props.source: where they heard about Nus
      'first_import',       -- first confirmed syllabus import (desktop)
      'import',             -- later confirmed imports (desktop)
      'first_ask',          -- first question or voice command answered
      'ask',                -- later asks; props.mode: voice | text | guide
      'key_connected',      -- props.provider
      'companion_session',  -- props.minutes (integer)
      'signin',             -- props.method: google | email
      'limit_hit',          -- props.unit
      'upgrade_click',      -- props.reason
      'checkout_started',
      'stats_off',          -- the user turned stats off; last event from that install
      -- Amendment (c), 2026-10-17. The live table got these through the ALTER
      -- in the fourth edition at the end of this file; a fresh database gets
      -- them here.
      'feature_session',    -- a long-running mode ended; props.feature, props.seconds
      'app_session',        -- the active-minute counter flushed; props.minutes
      'onboarding_step',    -- a first-run step reached; props.step
      'first_run_end',      -- quit before any first_ask; props.step, props.seconds
      'crash',              -- count only
      'update_installed',   -- props.from = previous version, props.via
      -- Amendment (d), 2026-11-04.
      'update_offered',     -- props.surface
      'notice_shown',       -- props.notice
      'notice_clicked',     -- props.notice
      -- Fifth edition, 2026-11-06: Companion 0.1.16 retention.
      'first_win',          -- props.feature; once per install
      'engaged',            -- once per install per UTC day
      'ai_ready',           -- props.path; once per install
      'hook_shown',         -- props.hook
      'hook_used',          -- props.hook
      -- Sixth edition, 2026-11-11: the sign-in door (amendment f).
      'signin_shown',       -- props.cohort
      'signin_clicked',
      'signin_closed',      -- props.screen, props.seconds
      'signin_unreachable',
      'ai_source',          -- props.path
      -- Eighth edition, 2026-11-24: how a run ended (Companion 0.1.38).
      'app_exit',           -- props.reason
      -- Tenth edition, 2026-11-24: how long an answered ask took (Companion 0.1.40).
      'ask_speed'           -- props.feature, props.speed, props.gap
    )),
  app_version text,
  platform    text,
  props       jsonb not null default '{}'::jsonb
    check (jsonb_typeof(props) = 'object'),
  -- The UTC day the event landed on. Stored, not computed, so the dedupe index
  -- below and every daily rollup read the same value.
  day         date not null default (now() at time zone 'utc')::date,
  created_at  timestamptz not null default now()
);

-- 1 KB props ceiling. A trigger rather than a CHECK for the same reason as
-- events_props_size: the size functions are not immutable.
create or replace function public.check_install_event_props_size()
returns trigger
language plpgsql
as $$
begin
  if pg_column_size(new.props) > 1024 then
    raise exception 'install_events.props too large (% bytes, max 1024)', pg_column_size(new.props);
  end if;
  return new;
end;
$$;

drop trigger if exists install_events_props_size on public.install_events;
create trigger install_events_props_size
  before insert or update on public.install_events
  for each row execute function public.check_install_event_props_size();

-- RLS on, no policies: service role only.
alter table public.install_events enable row level security;

-- One app_open per install per UTC day. The `track` function treats the
-- unique violation on a second open as "do nothing" and still answers 204
-- (PostgREST cannot write the `on conflict ... where` a partial index needs).
create unique index if not exists install_events_one_open_per_day
  on public.install_events (install_id, name, day)
  where name in ('app_open');

create index if not exists install_events_name_day_idx
  on public.install_events (name, day);
create index if not exists install_events_install_day_idx
  on public.install_events (install_id, day);


-- =============================================================================
-- install_daily_metrics(since): the rollup the `daily-metrics` function returns
-- =============================================================================
-- Completed UTC days only (day < current_date), so a day is never pulled twice
-- with different numbers. Row shape matches growth_os/metrics_pull.py exactly:
-- (day, product, action_id, event_name, event_count, value).
--
--   install, first_import, first_ask, signin, upgrade_click, checkout_started:
--     count per day, product and action_id, where action_id is
--     coalesce(props.acq_action_id, 'source:' || <that install's source_answer>, '').
--   app_open:   distinct installs with an app_open that day.
--   d1_open:    installs whose install day is day - 1 with an app_open on day.
--   d7_open:    same with day - 7.
--   paid:       subscriptions whose Stripe subscription was created that day
--               (product 'desktop', action_id '').
--
-- Service role only: anon and authenticated cannot execute it.

create or replace function public.install_daily_metrics(since date)
returns table (
  day         date,
  product     text,
  action_id   text,
  event_name  text,
  event_count bigint,
  value       numeric
)
language sql
stable
security definer
set search_path = public
as $$
  with source_by_install as (
    select distinct on (install_id) install_id, props->>'source' as source
    from public.install_events
    where name = 'source_answer' and props ? 'source'
    order by install_id, created_at
  ),
  counted as (
    select
      e.day,
      e.product,
      coalesce(e.props->>'acq_action_id', 'source:' || sbi.source, '') as action_id,
      e.name as event_name,
      count(*)::bigint as event_count
    from public.install_events e
    left join source_by_install sbi on sbi.install_id = e.install_id
    where e.name in ('install', 'first_import', 'first_ask', 'signin', 'upgrade_click', 'checkout_started')
      and e.day >= since
      and e.day < current_date
    group by 1, 2, 3, 4
  ),
  opens as (
    select day, product, '' as action_id, 'app_open' as event_name, count(distinct install_id)::bigint as event_count
    from public.install_events
    where name = 'app_open' and day >= since and day < current_date
    group by 1, 2
  ),
  installs as (
    select install_id, min(day) as install_day
    from public.install_events
    where name = 'install'
    group by 1
  ),
  retention as (
    select
      o.day,
      o.product,
      '' as action_id,
      case when o.day = i.install_day + 1 then 'd1_open' else 'd7_open' end as event_name,
      count(distinct o.install_id)::bigint as event_count
    from public.install_events o
    join installs i on i.install_id = o.install_id
    where o.name = 'app_open'
      and o.day >= since
      and o.day < current_date
      and (o.day = i.install_day + 1 or o.day = i.install_day + 7)
    group by 1, 2, 3, 4
  ),
  paid as (
    select
      (sub.stripe_subscription_created_at at time zone 'utc')::date as day,
      'desktop' as product,
      '' as action_id,
      'paid' as event_name,
      count(*)::bigint as event_count
    from public.subscriptions sub
    where sub.stripe_subscription_created_at is not null
      and (sub.stripe_subscription_created_at at time zone 'utc')::date >= since
      and (sub.stripe_subscription_created_at at time zone 'utc')::date < current_date
    group by 1
  ),
  everything as (
    select * from counted
    union all select * from opens
    union all select * from retention
    union all select * from paid
  )
  select day, product, action_id, event_name, event_count, null::numeric as value
  from everything
  order by day, product, event_name, action_id;
$$;

revoke all on function public.install_daily_metrics(date) from public, anon, authenticated;


-- =============================================================================
-- download_clicks + install_click_matches: the click-to-install bridge
-- (ADDITIVE, 2026-10-15)
-- =============================================================================
-- Additive and idempotent like the install_events section: paste this section
-- on its own into the live project's SQL editor. It creates one table and one
-- function and REPLACES install_daily_metrics (same signature, same row shape;
-- the Growth OS puller does not change).
--
-- The site beacons every download-button click to the `click` Edge Function
-- (supabase/functions/click), which stores WHAT was clicked, not WHO: the file
-- key, the campaign labels the page had stored (attrib.js, first touch), a
-- coarse device family, and a server timestamp. No IP, no user agent string,
-- no cookie, no id that could join to a person. The app's first launch then
-- sends `install` with its own server timestamp, and install_click_matches()
-- joins the two by product and time. That join is PROBABILISTIC and is labelled
-- `probable:<action_id>` on the wire so the Growth OS never shows it as a
-- receipt. A setup code (props.acq_action_id) is the deterministic path and
-- always wins.

create table if not exists public.download_clicks (
  id           uuid primary key default gen_random_uuid(),
  product      text not null check (product in ('desktop', 'companion')),
  file_key     text not null,                    -- desktop-setup, companion-setup, ...
  action_id    text not null default '',         -- act-YYYYMMDD-xxxxxxx or ''
  utm_source   text not null default '',
  utm_medium   text not null default '',
  utm_campaign text not null default '',
  device       text not null default 'other'
    check (device in ('windows', 'mac', 'iphone', 'android', 'other')),
  day          date not null default (now() at time zone 'utc')::date,
  created_at   timestamptz not null default now()
);

-- RLS on, no policies: the `click` function writes and the rollup reads, both
-- with the service role.
alter table public.download_clicks enable row level security;

create index if not exists download_clicks_product_created_idx
  on public.download_clicks (product, created_at);
create index if not exists download_clicks_day_idx
  on public.download_clicks (day);

-- One row per install id (its first `install` event) with the click it most
-- likely came from. Mirrors growth_os/bridge.py::match_installs exactly; the
-- Python is the readable spec and the unit tests, this is what runs.
--
--   candidates: clicks of the same product, with a campaign, logged in the 72 h
--               before the install and not after it. No platform filter: a
--               phone click on an Instagram link followed by a PC install two
--               days later is the case this exists for.
--   nearest:    the latest candidate.
--   tier same-device-hour:    the nearest click's device family matches the
--               install's platform (windows/win32, mac/darwin) and is within
--               60 minutes. Enough even when other campaigns were clicked.
--   tier single-campaign-72h: every candidate carries one action id.
--   ambiguous:  two or more campaigns and no same-device-hour click. Not
--               attributed; the rollup labels the install `ambiguous`.
--   click-claimed: one click is claimed by at most one install (the earliest).
create or replace function public.install_click_matches()
returns table (
  install_id   uuid,
  product      text,
  installed_at timestamptz,
  action_id    text,
  utm_campaign text,
  click_id     uuid,
  lag_minutes  numeric,
  candidates   integer,
  campaigns    integer,
  tier         text
)
language sql
stable
security definer
set search_path = public
as $$
  with installs as (
    select distinct on (e.install_id) e.install_id, e.product, e.platform, e.created_at
    from public.install_events e
    where e.name = 'install'
    order by e.install_id, e.created_at
  ),
  cands as (
    select i.install_id, i.product, i.platform, i.created_at as installed_at,
           c.id as click_id, c.action_id, c.utm_campaign, c.device, c.created_at as clicked_at,
           round((extract(epoch from (i.created_at - c.created_at)) / 60.0)::numeric, 1) as lag_minutes
    from installs i
    join public.download_clicks c
      on c.product = i.product
     and c.action_id <> ''
     and c.created_at <= i.created_at
     and c.created_at >= i.created_at - interval '72 hours'
  ),
  per_install as (
    select install_id, count(*)::integer as candidates, count(distinct action_id)::integer as campaigns
    from cands
    group by install_id
  ),
  nearest as (
    select c.*, p.candidates, p.campaigns,
           case
             when c.lag_minutes <= 60
              and c.device = case c.platform when 'win32' then 'windows' when 'darwin' then 'mac' else '' end
               then 'same-device-hour'
             when p.campaigns = 1 then 'single-campaign-72h'
             else 'ambiguous'
           end as tier
    from (
      select *, row_number() over (partition by install_id order by clicked_at desc) as rn
      from cands
    ) c
    join per_install p on p.install_id = c.install_id
    where c.rn = 1
  ),
  claimed as (
    select install_id, row_number() over (partition by click_id order by installed_at) as claim_rank
    from nearest
    where tier <> 'ambiguous'
  )
  select
    n.install_id,
    n.product,
    n.installed_at,
    case when cl.claim_rank = 1 then n.action_id else '' end as action_id,
    case when cl.claim_rank = 1 then n.utm_campaign else '' end as utm_campaign,
    case when cl.claim_rank = 1 then n.click_id end as click_id,
    n.lag_minutes,
    n.candidates,
    n.campaigns,
    case
      when n.tier = 'ambiguous' then 'ambiguous'
      when cl.claim_rank = 1 then n.tier
      else 'click-claimed'
    end as tier
  from nearest n
  left join claimed cl on cl.install_id = n.install_id;
$$;

revoke all on function public.install_click_matches() from public, anon, authenticated;

-- owner_installs: the founder's own install ids (2026-10-15 b). The client
-- flag props.dev = true covers installs made after the flag shipped; this
-- table covers the ones before it. Paste the value of install_id.txt from each
-- of the founder's machines:  insert into public.owner_installs values ('<uuid>');
-- Service role only, like everything else here.
create table if not exists public.owner_installs (
  install_id uuid primary key,
  note       text,
  added_at   timestamptz not null default now()
);
alter table public.owner_installs enable row level security;

-- install_daily_metrics, third edition (2026-10-15 b). Same signature and row
-- shape as the two editions above. On top of the second edition:
--   4. every row excludes the founder's installs: ids in owner_installs and
--      ids that ever sent props.dev = true;
--   5. companion_session rows per day, product and action id: event_count =
--      sessions, value = total active minutes (the only rows with a value).
-- Precedence of action_id for install-family rows is unchanged:
-- setup code > probable match > source answer > ambiguous > ''.
create or replace function public.install_daily_metrics(since date)
returns table (
  day         date,
  product     text,
  action_id   text,
  event_name  text,
  event_count bigint,
  value       numeric
)
language sql
stable
security definer
set search_path = public
as $$
  with excluded as (
    select install_id from public.owner_installs
    union
    select distinct install_id from public.install_events where (props->>'dev') = 'true'
  ),
  ev as (
    select e.*
    from public.install_events e
    where not exists (select 1 from excluded x where x.install_id = e.install_id)
  ),
  source_by_install as (
    select distinct on (install_id) install_id, props->>'source' as source
    from ev
    where name = 'source_answer' and props ? 'source'
    order by install_id, created_at
  ),
  acq_by_install as (
    select distinct on (install_id) install_id, props->>'acq_action_id' as action_id
    from ev
    where props ? 'acq_action_id' and coalesce(props->>'acq_action_id', '') <> ''
    order by install_id, created_at
  ),
  matches as (
    select m.install_id, m.action_id, m.tier
    from public.install_click_matches() m
  ),
  labelled as (
    select
      e.install_id,
      coalesce(
        abi.action_id,
        case when m.action_id <> '' then 'probable:' || m.action_id end,
        'source:' || sbi.source,
        case when m.tier = 'ambiguous' then 'ambiguous' end,
        ''
      ) as action_id
    from (select distinct install_id from ev) e
    left join acq_by_install abi on abi.install_id = e.install_id
    left join matches m on m.install_id = e.install_id
    left join source_by_install sbi on sbi.install_id = e.install_id
  ),
  counted as (
    select e.day, e.product, l.action_id, e.name as event_name,
           count(*)::bigint as event_count, null::numeric as value
    from ev e
    join labelled l on l.install_id = e.install_id
    where e.name in ('install', 'first_import', 'first_ask', 'signin', 'upgrade_click', 'checkout_started')
      and e.day >= since
      and e.day < current_date
    group by 1, 2, 3, 4
  ),
  sessions as (
    select e.day, e.product, l.action_id, 'companion_session' as event_name,
           count(*)::bigint as event_count,
           sum(coalesce((e.props->>'minutes')::numeric, 0)) as value
    from ev e
    join labelled l on l.install_id = e.install_id
    where e.name = 'companion_session'
      and e.day >= since
      and e.day < current_date
    group by 1, 2, 3, 4
  ),
  beacons as (
    select day, product, action_id, 'download_beacon' as event_name,
           count(*)::bigint as event_count, null::numeric as value
    from public.download_clicks
    where day >= since and day < current_date
    group by 1, 2, 3
  ),
  opens as (
    select day, product, '' as action_id, 'app_open' as event_name,
           count(distinct install_id)::bigint as event_count, null::numeric as value
    from ev
    where name = 'app_open' and day >= since and day < current_date
    group by 1, 2
  ),
  installs as (
    select install_id, min(day) as install_day
    from ev
    where name = 'install'
    group by 1
  ),
  retention as (
    select
      o.day,
      o.product,
      '' as action_id,
      case when o.day = i.install_day + 1 then 'd1_open' else 'd7_open' end as event_name,
      count(distinct o.install_id)::bigint as event_count,
      null::numeric as value
    from ev o
    join installs i on i.install_id = o.install_id
    where o.name = 'app_open'
      and o.day >= since
      and o.day < current_date
      and (o.day = i.install_day + 1 or o.day = i.install_day + 7)
    group by 1, 2, 3, 4
  ),
  paid as (
    select
      (sub.stripe_subscription_created_at at time zone 'utc')::date as day,
      'desktop' as product,
      '' as action_id,
      'paid' as event_name,
      count(*)::bigint as event_count,
      null::numeric as value
    from public.subscriptions sub
    where sub.stripe_subscription_created_at is not null
      and (sub.stripe_subscription_created_at at time zone 'utc')::date >= since
      and (sub.stripe_subscription_created_at at time zone 'utc')::date < current_date
    group by 1
  ),
  everything as (
    select * from counted
    union all select * from sessions
    union all select * from beacons
    union all select * from opens
    union all select * from retention
    union all select * from paid
  )
  select day, product, action_id, event_name, event_count, value
  from everything
  order by day, product, event_name, action_id;
$$;

revoke all on function public.install_daily_metrics(date) from public, anon, authenticated;


-- =============================================================================
-- Fourth edition (2026-10-17, TELEMETRY-CONTRACT.md amendment c): feature
-- time, first-run leaks, the install ledger
-- =============================================================================
-- Paste THIS block (from here to the end of the file) on its own into the
-- live project's SQL editor. Re-runnable: every statement drops or replaces
-- what it creates. It
--   1. widens the install_events name check to the six new names (an ALTER,
--      so it runs on the live table; the CREATE TABLE above lists them too
--      for a fresh database),
--   2. adds install_prop_num(), a null-safe reader for numeric props,
--   3. REPLACES install_daily_metrics(since) in place: the third edition above
--      plus the weekly cohort rows (w1_open, w2_open, w3_open, from
--      growth-os/sql/install_daily_metrics_cohorts.sql, which was never merged
--      here) plus the amendment (c) rows (feature_ask, feature_minutes,
--      app_session, onboarding_step, first_run_end, ask_outcome, crash,
--      update_installed),
--   4. adds install_hash() and install_ledger(since, salt): one hashed summary
--      row per install.
-- Same row shape on the wire; the daily-metrics function is unchanged.

-- 1. Event names. The inline check in the CREATE TABLE was auto-named
-- install_events_name_check; drop every check on `name` whatever its name,
-- then add the full list back under that name.
do $$
declare c record;
begin
  for c in
    select conname
    from pg_constraint
    where conrelid = 'public.install_events'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%(name = ANY%'
  loop
    execute format('alter table public.install_events drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.install_events add constraint install_events_name_check
  check (name in (
    'install', 'app_open', 'source_answer', 'first_import', 'import', 'first_ask', 'ask',
    'key_connected', 'companion_session', 'signin', 'limit_hit', 'upgrade_click',
    'checkout_started', 'stats_off',
    'feature_session',    -- a long-running mode ended; props.feature, props.seconds
    'app_session',        -- the active-minute counter flushed; props.minutes
    'onboarding_step',    -- a first-run step reached; props.step
    'first_run_end',      -- quit before any first_ask; props.step, props.seconds
    'crash',              -- count only
    'update_installed',   -- props.from = previous version, props.via
    -- Amendment (d), 2026-11-04.
    'update_offered',     -- props.surface
    'notice_shown',       -- props.notice
    'notice_clicked'      -- props.notice
  ));

-- 2. props numbers. `track` accepts any scalar under an allowed key, so a
-- client bug could store minutes as a string; a bare ::numeric cast would then
-- fail the whole rollup. Null unless the stored value is a JSON number.
create or replace function public.install_prop_num(props jsonb, key text)
returns numeric
language sql
immutable
as $$
  select case when jsonb_typeof(props -> key) = 'number' then (props ->> key)::numeric end;
$$;

-- 3. install_daily_metrics, fourth edition. Same signature and row shape as
-- the three editions above. Contents, all on completed UTC days only and all
-- excluding owner_installs and installs that ever sent props.dev = true:
--   install family (install, first_import, first_ask, signin, upgrade_click,
--     checkout_started) by action_id with the precedence setup code >
--     probable:<match> > source:<answer> > ambiguous > '';
--   companion_session   desktop voice captures: count, value = minutes;
--   app_session         active-minute flushes: count, value = minutes;
--   feature_ask         ask + first_ask by props.feature, action_id
--                       'feature:<f>', value = asks whose outcome is not ok;
--   feature_minutes     feature_session by feature, action_id 'feature:<f>',
--                       count = sessions, value = seconds summed, in minutes;
--   onboarding_step     installs reaching each step, action_id 'step:<s>';
--   first_run_end       installs that quit before a first ask, action_id
--                       'step:<last step>' ('step:none' if no step was sent),
--                       value = median seconds since first launch;
--   ask_outcome         asks by props.outcome, action_id 'outcome:<o>';
--   crash               count;
--   update_installed    counts, action_id 'via:<oneclick|manual>' (no via = manual);
--   update_offered      counts, action_id 'surface:<bubble|card>';
--   notice_shown, notice_clicked   counts, action_id 'notice:<id>';
--   download_beacon     server-logged download clicks by action_id;
--   app_open            distinct installs opening that day;
--   d1_open, d7_open    opens on install day + 1 / + 7;
--   w1_open, w2_open, w3_open   installs of week W (Monday to Sunday) with an
--                       app_open in week W+k, dated the Sunday closing W+k and
--                       emitted only once that Sunday has completed;
--   paid                subscriptions created that day.
create or replace function public.install_daily_metrics(since date)
returns table (
  day         date,
  product     text,
  action_id   text,
  event_name  text,
  event_count bigint,
  value       numeric
)
language sql
stable
security definer
set search_path = public
as $$
  with excluded as (
    select install_id from public.owner_installs
    union
    select distinct install_id from public.install_events where (props->>'dev') = 'true'
  ),
  -- Every row below reads from ev: completed days only, founder removed.
  ev as (
    select e.*
    from public.install_events e
    where e.day < current_date
      and not exists (select 1 from excluded x where x.install_id = e.install_id)
  ),
  source_by_install as (
    select distinct on (install_id) install_id, props->>'source' as source
    from ev
    where name = 'source_answer' and props ? 'source'
    order by install_id, created_at
  ),
  acq_by_install as (
    select distinct on (install_id) install_id, props->>'acq_action_id' as action_id
    from ev
    where props ? 'acq_action_id' and coalesce(props->>'acq_action_id', '') <> ''
    order by install_id, created_at
  ),
  matches as (
    select m.install_id, m.action_id, m.tier
    from public.install_click_matches() m
  ),
  labelled as (
    select
      e.install_id,
      coalesce(
        abi.action_id,
        case when m.action_id <> '' then 'probable:' || m.action_id end,
        'source:' || sbi.source,
        case when m.tier = 'ambiguous' then 'ambiguous' end,
        ''
      ) as action_id
    from (select distinct install_id from ev) e
    left join acq_by_install abi on abi.install_id = e.install_id
    left join matches m on m.install_id = e.install_id
    left join source_by_install sbi on sbi.install_id = e.install_id
  ),
  -- The asked window. Install-day lookups (retention, cohorts) read ev
  -- instead, because the install may predate `since`.
  win as (
    select * from ev where day >= since
  ),
  counted as (
    select e.day, e.product, l.action_id, e.name as event_name,
           count(*)::bigint as event_count, null::numeric as value
    from win e
    join labelled l on l.install_id = e.install_id
    where e.name in ('install', 'first_import', 'first_ask', 'signin', 'upgrade_click', 'checkout_started')
    group by 1, 2, 3, 4
  ),
  -- companion_session (desktop voice captures) and app_session (active
  -- minutes) share one shape: count = sessions, value = minutes.
  sessions as (
    select e.day, e.product, l.action_id, e.name as event_name,
           count(*)::bigint as event_count,
           sum(coalesce(public.install_prop_num(e.props, 'minutes'), 0)) as value
    from win e
    join labelled l on l.install_id = e.install_id
    where e.name in ('companion_session', 'app_session')
    group by 1, 2, 3, 4
  ),
  feature_asks as (
    select e.day, e.product, 'feature:' || (e.props->>'feature') as action_id,
           'feature_ask' as event_name,
           count(*)::bigint as event_count,
           (count(*) filter (where e.props ? 'outcome' and e.props->>'outcome' <> 'ok'))::numeric as value
    from win e
    where e.name in ('ask', 'first_ask')
      and coalesce(e.props->>'feature', '') <> ''
    group by 1, 2, 3, 4
  ),
  feature_minutes as (
    select e.day, e.product, 'feature:' || (e.props->>'feature') as action_id,
           'feature_minutes' as event_name,
           count(*)::bigint as event_count,
           round(sum(coalesce(public.install_prop_num(e.props, 'seconds'), 0)) / 60.0, 1) as value
    from win e
    where e.name = 'feature_session'
      and coalesce(e.props->>'feature', '') <> ''
    group by 1, 2, 3, 4
  ),
  steps as (
    select e.day, e.product, 'step:' || (e.props->>'step') as action_id,
           'onboarding_step' as event_name,
           count(distinct e.install_id)::bigint as event_count,
           null::numeric as value
    from win e
    where e.name = 'onboarding_step'
      and coalesce(e.props->>'step', '') <> ''
    group by 1, 2, 3, 4
  ),
  first_run_ends as (
    select e.day, e.product,
           'step:' || coalesce(nullif(e.props->>'step', ''), 'none') as action_id,
           'first_run_end' as event_name,
           count(distinct e.install_id)::bigint as event_count,
           round((percentile_cont(0.5) within group (order by public.install_prop_num(e.props, 'seconds'))
             filter (where public.install_prop_num(e.props, 'seconds') is not null))::numeric, 0) as value
    from win e
    where e.name = 'first_run_end'
    group by 1, 2, 3, 4
  ),
  ask_outcomes as (
    select e.day, e.product, 'outcome:' || (e.props->>'outcome') as action_id,
           'ask_outcome' as event_name,
           count(*)::bigint as event_count,
           null::numeric as value
    from win e
    where e.name in ('ask', 'first_ask')
      and coalesce(e.props->>'outcome', '') <> ''
    group by 1, 2, 3, 4
  ),
  plain_counts as (
    select e.day, e.product, '' as action_id, e.name as event_name,
           count(*)::bigint as event_count, null::numeric as value
    from win e
    where e.name = 'crash'
    group by 1, 2, 3, 4
    union all
    select e.day, e.product,
           case e.name
             when 'update_installed' then 'via:' || coalesce(nullif(e.props->>'via', ''), 'manual')
             when 'update_offered' then 'surface:' || coalesce(nullif(e.props->>'surface', ''), 'none')
             else 'notice:' || coalesce(nullif(e.props->>'notice', ''), 'none')
           end as action_id,
           e.name as event_name,
           count(*)::bigint as event_count, null::numeric as value
    from win e
    where e.name in ('update_installed', 'update_offered', 'notice_shown', 'notice_clicked')
    group by 1, 2, 3, 4
  ),
  beacons as (
    select day, product, action_id, 'download_beacon' as event_name,
           count(*)::bigint as event_count, null::numeric as value
    from public.download_clicks
    where day >= since and day < current_date
    group by 1, 2, 3
  ),
  opens as (
    select day, product, '' as action_id, 'app_open' as event_name,
           count(distinct install_id)::bigint as event_count, null::numeric as value
    from win
    where name = 'app_open'
    group by 1, 2
  ),
  installs as (
    select install_id, min(product) as product, min(day) as install_day
    from ev
    where name = 'install'
    group by 1
  ),
  retention as (
    select
      o.day,
      o.product,
      '' as action_id,
      case when o.day = i.install_day + 1 then 'd1_open' else 'd7_open' end as event_name,
      count(distinct o.install_id)::bigint as event_count,
      null::numeric as value
    from win o
    join installs i on i.install_id = o.install_id
    where o.name = 'app_open'
      and (o.day = i.install_day + 1 or o.day = i.install_day + 7)
    group by 1, 2, 3, 4
  ),
  -- Weekly install cohorts. Postgres weeks start on Monday, so
  -- date_trunc('week') is the Monday of the install week.
  install_weeks as (
    select
      i.install_id,
      i.product,
      date_trunc('week', i.install_day::timestamp)::date as week_start
    from installs i
  ),
  cohorts as (
    select
      (iw.week_start + 6 + 7 * k.k) as day,
      iw.product,
      '' as action_id,
      'w' || k.k || '_open' as event_name,
      count(distinct iw.install_id)::bigint as event_count,
      null::numeric as value
    from install_weeks iw
    cross join (values (1), (2), (3)) as k(k)
    join ev o
      on o.install_id = iw.install_id
     and o.name = 'app_open'
     and o.day >= iw.week_start + 7 * k.k
     and o.day <  iw.week_start + 7 * (k.k + 1)
    where (iw.week_start + 6 + 7 * k.k) >= since
      and (iw.week_start + 6 + 7 * k.k) < current_date
    group by 1, 2, 3, 4
  ),
  paid as (
    select
      (sub.stripe_subscription_created_at at time zone 'utc')::date as day,
      'desktop' as product,
      '' as action_id,
      'paid' as event_name,
      count(*)::bigint as event_count,
      null::numeric as value
    from public.subscriptions sub
    where sub.stripe_subscription_created_at is not null
      and (sub.stripe_subscription_created_at at time zone 'utc')::date >= since
      and (sub.stripe_subscription_created_at at time zone 'utc')::date < current_date
    group by 1
  ),
  everything as (
    select day, product, action_id, event_name, event_count, value from counted
    union all select day, product, action_id, event_name, event_count, value from sessions
    union all select day, product, action_id, event_name, event_count, value from feature_asks
    union all select day, product, action_id, event_name, event_count, value from feature_minutes
    union all select day, product, action_id, event_name, event_count, value from steps
    union all select day, product, action_id, event_name, event_count, value from first_run_ends
    union all select day, product, action_id, event_name, event_count, value from ask_outcomes
    union all select day, product, action_id, event_name, event_count, value from plain_counts
    union all select day, product, action_id, event_name, event_count, value from beacons
    union all select day, product, action_id, event_name, event_count, value from opens
    union all select day, product, action_id, event_name, event_count, value from retention
    union all select day, product, action_id, event_name, event_count, value from cohorts
    union all select day, product, action_id, event_name, event_count, value from paid
  )
  select day, product, action_id, event_name, event_count, value
  from everything
  order by day, product, event_name, action_id;
$$;

revoke all on function public.install_daily_metrics(date) from public, anon, authenticated;

-- 4. install_ledger(since, salt): one summary row per install for the Growth
-- OS (the `install-ledger` Edge Function). The install id itself never leaves:
-- install_hash is the first 16 hex of sha256(install_id || salt), and the salt
-- is a function secret (LEDGER_SALT) that the Edge Function passes in per
-- call. It is not stored in SQL, and install_hash() refuses a missing or
-- short salt, so the ledger cannot run unsalted.
-- Completed UTC days only, owner and dev installs excluded, one row per
-- install id that sent `install` (on or after `since` when given).
--   days_opened          distinct app_open days
--   opens_7d             of the last 7 completed days
--   asks_total / asks_by_feature / asks_failed   ask + first_ask rows
--   minutes_total        sum of app_session.minutes
--   minutes_by_feature   feature_session seconds per feature, in whole minutes
--   first_ask_delay_min  install row to first_ask row, null if none
--   last_step            the latest onboarding_step, null if none
--   source               the source_answer, null if none
--   action_id            same precedence as the install-family rows
--   app_version          the version on the latest event
--   crashes              crash rows
--   dormant              no app_open in the last 14 completed days
create or replace function public.install_hash(install_id uuid, salt text)
returns text
language plpgsql
immutable
as $$
begin
  if salt is null or length(salt) < 16 then
    raise exception 'install_hash: LEDGER_SALT missing or shorter than 16 characters';
  end if;
  return left(encode(sha256((install_id::text || salt)::bytea), 'hex'), 16);
end;
$$;

revoke all on function public.install_hash(uuid, text) from public, anon, authenticated;

create or replace function public.install_ledger(since date default null, salt text default null)
returns table (
  install_hash        text,
  product             text,
  install_day         date,
  last_open_day       date,
  days_opened         integer,
  opens_7d            integer,
  asks_total          integer,
  asks_by_feature     jsonb,
  asks_failed         integer,
  minutes_total       numeric,
  minutes_by_feature  jsonb,
  first_ask_delay_min integer,
  last_step           text,
  source              text,
  action_id           text,
  app_version         text,
  crashes             integer,
  dormant             boolean
)
language sql
stable
security definer
set search_path = public
as $$
  with excluded as (
    select x.install_id from public.owner_installs x
    union
    select distinct e.install_id from public.install_events e where (e.props->>'dev') = 'true'
  ),
  ev as (
    select e.*
    from public.install_events e
    where e.day < current_date
      and not exists (select 1 from excluded x where x.install_id = e.install_id)
  ),
  installs as (
    select distinct on (e.install_id)
           e.install_id, e.product, e.day as install_day, e.created_at as installed_at
    from ev e
    where e.name = 'install'
    order by e.install_id, e.created_at
  ),
  source_by_install as (
    select distinct on (e.install_id) e.install_id, e.props->>'source' as source
    from ev e
    where e.name = 'source_answer' and e.props ? 'source'
    order by e.install_id, e.created_at
  ),
  acq_by_install as (
    select distinct on (e.install_id) e.install_id, e.props->>'acq_action_id' as action_id
    from ev e
    where e.props ? 'acq_action_id' and coalesce(e.props->>'acq_action_id', '') <> ''
    order by e.install_id, e.created_at
  ),
  matches as (
    select m.install_id, m.action_id, m.tier
    from public.install_click_matches() m
  ),
  labelled as (
    select
      i.install_id,
      coalesce(
        abi.action_id,
        case when m.action_id <> '' then 'probable:' || m.action_id end,
        'source:' || sbi.source,
        case when m.tier = 'ambiguous' then 'ambiguous' end,
        ''
      ) as action_id,
      sbi.source
    from installs i
    left join acq_by_install abi on abi.install_id = i.install_id
    left join matches m on m.install_id = i.install_id
    left join source_by_install sbi on sbi.install_id = i.install_id
  ),
  opens as (
    select e.install_id,
           max(e.day) as last_open_day,
           count(distinct e.day)::integer as days_opened,
           (count(distinct e.day) filter (where e.day >= current_date - 7))::integer as opens_7d,
           bool_or(e.day >= current_date - 14) as opened_14d
    from ev e
    where e.name = 'app_open'
    group by 1
  ),
  asks as (
    select e.install_id,
           count(*)::integer as asks_total,
           (count(*) filter (where e.props ? 'outcome' and e.props->>'outcome' <> 'ok'))::integer as asks_failed,
           min(e.created_at) filter (where e.name = 'first_ask') as first_ask_at
    from ev e
    where e.name in ('ask', 'first_ask')
    group by 1
  ),
  asks_feature as (
    select s.install_id, jsonb_object_agg(s.feature, s.n) as by_feature
    from (
      select e.install_id, e.props->>'feature' as feature, count(*) as n
      from ev e
      where e.name in ('ask', 'first_ask') and coalesce(e.props->>'feature', '') <> ''
      group by 1, 2
    ) s
    group by 1
  ),
  app_minutes as (
    select e.install_id, sum(coalesce(public.install_prop_num(e.props, 'minutes'), 0)) as minutes_total
    from ev e
    where e.name = 'app_session'
    group by 1
  ),
  minutes_feature as (
    select s.install_id, jsonb_object_agg(s.feature, s.minutes) as by_feature
    from (
      select e.install_id, e.props->>'feature' as feature,
             round(sum(coalesce(public.install_prop_num(e.props, 'seconds'), 0)) / 60.0) as minutes
      from ev e
      where e.name = 'feature_session' and coalesce(e.props->>'feature', '') <> ''
      group by 1, 2
    ) s
    group by 1
  ),
  steps as (
    select distinct on (e.install_id) e.install_id, e.props->>'step' as last_step
    from ev e
    where e.name = 'onboarding_step' and coalesce(e.props->>'step', '') <> ''
    order by e.install_id, e.created_at desc
  ),
  versions as (
    select distinct on (e.install_id) e.install_id, e.app_version
    from ev e
    where e.app_version is not null
    order by e.install_id, e.created_at desc
  ),
  crash_counts as (
    select e.install_id, count(*)::integer as crashes
    from ev e
    where e.name = 'crash'
    group by 1
  )
  select
    public.install_hash(i.install_id, salt) as install_hash,
    i.product,
    i.install_day,
    o.last_open_day,
    coalesce(o.days_opened, 0) as days_opened,
    coalesce(o.opens_7d, 0) as opens_7d,
    coalesce(a.asks_total, 0) as asks_total,
    coalesce(af.by_feature, '{}'::jsonb) as asks_by_feature,
    coalesce(a.asks_failed, 0) as asks_failed,
    coalesce(am.minutes_total, 0) as minutes_total,
    coalesce(mf.by_feature, '{}'::jsonb) as minutes_by_feature,
    case when a.first_ask_at is not null
         then floor(extract(epoch from (a.first_ask_at - i.installed_at)) / 60)::integer
    end as first_ask_delay_min,
    s.last_step,
    l.source,
    l.action_id,
    v.app_version,
    coalesce(c.crashes, 0) as crashes,
    not coalesce(o.opened_14d, false) as dormant
  from installs i
  join labelled l on l.install_id = i.install_id
  left join opens o on o.install_id = i.install_id
  left join asks a on a.install_id = i.install_id
  left join asks_feature af on af.install_id = i.install_id
  left join app_minutes am on am.install_id = i.install_id
  left join minutes_feature mf on mf.install_id = i.install_id
  left join steps s on s.install_id = i.install_id
  left join versions v on v.install_id = i.install_id
  left join crash_counts c on c.install_id = i.install_id
  where since is null or i.install_day >= since
  order by i.install_day, 1;
$$;

revoke all on function public.install_ledger(date, text) from public, anon, authenticated;


-- =============================================================================
-- Fifth edition (2026-11-06): the update channel (amendment d, 2026-11-04) and
-- Companion 0.1.16 retention
-- =============================================================================
-- Paste THIS block (from here to the end of the file) on its own into the
-- live project's SQL editor, after the fourth edition (already live since
-- 2026-10-21). It carries amendment (d) too, which was never deployed.
-- Re-runnable: every statement drops or replaces what it creates. It
--   1. widens the install_events name check to amendment (d) (update_offered,
--      notice_shown, notice_clicked) and the 0.1.16 names (first_win,
--      engaged, ai_ready, hook_shown, hook_used);
--   2. widens the dedupe: engaged joins app_open at one row per install per
--      UTC day (install_events_one_per_day replaces
--      install_events_one_open_per_day), and first_win and ai_ready are one
--      row per install ever (install_events_once_per_install). `track` answers
--      204 on the repeat, as it already did for a second app_open;
--   3. REPLACES install_daily_metrics(since) in place: the fourth edition plus
--      the amendment (d) breakdowns and the 0.1.16 rows listed above it;
--   4. DROPS and recreates install_ledger(since, salt): the same eighteen
--      columns plus eleven retention columns at the end (a return type cannot
--      change under CREATE OR REPLACE).
-- Same row shape on the wire for the rollup; the daily-metrics function is
-- unchanged. The install-ledger function is redeployed for the new fields.
--
-- The 0.1.16 events, as the client sends them:
--   first_win {feature}   once per install: the first ask with outcome ok
--                         whose feature is not `greeting`;
--   engaged {}            once per UTC day: the first user-initiated action
--                         (hotkey ask, typed ask, tray click, dashboard open);
--   ai_ready {path}       once: key | claude_code | none;
--   hook_shown {hook}, hook_used {hook}   a proactive surface was shown/used;
--   app_open gains props.via (login | manual | relaunch) and props.nudge_group
--     (on | off; off is the 10% holdout that gets no proactive pop-ups);
--   onboarding_step gains props.struggle on step struggle_picked.
-- Note: app_open stays one row per day, so its via is the via of the day's
-- FIRST open (a login start beats a later manual open).

-- 1. Event names. Same drop-every-check-on-name loop as the fourth edition.
do $$
declare c record;
begin
  for c in
    select conname
    from pg_constraint
    where conrelid = 'public.install_events'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%(name = ANY%'
  loop
    execute format('alter table public.install_events drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.install_events add constraint install_events_name_check
  check (name in (
    'install', 'app_open', 'source_answer', 'first_import', 'import', 'first_ask', 'ask',
    'key_connected', 'companion_session', 'signin', 'limit_hit', 'upgrade_click',
    'checkout_started', 'stats_off',
    'feature_session', 'app_session', 'onboarding_step', 'first_run_end', 'crash',
    'update_installed',   -- props.from = previous version, props.via
    -- Amendment (d), 2026-11-04.
    'update_offered',     -- props.surface
    'notice_shown',       -- props.notice
    'notice_clicked',     -- props.notice
    -- Fifth edition, 2026-11-06: Companion 0.1.16 retention.
    'first_win',          -- props.feature; once per install
    'engaged',            -- once per install per UTC day
    'ai_ready',           -- props.path; once per install
    'hook_shown',         -- props.hook
    'hook_used'           -- props.hook
  ));

-- 2. Dedupe. Build the new daily index before dropping the old one so there is
-- no moment without a guard on app_open.
create unique index if not exists install_events_one_per_day
  on public.install_events (install_id, name, day)
  where name in ('app_open', 'engaged');
drop index if exists public.install_events_one_open_per_day;
create unique index if not exists install_events_once_per_install
  on public.install_events (install_id, name)
  where name in ('first_win', 'ai_ready');

-- 3. install_daily_metrics, fifth edition. Same signature and row shape as
-- the four editions above. Everything in the fourth edition, unchanged, except
-- that update_installed is now broken down by via. New rows, all on completed
-- UTC days, owner and dev installs excluded:
--   Amendment (d):
--   update_installed    counts, action_id 'via:<oneclick|manual>' (no via = manual);
--   update_offered      counts, action_id 'surface:<bubble|card>';
--   notice_shown, notice_clicked   counts, action_id 'notice:<id>';
--   0.1.16:
--   first_win           in the install family: count by acquisition action_id
--                       (setup code > probable > source > ambiguous > '');
--   first_win_feature   first_win by props.feature, action_id 'feature:<f>';
--   engaged             distinct installs with an engaged that day;
--   engaged_d1, engaged_d7   installs whose install day is day - 1 / day - 7
--                       with an engaged on day (the d1_open/d7_open shape);
--   ai_ready            installs by props.path, action_id 'path:<p>';
--   hook_shown, hook_used    events by props.hook, action_id 'hook:<h>',
--                       value = distinct installs that day;
--   app_open_via        distinct installs by the via of the day's open,
--                       action_id 'via:<login|manual|relaunch|none>'. The
--                       plain app_open row is unchanged, so nothing double counts.
create or replace function public.install_daily_metrics(since date)
returns table (
  day         date,
  product     text,
  action_id   text,
  event_name  text,
  event_count bigint,
  value       numeric
)
language sql
stable
security definer
set search_path = public
as $$
  with excluded as (
    select install_id from public.owner_installs
    union
    select distinct install_id from public.install_events where (props->>'dev') = 'true'
  ),
  -- Every row below reads from ev: completed days only, founder removed.
  ev as (
    select e.*
    from public.install_events e
    where e.day < current_date
      and not exists (select 1 from excluded x where x.install_id = e.install_id)
  ),
  source_by_install as (
    select distinct on (install_id) install_id, props->>'source' as source
    from ev
    where name = 'source_answer' and props ? 'source'
    order by install_id, created_at
  ),
  acq_by_install as (
    select distinct on (install_id) install_id, props->>'acq_action_id' as action_id
    from ev
    where props ? 'acq_action_id' and coalesce(props->>'acq_action_id', '') <> ''
    order by install_id, created_at
  ),
  matches as (
    select m.install_id, m.action_id, m.tier
    from public.install_click_matches() m
  ),
  labelled as (
    select
      e.install_id,
      coalesce(
        abi.action_id,
        case when m.action_id <> '' then 'probable:' || m.action_id end,
        'source:' || sbi.source,
        case when m.tier = 'ambiguous' then 'ambiguous' end,
        ''
      ) as action_id
    from (select distinct install_id from ev) e
    left join acq_by_install abi on abi.install_id = e.install_id
    left join matches m on m.install_id = e.install_id
    left join source_by_install sbi on sbi.install_id = e.install_id
  ),
  -- The asked window. Install-day lookups (retention, cohorts) read ev
  -- instead, because the install may predate `since`.
  win as (
    select * from ev where day >= since
  ),
  counted as (
    select e.day, e.product, l.action_id, e.name as event_name,
           count(*)::bigint as event_count, null::numeric as value
    from win e
    join labelled l on l.install_id = e.install_id
    where e.name in ('install', 'first_import', 'first_ask', 'first_win', 'signin', 'upgrade_click', 'checkout_started')
    group by 1, 2, 3, 4
  ),
  -- companion_session (desktop voice captures) and app_session (active
  -- minutes) share one shape: count = sessions, value = minutes.
  sessions as (
    select e.day, e.product, l.action_id, e.name as event_name,
           count(*)::bigint as event_count,
           sum(coalesce(public.install_prop_num(e.props, 'minutes'), 0)) as value
    from win e
    join labelled l on l.install_id = e.install_id
    where e.name in ('companion_session', 'app_session')
    group by 1, 2, 3, 4
  ),
  feature_asks as (
    select e.day, e.product, 'feature:' || (e.props->>'feature') as action_id,
           'feature_ask' as event_name,
           count(*)::bigint as event_count,
           (count(*) filter (where e.props ? 'outcome' and e.props->>'outcome' <> 'ok'))::numeric as value
    from win e
    where e.name in ('ask', 'first_ask')
      and coalesce(e.props->>'feature', '') <> ''
    group by 1, 2, 3, 4
  ),
  feature_minutes as (
    select e.day, e.product, 'feature:' || (e.props->>'feature') as action_id,
           'feature_minutes' as event_name,
           count(*)::bigint as event_count,
           round(sum(coalesce(public.install_prop_num(e.props, 'seconds'), 0)) / 60.0, 1) as value
    from win e
    where e.name = 'feature_session'
      and coalesce(e.props->>'feature', '') <> ''
    group by 1, 2, 3, 4
  ),
  steps as (
    select e.day, e.product, 'step:' || (e.props->>'step') as action_id,
           'onboarding_step' as event_name,
           count(distinct e.install_id)::bigint as event_count,
           null::numeric as value
    from win e
    where e.name = 'onboarding_step'
      and coalesce(e.props->>'step', '') <> ''
    group by 1, 2, 3, 4
  ),
  first_run_ends as (
    select e.day, e.product,
           'step:' || coalesce(nullif(e.props->>'step', ''), 'none') as action_id,
           'first_run_end' as event_name,
           count(distinct e.install_id)::bigint as event_count,
           round((percentile_cont(0.5) within group (order by public.install_prop_num(e.props, 'seconds'))
             filter (where public.install_prop_num(e.props, 'seconds') is not null))::numeric, 0) as value
    from win e
    where e.name = 'first_run_end'
    group by 1, 2, 3, 4
  ),
  ask_outcomes as (
    select e.day, e.product, 'outcome:' || (e.props->>'outcome') as action_id,
           'ask_outcome' as event_name,
           count(*)::bigint as event_count,
           null::numeric as value
    from win e
    where e.name in ('ask', 'first_ask')
      and coalesce(e.props->>'outcome', '') <> ''
    group by 1, 2, 3, 4
  ),
  plain_counts as (
    select e.day, e.product, '' as action_id, e.name as event_name,
           count(*)::bigint as event_count, null::numeric as value
    from win e
    where e.name = 'crash'
    group by 1, 2, 3, 4
  ),
  -- Amendment (d): the update and notice channel.
  channel_counts as (
    select e.day, e.product,
           case e.name
             when 'update_installed' then 'via:' || coalesce(nullif(e.props->>'via', ''), 'manual')
             when 'update_offered' then 'surface:' || coalesce(nullif(e.props->>'surface', ''), 'none')
             else 'notice:' || coalesce(nullif(e.props->>'notice', ''), 'none')
           end as action_id,
           e.name as event_name,
           count(*)::bigint as event_count, null::numeric as value
    from win e
    where e.name in ('update_installed', 'update_offered', 'notice_shown', 'notice_clicked')
    group by 1, 2, 3, 4
  ),
  -- 0.1.16 retention.
  first_win_features as (
    select e.day, e.product, 'feature:' || coalesce(nullif(e.props->>'feature', ''), 'none') as action_id,
           'first_win_feature' as event_name,
           count(distinct e.install_id)::bigint as event_count, null::numeric as value
    from win e
    where e.name = 'first_win'
    group by 1, 2, 3, 4
  ),
  engaged_days as (
    select day, product, '' as action_id, 'engaged' as event_name,
           count(distinct install_id)::bigint as event_count, null::numeric as value
    from win
    where name = 'engaged'
    group by 1, 2
  ),
  ai_ready_paths as (
    select e.day, e.product, 'path:' || coalesce(nullif(e.props->>'path', ''), 'none') as action_id,
           'ai_ready' as event_name,
           count(distinct e.install_id)::bigint as event_count, null::numeric as value
    from win e
    where e.name = 'ai_ready'
    group by 1, 2, 3, 4
  ),
  hooks as (
    select e.day, e.product, 'hook:' || coalesce(nullif(e.props->>'hook', ''), 'none') as action_id,
           e.name as event_name,
           count(*)::bigint as event_count,
           count(distinct e.install_id)::numeric as value
    from win e
    where e.name in ('hook_shown', 'hook_used')
    group by 1, 2, 3, 4
  ),
  open_vias as (
    select e.day, e.product, 'via:' || coalesce(nullif(e.props->>'via', ''), 'none') as action_id,
           'app_open_via' as event_name,
           count(distinct e.install_id)::bigint as event_count, null::numeric as value
    from win e
    where e.name = 'app_open'
    group by 1, 2, 3, 4
  ),
  beacons as (
    select day, product, action_id, 'download_beacon' as event_name,
           count(*)::bigint as event_count, null::numeric as value
    from public.download_clicks
    where day >= since and day < current_date
    group by 1, 2, 3
  ),
  opens as (
    select day, product, '' as action_id, 'app_open' as event_name,
           count(distinct install_id)::bigint as event_count, null::numeric as value
    from win
    where name = 'app_open'
    group by 1, 2
  ),
  installs as (
    select install_id, min(product) as product, min(day) as install_day
    from ev
    where name = 'install'
    group by 1
  ),
  -- d1_open / d7_open from app_open, engaged_d1 / engaged_d7 from engaged:
  -- the same rule, so the two pairs compare directly.
  retention as (
    select
      o.day,
      o.product,
      '' as action_id,
      case
        when o.name = 'app_open' and o.day = i.install_day + 1 then 'd1_open'
        when o.name = 'app_open' then 'd7_open'
        when o.day = i.install_day + 1 then 'engaged_d1'
        else 'engaged_d7'
      end as event_name,
      count(distinct o.install_id)::bigint as event_count,
      null::numeric as value
    from win o
    join installs i on i.install_id = o.install_id
    where o.name in ('app_open', 'engaged')
      and (o.day = i.install_day + 1 or o.day = i.install_day + 7)
    group by 1, 2, 3, 4
  ),
  -- Weekly install cohorts. Postgres weeks start on Monday, so
  -- date_trunc('week') is the Monday of the install week.
  install_weeks as (
    select
      i.install_id,
      i.product,
      date_trunc('week', i.install_day::timestamp)::date as week_start
    from installs i
  ),
  cohorts as (
    select
      (iw.week_start + 6 + 7 * k.k) as day,
      iw.product,
      '' as action_id,
      'w' || k.k || '_open' as event_name,
      count(distinct iw.install_id)::bigint as event_count,
      null::numeric as value
    from install_weeks iw
    cross join (values (1), (2), (3)) as k(k)
    join ev o
      on o.install_id = iw.install_id
     and o.name = 'app_open'
     and o.day >= iw.week_start + 7 * k.k
     and o.day <  iw.week_start + 7 * (k.k + 1)
    where (iw.week_start + 6 + 7 * k.k) >= since
      and (iw.week_start + 6 + 7 * k.k) < current_date
    group by 1, 2, 3, 4
  ),
  paid as (
    select
      (sub.stripe_subscription_created_at at time zone 'utc')::date as day,
      'desktop' as product,
      '' as action_id,
      'paid' as event_name,
      count(*)::bigint as event_count,
      null::numeric as value
    from public.subscriptions sub
    where sub.stripe_subscription_created_at is not null
      and (sub.stripe_subscription_created_at at time zone 'utc')::date >= since
      and (sub.stripe_subscription_created_at at time zone 'utc')::date < current_date
    group by 1
  ),
  everything as (
    select day, product, action_id, event_name, event_count, value from counted
    union all select day, product, action_id, event_name, event_count, value from sessions
    union all select day, product, action_id, event_name, event_count, value from feature_asks
    union all select day, product, action_id, event_name, event_count, value from feature_minutes
    union all select day, product, action_id, event_name, event_count, value from steps
    union all select day, product, action_id, event_name, event_count, value from first_run_ends
    union all select day, product, action_id, event_name, event_count, value from ask_outcomes
    union all select day, product, action_id, event_name, event_count, value from plain_counts
    union all select day, product, action_id, event_name, event_count, value from channel_counts
    union all select day, product, action_id, event_name, event_count, value from first_win_features
    union all select day, product, action_id, event_name, event_count, value from engaged_days
    union all select day, product, action_id, event_name, event_count, value from ai_ready_paths
    union all select day, product, action_id, event_name, event_count, value from hooks
    union all select day, product, action_id, event_name, event_count, value from open_vias
    union all select day, product, action_id, event_name, event_count, value from beacons
    union all select day, product, action_id, event_name, event_count, value from opens
    union all select day, product, action_id, event_name, event_count, value from retention
    union all select day, product, action_id, event_name, event_count, value from cohorts
    union all select day, product, action_id, event_name, event_count, value from paid
  )
  select day, product, action_id, event_name, event_count, value
  from everything
  order by day, product, event_name, action_id;
$$;

revoke all on function public.install_daily_metrics(date) from public, anon, authenticated;

-- 4. install_ledger, fifth edition. install_hash() is unchanged (fourth
-- edition). The eighteen fourth-edition columns are unchanged and keep their
-- order; these follow them:
--   first_version        app_version on the install's earliest event that has one
--   first_win_delay_min  install row to first_win row in whole minutes, null if none
--   first_win_feature    props.feature of that first_win, null if none
--   engaged_days_w1      distinct UTC days with an engaged in the first 7 days
--                        (install day to install day + 6)
--   engaged_days_28      distinct engaged days in the last 28 completed days
--                        (rolling, like opens_7d; not the first 28 days)
--   last_engaged_day     the latest engaged day, null if none
--   ai_ready_path        props.path of the earliest ai_ready, null if none
--   struggle             the latest props.struggle sent, null if none
--   nudge_group          the latest props.nudge_group sent (on | off), null if none
--   hooks_shown, hooks_used   {"<hook>": count} over the install's life
drop function if exists public.install_ledger(date, text);

create or replace function public.install_ledger(since date default null, salt text default null)
returns table (
  install_hash        text,
  product             text,
  install_day         date,
  last_open_day       date,
  days_opened         integer,
  opens_7d            integer,
  asks_total          integer,
  asks_by_feature     jsonb,
  asks_failed         integer,
  minutes_total       numeric,
  minutes_by_feature  jsonb,
  first_ask_delay_min integer,
  last_step           text,
  source              text,
  action_id           text,
  app_version         text,
  crashes             integer,
  dormant             boolean,
  first_version       text,
  first_win_delay_min integer,
  first_win_feature   text,
  engaged_days_w1     integer,
  engaged_days_28     integer,
  last_engaged_day    date,
  ai_ready_path       text,
  struggle            text,
  nudge_group         text,
  hooks_shown         jsonb,
  hooks_used          jsonb
)
language sql
stable
security definer
set search_path = public
as $$
  with excluded as (
    select x.install_id from public.owner_installs x
    union
    select distinct e.install_id from public.install_events e where (e.props->>'dev') = 'true'
  ),
  ev as (
    select e.*
    from public.install_events e
    where e.day < current_date
      and not exists (select 1 from excluded x where x.install_id = e.install_id)
  ),
  installs as (
    select distinct on (e.install_id)
           e.install_id, e.product, e.day as install_day, e.created_at as installed_at
    from ev e
    where e.name = 'install'
    order by e.install_id, e.created_at
  ),
  source_by_install as (
    select distinct on (e.install_id) e.install_id, e.props->>'source' as source
    from ev e
    where e.name = 'source_answer' and e.props ? 'source'
    order by e.install_id, e.created_at
  ),
  acq_by_install as (
    select distinct on (e.install_id) e.install_id, e.props->>'acq_action_id' as action_id
    from ev e
    where e.props ? 'acq_action_id' and coalesce(e.props->>'acq_action_id', '') <> ''
    order by e.install_id, e.created_at
  ),
  matches as (
    select m.install_id, m.action_id, m.tier
    from public.install_click_matches() m
  ),
  labelled as (
    select
      i.install_id,
      coalesce(
        abi.action_id,
        case when m.action_id <> '' then 'probable:' || m.action_id end,
        'source:' || sbi.source,
        case when m.tier = 'ambiguous' then 'ambiguous' end,
        ''
      ) as action_id,
      sbi.source
    from installs i
    left join acq_by_install abi on abi.install_id = i.install_id
    left join matches m on m.install_id = i.install_id
    left join source_by_install sbi on sbi.install_id = i.install_id
  ),
  opens as (
    select e.install_id,
           max(e.day) as last_open_day,
           count(distinct e.day)::integer as days_opened,
           (count(distinct e.day) filter (where e.day >= current_date - 7))::integer as opens_7d,
           bool_or(e.day >= current_date - 14) as opened_14d
    from ev e
    where e.name = 'app_open'
    group by 1
  ),
  asks as (
    select e.install_id,
           count(*)::integer as asks_total,
           (count(*) filter (where e.props ? 'outcome' and e.props->>'outcome' <> 'ok'))::integer as asks_failed,
           min(e.created_at) filter (where e.name = 'first_ask') as first_ask_at
    from ev e
    where e.name in ('ask', 'first_ask')
    group by 1
  ),
  asks_feature as (
    select s.install_id, jsonb_object_agg(s.feature, s.n) as by_feature
    from (
      select e.install_id, e.props->>'feature' as feature, count(*) as n
      from ev e
      where e.name in ('ask', 'first_ask') and coalesce(e.props->>'feature', '') <> ''
      group by 1, 2
    ) s
    group by 1
  ),
  app_minutes as (
    select e.install_id, sum(coalesce(public.install_prop_num(e.props, 'minutes'), 0)) as minutes_total
    from ev e
    where e.name = 'app_session'
    group by 1
  ),
  minutes_feature as (
    select s.install_id, jsonb_object_agg(s.feature, s.minutes) as by_feature
    from (
      select e.install_id, e.props->>'feature' as feature,
             round(sum(coalesce(public.install_prop_num(e.props, 'seconds'), 0)) / 60.0) as minutes
      from ev e
      where e.name = 'feature_session' and coalesce(e.props->>'feature', '') <> ''
      group by 1, 2
    ) s
    group by 1
  ),
  steps as (
    select distinct on (e.install_id) e.install_id, e.props->>'step' as last_step
    from ev e
    where e.name = 'onboarding_step' and coalesce(e.props->>'step', '') <> ''
    order by e.install_id, e.created_at desc
  ),
  versions as (
    select distinct on (e.install_id) e.install_id, e.app_version
    from ev e
    where e.app_version is not null
    order by e.install_id, e.created_at desc
  ),
  crash_counts as (
    select e.install_id, count(*)::integer as crashes
    from ev e
    where e.name = 'crash'
    group by 1
  ),
  -- Fifth edition.
  first_versions as (
    select distinct on (e.install_id) e.install_id, e.app_version as first_version
    from ev e
    where e.app_version is not null
    order by e.install_id, e.created_at
  ),
  first_wins as (
    select distinct on (e.install_id) e.install_id, e.created_at as first_win_at,
           nullif(e.props->>'feature', '') as first_win_feature
    from ev e
    where e.name = 'first_win'
    order by e.install_id, e.created_at
  ),
  engaged as (
    select e.install_id,
           (count(distinct e.day) filter (where e.day >= i.install_day and e.day < i.install_day + 7))::integer as engaged_days_w1,
           (count(distinct e.day) filter (where e.day >= current_date - 28))::integer as engaged_days_28,
           max(e.day) as last_engaged_day
    from ev e
    join installs i on i.install_id = e.install_id
    where e.name = 'engaged'
    group by 1
  ),
  ai_paths as (
    select distinct on (e.install_id) e.install_id, nullif(e.props->>'path', '') as ai_ready_path
    from ev e
    where e.name = 'ai_ready'
    order by e.install_id, e.created_at
  ),
  struggles as (
    select distinct on (e.install_id) e.install_id, e.props->>'struggle' as struggle
    from ev e
    where coalesce(e.props->>'struggle', '') <> ''
    order by e.install_id, e.created_at desc
  ),
  nudge_groups as (
    select distinct on (e.install_id) e.install_id, e.props->>'nudge_group' as nudge_group
    from ev e
    where coalesce(e.props->>'nudge_group', '') <> ''
    order by e.install_id, e.created_at desc
  ),
  hook_counts as (
    select s.install_id,
           jsonb_object_agg(s.hook, s.n) filter (where s.name = 'hook_shown') as shown,
           jsonb_object_agg(s.hook, s.n) filter (where s.name = 'hook_used') as used
    from (
      select e.install_id, e.name, e.props->>'hook' as hook, count(*) as n
      from ev e
      where e.name in ('hook_shown', 'hook_used') and coalesce(e.props->>'hook', '') <> ''
      group by 1, 2, 3
    ) s
    group by 1
  )
  select
    public.install_hash(i.install_id, salt) as install_hash,
    i.product,
    i.install_day,
    o.last_open_day,
    coalesce(o.days_opened, 0) as days_opened,
    coalesce(o.opens_7d, 0) as opens_7d,
    coalesce(a.asks_total, 0) as asks_total,
    coalesce(af.by_feature, '{}'::jsonb) as asks_by_feature,
    coalesce(a.asks_failed, 0) as asks_failed,
    coalesce(am.minutes_total, 0) as minutes_total,
    coalesce(mf.by_feature, '{}'::jsonb) as minutes_by_feature,
    case when a.first_ask_at is not null
         then floor(extract(epoch from (a.first_ask_at - i.installed_at)) / 60)::integer
    end as first_ask_delay_min,
    s.last_step,
    l.source,
    l.action_id,
    v.app_version,
    coalesce(c.crashes, 0) as crashes,
    not coalesce(o.opened_14d, false) as dormant,
    fv.first_version,
    case when fw.first_win_at is not null
         then floor(extract(epoch from (fw.first_win_at - i.installed_at)) / 60)::integer
    end as first_win_delay_min,
    fw.first_win_feature,
    coalesce(en.engaged_days_w1, 0) as engaged_days_w1,
    coalesce(en.engaged_days_28, 0) as engaged_days_28,
    en.last_engaged_day,
    ap.ai_ready_path,
    st.struggle,
    ng.nudge_group,
    coalesce(hc.shown, '{}'::jsonb) as hooks_shown,
    coalesce(hc.used, '{}'::jsonb) as hooks_used
  from installs i
  join labelled l on l.install_id = i.install_id
  left join opens o on o.install_id = i.install_id
  left join asks a on a.install_id = i.install_id
  left join asks_feature af on af.install_id = i.install_id
  left join app_minutes am on am.install_id = i.install_id
  left join minutes_feature mf on mf.install_id = i.install_id
  left join steps s on s.install_id = i.install_id
  left join versions v on v.install_id = i.install_id
  left join crash_counts c on c.install_id = i.install_id
  left join first_versions fv on fv.install_id = i.install_id
  left join first_wins fw on fw.install_id = i.install_id
  left join engaged en on en.install_id = i.install_id
  left join ai_paths ap on ap.install_id = i.install_id
  left join struggles st on st.install_id = i.install_id
  left join nudge_groups ng on ng.install_id = i.install_id
  left join hook_counts hc on hc.install_id = i.install_id
  where since is null or i.install_day >= since
  order by i.install_day, 1;
$$;

revoke all on function public.install_ledger(date, text) from public, anon, authenticated;

-- =============================================================================
-- Sixth edition (2026-11-11): the sign-in door (TELEMETRY-CONTRACT.md amendment f)
-- =============================================================================
-- Paste THIS block (from here to the end of the file) on its own into the
-- live project's SQL editor, after the fifth edition (live). Re-runnable: every
-- statement drops or replaces what it creates. It
--   1. widens the install_events name check to the sign-in door of Companion
--      0.1.19: signin_shown, signin_clicked, signin_closed, signin_unreachable,
--      ai_source. "Signed in" reuses the name `signin` (in the list since the
--      first edition) with props.method = 'publik', so that row already lands
--      and already shows in the rollup's install family, by acquisition label;
--   2. DROPS and recreates install_ledger(since, salt): the same twenty-nine
--      columns plus seven sign-in columns at the end (a return type cannot
--      change under CREATE OR REPLACE).
-- install_daily_metrics(since) is NOT touched: the funnel is read per install
-- from the ledger, and `signin` is already one of its rows. No new index: the
-- client sends `signin` once per install by its own flag, and the door rows
-- are meant to repeat (one per launch that showed the window).
-- The track function carries the new names, the keys `cohort` and `screen`,
-- `publik` as an ai_ready path, and the hook values contact_card and
-- contact_declined; the install-ledger function is redeployed for the fields.
--
-- The 0.1.19 events, as the client sends them (install id and fixed words
-- only; nothing from publik, no account, no email):
--   signin_shown {cohort}      the sign-in window was drawn, once per launch;
--                              cohort new | update (was another version here before);
--   signin_clicked {}          Sign in with publik was pressed, once per launch;
--   signin {method: 'publik', seconds?}   signed in, once per install; seconds
--                              from the window to signed in, absent when the
--                              install was already signed in before 0.1.19;
--   signin_closed {screen, seconds}   the window was closed or the app quit
--                              with the door shut; screen sign_in | waiting |
--                              choose | unreachable;
--   signin_unreachable {}      the "publik is not reachable" screen was drawn;
--   ai_source {path}           who answers after the door: publik | own_key,
--                              sent when first known and when it changes.
-- These rows can arrive late (they wait on the computer until the server
-- takes them), so their `day` is the day they arrived, not always the day
-- they happened.

-- 1. Event names. Same drop-every-check-on-name loop as the fifth edition.
do $$
declare c record;
begin
  for c in
    select conname
    from pg_constraint
    where conrelid = 'public.install_events'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%(name = ANY%'
  loop
    execute format('alter table public.install_events drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.install_events add constraint install_events_name_check
  check (name in (
    'install', 'app_open', 'source_answer', 'first_import', 'import', 'first_ask', 'ask',
    'key_connected', 'companion_session', 'signin', 'limit_hit', 'upgrade_click',
    'checkout_started', 'stats_off',
    'feature_session', 'app_session', 'onboarding_step', 'first_run_end', 'crash',
    'update_installed',   -- props.from = previous version, props.via
    -- Amendment (d), 2026-11-04.
    'update_offered',     -- props.surface
    'notice_shown',       -- props.notice
    'notice_clicked',     -- props.notice
    -- Fifth edition, 2026-11-06: Companion 0.1.16 retention.
    'first_win',          -- props.feature; once per install
    'engaged',            -- once per install per UTC day
    'ai_ready',           -- props.path; once per install
    'hook_shown',         -- props.hook
    'hook_used',          -- props.hook
    -- Sixth edition, 2026-11-11: the sign-in door (amendment f).
    'signin_shown',       -- props.cohort
    'signin_clicked',
    'signin_closed',      -- props.screen, props.seconds
    'signin_unreachable',
    'ai_source'           -- props.path
  ));

-- 2. install_ledger, sixth edition. install_hash() is unchanged (fourth
-- edition). The twenty-nine fifth-edition columns are unchanged and keep their
-- order; these follow them:
--   signin_shown        launches that drew the sign-in window (0 = never seen)
--   signin_cohort       props.cohort of the earliest signin_shown (new | update)
--   signin_clicked      launches where Sign in with publik was pressed
--   signin_delay_min    install row to the earliest signin {method publik} row
--                       in whole minutes; null = not signed in
--   signin_closed       {"<screen>": count} of the times the door was closed
--   signin_unreachable  launches that drew "publik is not reachable"
--   ai_source           the latest props.path of ai_source (publik | own_key)
drop function if exists public.install_ledger(date, text);

create or replace function public.install_ledger(since date default null, salt text default null)
returns table (
  install_hash        text,
  product             text,
  install_day         date,
  last_open_day       date,
  days_opened         integer,
  opens_7d            integer,
  asks_total          integer,
  asks_by_feature     jsonb,
  asks_failed         integer,
  minutes_total       numeric,
  minutes_by_feature  jsonb,
  first_ask_delay_min integer,
  last_step           text,
  source              text,
  action_id           text,
  app_version         text,
  crashes             integer,
  dormant             boolean,
  first_version       text,
  first_win_delay_min integer,
  first_win_feature   text,
  engaged_days_w1     integer,
  engaged_days_28     integer,
  last_engaged_day    date,
  ai_ready_path       text,
  struggle            text,
  nudge_group         text,
  hooks_shown         jsonb,
  hooks_used          jsonb,
  signin_shown        integer,
  signin_cohort       text,
  signin_clicked      integer,
  signin_delay_min    integer,
  signin_closed       jsonb,
  signin_unreachable  integer,
  ai_source           text
)
language sql
stable
security definer
set search_path = public
as $$
  with excluded as (
    select x.install_id from public.owner_installs x
    union
    select distinct e.install_id from public.install_events e where (e.props->>'dev') = 'true'
  ),
  ev as (
    select e.*
    from public.install_events e
    where e.day < current_date
      and not exists (select 1 from excluded x where x.install_id = e.install_id)
  ),
  installs as (
    select distinct on (e.install_id)
           e.install_id, e.product, e.day as install_day, e.created_at as installed_at
    from ev e
    where e.name = 'install'
    order by e.install_id, e.created_at
  ),
  source_by_install as (
    select distinct on (e.install_id) e.install_id, e.props->>'source' as source
    from ev e
    where e.name = 'source_answer' and e.props ? 'source'
    order by e.install_id, e.created_at
  ),
  acq_by_install as (
    select distinct on (e.install_id) e.install_id, e.props->>'acq_action_id' as action_id
    from ev e
    where e.props ? 'acq_action_id' and coalesce(e.props->>'acq_action_id', '') <> ''
    order by e.install_id, e.created_at
  ),
  matches as (
    select m.install_id, m.action_id, m.tier
    from public.install_click_matches() m
  ),
  labelled as (
    select
      i.install_id,
      coalesce(
        abi.action_id,
        case when m.action_id <> '' then 'probable:' || m.action_id end,
        'source:' || sbi.source,
        case when m.tier = 'ambiguous' then 'ambiguous' end,
        ''
      ) as action_id,
      sbi.source
    from installs i
    left join acq_by_install abi on abi.install_id = i.install_id
    left join matches m on m.install_id = i.install_id
    left join source_by_install sbi on sbi.install_id = i.install_id
  ),
  opens as (
    select e.install_id,
           max(e.day) as last_open_day,
           count(distinct e.day)::integer as days_opened,
           (count(distinct e.day) filter (where e.day >= current_date - 7))::integer as opens_7d,
           bool_or(e.day >= current_date - 14) as opened_14d
    from ev e
    where e.name = 'app_open'
    group by 1
  ),
  asks as (
    select e.install_id,
           count(*)::integer as asks_total,
           (count(*) filter (where e.props ? 'outcome' and e.props->>'outcome' <> 'ok'))::integer as asks_failed,
           min(e.created_at) filter (where e.name = 'first_ask') as first_ask_at
    from ev e
    where e.name in ('ask', 'first_ask')
    group by 1
  ),
  asks_feature as (
    select s.install_id, jsonb_object_agg(s.feature, s.n) as by_feature
    from (
      select e.install_id, e.props->>'feature' as feature, count(*) as n
      from ev e
      where e.name in ('ask', 'first_ask') and coalesce(e.props->>'feature', '') <> ''
      group by 1, 2
    ) s
    group by 1
  ),
  app_minutes as (
    select e.install_id, sum(coalesce(public.install_prop_num(e.props, 'minutes'), 0)) as minutes_total
    from ev e
    where e.name = 'app_session'
    group by 1
  ),
  minutes_feature as (
    select s.install_id, jsonb_object_agg(s.feature, s.minutes) as by_feature
    from (
      select e.install_id, e.props->>'feature' as feature,
             round(sum(coalesce(public.install_prop_num(e.props, 'seconds'), 0)) / 60.0) as minutes
      from ev e
      where e.name = 'feature_session' and coalesce(e.props->>'feature', '') <> ''
      group by 1, 2
    ) s
    group by 1
  ),
  steps as (
    select distinct on (e.install_id) e.install_id, e.props->>'step' as last_step
    from ev e
    where e.name = 'onboarding_step' and coalesce(e.props->>'step', '') <> ''
    order by e.install_id, e.created_at desc
  ),
  versions as (
    select distinct on (e.install_id) e.install_id, e.app_version
    from ev e
    where e.app_version is not null
    order by e.install_id, e.created_at desc
  ),
  crash_counts as (
    select e.install_id, count(*)::integer as crashes
    from ev e
    where e.name = 'crash'
    group by 1
  ),
  -- Fifth edition.
  first_versions as (
    select distinct on (e.install_id) e.install_id, e.app_version as first_version
    from ev e
    where e.app_version is not null
    order by e.install_id, e.created_at
  ),
  first_wins as (
    select distinct on (e.install_id) e.install_id, e.created_at as first_win_at,
           nullif(e.props->>'feature', '') as first_win_feature
    from ev e
    where e.name = 'first_win'
    order by e.install_id, e.created_at
  ),
  engaged as (
    select e.install_id,
           (count(distinct e.day) filter (where e.day >= i.install_day and e.day < i.install_day + 7))::integer as engaged_days_w1,
           (count(distinct e.day) filter (where e.day >= current_date - 28))::integer as engaged_days_28,
           max(e.day) as last_engaged_day
    from ev e
    join installs i on i.install_id = e.install_id
    where e.name = 'engaged'
    group by 1
  ),
  ai_paths as (
    select distinct on (e.install_id) e.install_id, nullif(e.props->>'path', '') as ai_ready_path
    from ev e
    where e.name = 'ai_ready'
    order by e.install_id, e.created_at
  ),
  struggles as (
    select distinct on (e.install_id) e.install_id, e.props->>'struggle' as struggle
    from ev e
    where coalesce(e.props->>'struggle', '') <> ''
    order by e.install_id, e.created_at desc
  ),
  nudge_groups as (
    select distinct on (e.install_id) e.install_id, e.props->>'nudge_group' as nudge_group
    from ev e
    where coalesce(e.props->>'nudge_group', '') <> ''
    order by e.install_id, e.created_at desc
  ),
  hook_counts as (
    select s.install_id,
           jsonb_object_agg(s.hook, s.n) filter (where s.name = 'hook_shown') as shown,
           jsonb_object_agg(s.hook, s.n) filter (where s.name = 'hook_used') as used
    from (
      select e.install_id, e.name, e.props->>'hook' as hook, count(*) as n
      from ev e
      where e.name in ('hook_shown', 'hook_used') and coalesce(e.props->>'hook', '') <> ''
      group by 1, 2, 3
    ) s
    group by 1
  ),
  -- Sixth edition.
  signin_shows as (
    select e.install_id, count(*)::integer as signin_shown
    from ev e
    where e.name = 'signin_shown'
    group by 1
  ),
  signin_cohorts as (
    select distinct on (e.install_id) e.install_id, e.props->>'cohort' as signin_cohort
    from ev e
    where e.name = 'signin_shown' and coalesce(e.props->>'cohort', '') <> ''
    order by e.install_id, e.created_at
  ),
  signin_clicks as (
    select e.install_id, count(*)::integer as signin_clicked
    from ev e
    where e.name = 'signin_clicked'
    group by 1
  ),
  signins as (
    select distinct on (e.install_id) e.install_id, e.created_at as signin_at
    from ev e
    where e.name = 'signin' and e.props->>'method' = 'publik'
    order by e.install_id, e.created_at
  ),
  signin_closes as (
    select s.install_id, jsonb_object_agg(s.screen, s.n) as closed
    from (
      select e.install_id, coalesce(nullif(e.props->>'screen', ''), 'sign_in') as screen, count(*) as n
      from ev e
      where e.name = 'signin_closed'
      group by 1, 2
    ) s
    group by 1
  ),
  signin_unreach as (
    select e.install_id, count(*)::integer as signin_unreachable
    from ev e
    where e.name = 'signin_unreachable'
    group by 1
  ),
  ai_sources as (
    select distinct on (e.install_id) e.install_id, nullif(e.props->>'path', '') as ai_source
    from ev e
    where e.name = 'ai_source'
    order by e.install_id, e.created_at desc
  )
  select
    public.install_hash(i.install_id, salt) as install_hash,
    i.product,
    i.install_day,
    o.last_open_day,
    coalesce(o.days_opened, 0) as days_opened,
    coalesce(o.opens_7d, 0) as opens_7d,
    coalesce(a.asks_total, 0) as asks_total,
    coalesce(af.by_feature, '{}'::jsonb) as asks_by_feature,
    coalesce(a.asks_failed, 0) as asks_failed,
    coalesce(am.minutes_total, 0) as minutes_total,
    coalesce(mf.by_feature, '{}'::jsonb) as minutes_by_feature,
    case when a.first_ask_at is not null
         then floor(extract(epoch from (a.first_ask_at - i.installed_at)) / 60)::integer
    end as first_ask_delay_min,
    s.last_step,
    l.source,
    l.action_id,
    v.app_version,
    coalesce(c.crashes, 0) as crashes,
    not coalesce(o.opened_14d, false) as dormant,
    fv.first_version,
    case when fw.first_win_at is not null
         then floor(extract(epoch from (fw.first_win_at - i.installed_at)) / 60)::integer
    end as first_win_delay_min,
    fw.first_win_feature,
    coalesce(en.engaged_days_w1, 0) as engaged_days_w1,
    coalesce(en.engaged_days_28, 0) as engaged_days_28,
    en.last_engaged_day,
    ap.ai_ready_path,
    st.struggle,
    ng.nudge_group,
    coalesce(hc.shown, '{}'::jsonb) as hooks_shown,
    coalesce(hc.used, '{}'::jsonb) as hooks_used,
    coalesce(ss.signin_shown, 0) as signin_shown,
    sc.signin_cohort,
    coalesce(sk.signin_clicked, 0) as signin_clicked,
    case when si.signin_at is not null
         then greatest(0, floor(extract(epoch from (si.signin_at - i.installed_at)) / 60))::integer
    end as signin_delay_min,
    coalesce(sx.closed, '{}'::jsonb) as signin_closed,
    coalesce(su.signin_unreachable, 0) as signin_unreachable,
    az.ai_source
  from installs i
  join labelled l on l.install_id = i.install_id
  left join opens o on o.install_id = i.install_id
  left join asks a on a.install_id = i.install_id
  left join asks_feature af on af.install_id = i.install_id
  left join app_minutes am on am.install_id = i.install_id
  left join minutes_feature mf on mf.install_id = i.install_id
  left join steps s on s.install_id = i.install_id
  left join versions v on v.install_id = i.install_id
  left join crash_counts c on c.install_id = i.install_id
  left join first_versions fv on fv.install_id = i.install_id
  left join first_wins fw on fw.install_id = i.install_id
  left join engaged en on en.install_id = i.install_id
  left join ai_paths ap on ap.install_id = i.install_id
  left join struggles st on st.install_id = i.install_id
  left join nudge_groups ng on ng.install_id = i.install_id
  left join hook_counts hc on hc.install_id = i.install_id
  left join signin_shows ss on ss.install_id = i.install_id
  left join signin_cohorts sc on sc.install_id = i.install_id
  left join signin_clicks sk on sk.install_id = i.install_id
  left join signins si on si.install_id = i.install_id
  left join signin_closes sx on sx.install_id = i.install_id
  left join signin_unreach su on su.install_id = i.install_id
  left join ai_sources az on az.install_id = i.install_id
  where since is null or i.install_day >= since
  order by i.install_day, 1;
$$;

revoke all on function public.install_ledger(date, text) from public, anon, authenticated;

-- =============================================================================
-- SEVENTH EDITION (prepared 2026-11-23 for Companion 0.1.37, dictation). Deployed 2026-11-23.
-- Generated by make-seventh-edition.js from the sixth edition in schema.sql.
-- Paste this whole file into the live project's SQL editor, AFTER the sixth
-- edition (live), and BEFORE any build with dictation is released. Re-runnable.
--
-- It DROPS and recreates install_ledger(since, salt) (a return type cannot
-- change under CREATE OR REPLACE): the same thirty-six columns, then
--   dictate_arm            'on' | 'off' for Companion installs, from the install
--                          id: get_byte(sha256(install_id || '|dictate-0137'), 0) % 2 = 0
--                          is 'on' (the client's armOf(), companion/src/dictate.js);
--   dictation_asks         ask rows with props.feature = 'dictation', lifetime;
--   dictation_days_w1      days 0 to 6 with at least one dictation;
--   engaged_days_w1_nodict days 0 to 6 engaged, not counting dictation-only days.
-- asks_total and asks_failed no longer count dictation rows, so they keep their
-- pre-0.1.37 meaning (asks to the Knot); asks_by_feature shows 'dictation'.
--
-- No new event name and no new prop key: a dictation is an 'ask' row
-- {mode: 'voice', feature: 'dictation', outcome}, and the dictation tour card is
-- an 'onboarding_step' row {step: 'tour_dictate'}. The track function must learn
-- those two VALUES (server/track-index.ts.patch) or it answers 400 and the rows
-- are lost; the install-ledger function must pass the four columns through
-- (server/install-ledger-index.ts.patch). Deploy order: this SQL, then
-- `supabase functions deploy track --no-verify-jwt` and
-- `supabase functions deploy install-ledger --no-verify-jwt`, then the release.
-- =============================================================================

drop function if exists public.install_ledger(date, text);

create or replace function public.install_ledger(since date default null, salt text default null)
returns table (
  install_hash        text,
  product             text,
  install_day         date,
  last_open_day       date,
  days_opened         integer,
  opens_7d            integer,
  asks_total          integer,
  asks_by_feature     jsonb,
  asks_failed         integer,
  minutes_total       numeric,
  minutes_by_feature  jsonb,
  first_ask_delay_min integer,
  last_step           text,
  source              text,
  action_id           text,
  app_version         text,
  crashes             integer,
  dormant             boolean,
  first_version       text,
  first_win_delay_min integer,
  first_win_feature   text,
  engaged_days_w1     integer,
  engaged_days_28     integer,
  last_engaged_day    date,
  ai_ready_path       text,
  struggle            text,
  nudge_group         text,
  hooks_shown         jsonb,
  hooks_used          jsonb,
  signin_shown        integer,
  signin_cohort       text,
  signin_clicked      integer,
  signin_delay_min    integer,
  signin_closed       jsonb,
  signin_unreachable  integer,
  ai_source           text,
  dictate_arm         text,
  dictation_asks      integer,
  dictation_days_w1   integer,
  engaged_days_w1_nodict integer
)
language sql
stable
security definer
set search_path = public
as $$
  with excluded as (
    select x.install_id from public.owner_installs x
    union
    select distinct e.install_id from public.install_events e where (e.props->>'dev') = 'true'
  ),
  ev as (
    select e.*
    from public.install_events e
    where e.day < current_date
      and not exists (select 1 from excluded x where x.install_id = e.install_id)
  ),
  installs as (
    select distinct on (e.install_id)
           e.install_id, e.product, e.day as install_day, e.created_at as installed_at
    from ev e
    where e.name = 'install'
    order by e.install_id, e.created_at
  ),
  source_by_install as (
    select distinct on (e.install_id) e.install_id, e.props->>'source' as source
    from ev e
    where e.name = 'source_answer' and e.props ? 'source'
    order by e.install_id, e.created_at
  ),
  acq_by_install as (
    select distinct on (e.install_id) e.install_id, e.props->>'acq_action_id' as action_id
    from ev e
    where e.props ? 'acq_action_id' and coalesce(e.props->>'acq_action_id', '') <> ''
    order by e.install_id, e.created_at
  ),
  matches as (
    select m.install_id, m.action_id, m.tier
    from public.install_click_matches() m
  ),
  labelled as (
    select
      i.install_id,
      coalesce(
        abi.action_id,
        case when m.action_id <> '' then 'probable:' || m.action_id end,
        'source:' || sbi.source,
        case when m.tier = 'ambiguous' then 'ambiguous' end,
        ''
      ) as action_id,
      sbi.source
    from installs i
    left join acq_by_install abi on abi.install_id = i.install_id
    left join matches m on m.install_id = i.install_id
    left join source_by_install sbi on sbi.install_id = i.install_id
  ),
  opens as (
    select e.install_id,
           max(e.day) as last_open_day,
           count(distinct e.day)::integer as days_opened,
           (count(distinct e.day) filter (where e.day >= current_date - 7))::integer as opens_7d,
           bool_or(e.day >= current_date - 14) as opened_14d
    from ev e
    where e.name = 'app_open'
    group by 1
  ),
  asks as (
    select e.install_id,
           count(*)::integer as asks_total,
           (count(*) filter (where e.props ? 'outcome' and e.props->>'outcome' <> 'ok'))::integer as asks_failed,
           min(e.created_at) filter (where e.name = 'first_ask') as first_ask_at
    from ev e
    where e.name in ('ask', 'first_ask') and coalesce(e.props->>'feature', '') <> 'dictation'
    group by 1
  ),
  asks_feature as (
    select s.install_id, jsonb_object_agg(s.feature, s.n) as by_feature
    from (
      select e.install_id, e.props->>'feature' as feature, count(*) as n
      from ev e
      where e.name in ('ask', 'first_ask') and coalesce(e.props->>'feature', '') <> ''
      group by 1, 2
    ) s
    group by 1
  ),
  app_minutes as (
    select e.install_id, sum(coalesce(public.install_prop_num(e.props, 'minutes'), 0)) as minutes_total
    from ev e
    where e.name = 'app_session'
    group by 1
  ),
  minutes_feature as (
    select s.install_id, jsonb_object_agg(s.feature, s.minutes) as by_feature
    from (
      select e.install_id, e.props->>'feature' as feature,
             round(sum(coalesce(public.install_prop_num(e.props, 'seconds'), 0)) / 60.0) as minutes
      from ev e
      where e.name = 'feature_session' and coalesce(e.props->>'feature', '') <> ''
      group by 1, 2
    ) s
    group by 1
  ),
  steps as (
    select distinct on (e.install_id) e.install_id, e.props->>'step' as last_step
    from ev e
    where e.name = 'onboarding_step' and coalesce(e.props->>'step', '') <> ''
    order by e.install_id, e.created_at desc
  ),
  versions as (
    select distinct on (e.install_id) e.install_id, e.app_version
    from ev e
    where e.app_version is not null
    order by e.install_id, e.created_at desc
  ),
  crash_counts as (
    select e.install_id, count(*)::integer as crashes
    from ev e
    where e.name = 'crash'
    group by 1
  ),
  -- Fifth edition.
  first_versions as (
    select distinct on (e.install_id) e.install_id, e.app_version as first_version
    from ev e
    where e.app_version is not null
    order by e.install_id, e.created_at
  ),
  first_wins as (
    select distinct on (e.install_id) e.install_id, e.created_at as first_win_at,
           nullif(e.props->>'feature', '') as first_win_feature
    from ev e
    where e.name = 'first_win'
    order by e.install_id, e.created_at
  ),
  engaged as (
    select e.install_id,
           (count(distinct e.day) filter (where e.day >= i.install_day and e.day < i.install_day + 7))::integer as engaged_days_w1,
           (count(distinct e.day) filter (where e.day >= current_date - 28))::integer as engaged_days_28,
           max(e.day) as last_engaged_day
    from ev e
    join installs i on i.install_id = e.install_id
    where e.name = 'engaged'
    group by 1
  ),
  -- Seventh edition (Companion 0.1.37, dictation). Per install per day: did it
  -- dictate, and did it ask the Knot anything else.
  ask_days as (
    select e.install_id, e.day,
           bool_or(coalesce(e.props->>'feature', '') = 'dictation') as dictated,
           bool_or(coalesce(e.props->>'feature', '') <> 'dictation') as asked_other
    from ev e
    where e.name in ('ask', 'first_ask')
    group by 1, 2
  ),
  dictation as (
    select e.install_id, count(*)::integer as dictation_asks
    from ev e
    where e.name = 'ask' and e.props->>'feature' = 'dictation'
    group by 1
  ),
  -- Week 1 with and without dictation. A day counts "without" when it was
  -- engaged and was not a dictation-only day (dictated, asked nothing else).
  -- A dictation day where the person also used the tray or the dashboard is
  -- counted as dictation-only: "without" can only be too low, never padded.
  dictation_w1 as (
    select i.install_id,
           (count(distinct d.day) filter (where d.dictated and d.day >= i.install_day and d.day < i.install_day + 7))::integer as dictation_days_w1
    from installs i
    join ask_days d on d.install_id = i.install_id
    group by 1
  ),
  engaged_nodict as (
    select e.install_id,
           (count(distinct e.day) filter (where e.day >= i.install_day and e.day < i.install_day + 7
              and not coalesce(d.dictated and not d.asked_other, false)))::integer as engaged_days_w1_nodict
    from ev e
    join installs i on i.install_id = e.install_id
    left join ask_days d on d.install_id = e.install_id and d.day = e.day
    where e.name = 'engaged'
    group by 1
  ),
  ai_paths as (
    select distinct on (e.install_id) e.install_id, nullif(e.props->>'path', '') as ai_ready_path
    from ev e
    where e.name = 'ai_ready'
    order by e.install_id, e.created_at
  ),
  struggles as (
    select distinct on (e.install_id) e.install_id, e.props->>'struggle' as struggle
    from ev e
    where coalesce(e.props->>'struggle', '') <> ''
    order by e.install_id, e.created_at desc
  ),
  nudge_groups as (
    select distinct on (e.install_id) e.install_id, e.props->>'nudge_group' as nudge_group
    from ev e
    where coalesce(e.props->>'nudge_group', '') <> ''
    order by e.install_id, e.created_at desc
  ),
  hook_counts as (
    select s.install_id,
           jsonb_object_agg(s.hook, s.n) filter (where s.name = 'hook_shown') as shown,
           jsonb_object_agg(s.hook, s.n) filter (where s.name = 'hook_used') as used
    from (
      select e.install_id, e.name, e.props->>'hook' as hook, count(*) as n
      from ev e
      where e.name in ('hook_shown', 'hook_used') and coalesce(e.props->>'hook', '') <> ''
      group by 1, 2, 3
    ) s
    group by 1
  ),
  -- Sixth edition.
  signin_shows as (
    select e.install_id, count(*)::integer as signin_shown
    from ev e
    where e.name = 'signin_shown'
    group by 1
  ),
  signin_cohorts as (
    select distinct on (e.install_id) e.install_id, e.props->>'cohort' as signin_cohort
    from ev e
    where e.name = 'signin_shown' and coalesce(e.props->>'cohort', '') <> ''
    order by e.install_id, e.created_at
  ),
  signin_clicks as (
    select e.install_id, count(*)::integer as signin_clicked
    from ev e
    where e.name = 'signin_clicked'
    group by 1
  ),
  signins as (
    select distinct on (e.install_id) e.install_id, e.created_at as signin_at
    from ev e
    where e.name = 'signin' and e.props->>'method' = 'publik'
    order by e.install_id, e.created_at
  ),
  signin_closes as (
    select s.install_id, jsonb_object_agg(s.screen, s.n) as closed
    from (
      select e.install_id, coalesce(nullif(e.props->>'screen', ''), 'sign_in') as screen, count(*) as n
      from ev e
      where e.name = 'signin_closed'
      group by 1, 2
    ) s
    group by 1
  ),
  signin_unreach as (
    select e.install_id, count(*)::integer as signin_unreachable
    from ev e
    where e.name = 'signin_unreachable'
    group by 1
  ),
  ai_sources as (
    select distinct on (e.install_id) e.install_id, nullif(e.props->>'path', '') as ai_source
    from ev e
    where e.name = 'ai_source'
    order by e.install_id, e.created_at desc
  )
  select
    public.install_hash(i.install_id, salt) as install_hash,
    i.product,
    i.install_day,
    o.last_open_day,
    coalesce(o.days_opened, 0) as days_opened,
    coalesce(o.opens_7d, 0) as opens_7d,
    coalesce(a.asks_total, 0) as asks_total,
    coalesce(af.by_feature, '{}'::jsonb) as asks_by_feature,
    coalesce(a.asks_failed, 0) as asks_failed,
    coalesce(am.minutes_total, 0) as minutes_total,
    coalesce(mf.by_feature, '{}'::jsonb) as minutes_by_feature,
    case when a.first_ask_at is not null
         then floor(extract(epoch from (a.first_ask_at - i.installed_at)) / 60)::integer
    end as first_ask_delay_min,
    s.last_step,
    l.source,
    l.action_id,
    v.app_version,
    coalesce(c.crashes, 0) as crashes,
    not coalesce(o.opened_14d, false) as dormant,
    fv.first_version,
    case when fw.first_win_at is not null
         then floor(extract(epoch from (fw.first_win_at - i.installed_at)) / 60)::integer
    end as first_win_delay_min,
    fw.first_win_feature,
    coalesce(en.engaged_days_w1, 0) as engaged_days_w1,
    coalesce(en.engaged_days_28, 0) as engaged_days_28,
    en.last_engaged_day,
    ap.ai_ready_path,
    st.struggle,
    ng.nudge_group,
    coalesce(hc.shown, '{}'::jsonb) as hooks_shown,
    coalesce(hc.used, '{}'::jsonb) as hooks_used,
    coalesce(ss.signin_shown, 0) as signin_shown,
    sc.signin_cohort,
    coalesce(sk.signin_clicked, 0) as signin_clicked,
    case when si.signin_at is not null
         then greatest(0, floor(extract(epoch from (si.signin_at - i.installed_at)) / 60))::integer
    end as signin_delay_min,
    coalesce(sx.closed, '{}'::jsonb) as signin_closed,
    coalesce(su.signin_unreachable, 0) as signin_unreachable,
    az.ai_source,
    -- The split is worked out from the install id the server already keeps (no prop is sent):
    -- the client's companion/src/dictate.js armOf() is the same rule.
    case when i.product = 'companion' then
      case when get_byte(sha256(convert_to(i.install_id || '|dictate-0137', 'UTF8')), 0) % 2 = 0 then 'on' else 'off' end
    end as dictate_arm,
    coalesce(dc.dictation_asks, 0) as dictation_asks,
    coalesce(dw.dictation_days_w1, 0) as dictation_days_w1,
    coalesce(nd.engaged_days_w1_nodict, 0) as engaged_days_w1_nodict
  from installs i
  join labelled l on l.install_id = i.install_id
  left join opens o on o.install_id = i.install_id
  left join asks a on a.install_id = i.install_id
  left join asks_feature af on af.install_id = i.install_id
  left join app_minutes am on am.install_id = i.install_id
  left join minutes_feature mf on mf.install_id = i.install_id
  left join steps s on s.install_id = i.install_id
  left join versions v on v.install_id = i.install_id
  left join crash_counts c on c.install_id = i.install_id
  left join first_versions fv on fv.install_id = i.install_id
  left join first_wins fw on fw.install_id = i.install_id
  left join engaged en on en.install_id = i.install_id
  left join ai_paths ap on ap.install_id = i.install_id
  left join struggles st on st.install_id = i.install_id
  left join nudge_groups ng on ng.install_id = i.install_id
  left join hook_counts hc on hc.install_id = i.install_id
  left join signin_shows ss on ss.install_id = i.install_id
  left join signin_cohorts sc on sc.install_id = i.install_id
  left join signin_clicks sk on sk.install_id = i.install_id
  left join signins si on si.install_id = i.install_id
  left join signin_closes sx on sx.install_id = i.install_id
  left join signin_unreach su on su.install_id = i.install_id
  left join ai_sources az on az.install_id = i.install_id
  left join dictation dc on dc.install_id = i.install_id
  left join dictation_w1 dw on dw.install_id = i.install_id
  left join engaged_nodict nd on nd.install_id = i.install_id
  where since is null or i.install_day >= since
  order by i.install_day, 1;
$$;

revoke all on function public.install_ledger(date, text) from public, anon, authenticated;

-- =============================================================================
-- Eighth edition (2026-11-24): how a run of the Companion ended (Companion 0.1.38)
-- =============================================================================
-- Paste THIS block (from here to the end of the file) on its own into the live
-- project, after the seventh edition (live since 2026-11-23). Re-runnable. It
-- widens the install_events name check with one name, app_exit. Nothing else:
-- no table, no index, no function changes, no row is touched.
--   app_exit {reason}   how a run ended: quit (the person chose Quit), shutdown
--                       (Windows signing out or shutting down), update, uninstall
--                       (sent by the uninstaller's one run of the app), exam, other.
--                       A crash or a killed process sends none. Kept on the computer
--                       when there is no network, so it can arrive a day late.
-- The track function carries the name, the reason list (checked for app_exit
-- only) and one hook value, dictation_news. install_ledger and
-- install_daily_metrics are unchanged: read app_exit with a query for now.

-- 1. Event names. Same drop-every-check-on-name loop as the fifth and sixth editions.
do $$
declare c record;
begin
  for c in
    select conname
    from pg_constraint
    where conrelid = 'public.install_events'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%(name = ANY%'
  loop
    execute format('alter table public.install_events drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.install_events add constraint install_events_name_check
  check (name in (
    'install', 'app_open', 'source_answer', 'first_import', 'import', 'first_ask', 'ask',
    'key_connected', 'companion_session', 'signin', 'limit_hit', 'upgrade_click',
    'checkout_started', 'stats_off',
    'feature_session', 'app_session', 'onboarding_step', 'first_run_end', 'crash',
    'update_installed',
    'update_offered', 'notice_shown', 'notice_clicked',
    'first_win', 'engaged', 'ai_ready', 'hook_shown', 'hook_used',
    'signin_shown', 'signin_clicked', 'signin_closed', 'signin_unreachable', 'ai_source',
    -- Eighth edition, 2026-11-24 (Companion 0.1.38).
    'app_exit'            -- props.reason
  ));

-- =============================================================================
-- Tenth edition (2026-11-24): how long an answered ask took (Companion 0.1.40)
-- =============================================================================
-- Paste THIS block (from here to the end of the file) on its own into the live
-- project, after the eighth edition (live since 2026-11-23; the ninth edition was
-- track only). Re-runnable. It widens the install_events name check with one name,
-- ask_speed. Nothing else: no table, no index, no function changes, no row is touched.
--   ask_speed {feature, speed, gap}
--                       one row per answered ask, at most 20 per install per day:
--                       speed  seconds from the ask (key up, Enter) to the answer
--                              finished or the step pointed: under2, 2to4, 4to8,
--                              8to15, over15
--                       gap    minutes since the ask before it in the same run of
--                              the app: first (none since it started), under5,
--                              5to30, over30
--                       Nothing about what was asked or answered.
-- The track function carries the name, the two keys and their lists (both keys
-- on ask_speed only). install_ledger and install_daily_metrics are unchanged:
-- read ask_speed with a query for now.

-- 1. Event names. Same drop-every-check-on-name loop as the fifth, sixth and eighth editions.
do $$
declare c record;
begin
  for c in
    select conname
    from pg_constraint
    where conrelid = 'public.install_events'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%(name = ANY%'
  loop
    execute format('alter table public.install_events drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.install_events add constraint install_events_name_check
  check (name in (
    'install', 'app_open', 'source_answer', 'first_import', 'import', 'first_ask', 'ask',
    'key_connected', 'companion_session', 'signin', 'limit_hit', 'upgrade_click',
    'checkout_started', 'stats_off',
    'feature_session', 'app_session', 'onboarding_step', 'first_run_end', 'crash',
    'update_installed',
    'update_offered', 'notice_shown', 'notice_clicked',
    'first_win', 'engaged', 'ai_ready', 'hook_shown', 'hook_used',
    'signin_shown', 'signin_clicked', 'signin_closed', 'signin_unreachable', 'ai_source',
    -- Eighth edition, 2026-11-24 (Companion 0.1.38).
    'app_exit',           -- props.reason
    -- Tenth edition, 2026-11-24 (Companion 0.1.40).
    'ask_speed'           -- props.feature, props.speed, props.gap
  ));
