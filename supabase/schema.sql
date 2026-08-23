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
