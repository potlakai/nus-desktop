-- =============================================================================
-- Accounts B, part a (2026-10-31 ruling, docs/accounts-b.md in nus-desktop-day1)
-- install_links: which anonymous install ids a signed-in person linked
-- =============================================================================
-- Run once in the SQL editor of project xnpkplcjurzwanotmwwt, after
-- schema.sql. Additive: no existing table, function or policy changes.
--
-- A row exists only because the person signed in on that computer, with stats
-- on, after reading the consent line on the Account card; consent_version
-- names the words they saw. The link is the only place an install id meets an
-- account: install_events stays keyed by the random install id and is not
-- touched. Unlink deletes the row; deleting the account cascades it away, and
-- that install's stats are anonymous again.
--
-- One account per install: signing in with another Google account on the same
-- computer moves the link. The writer is the link-install Edge Function
-- (service role); a client can read its own rows and nothing else.

create table if not exists public.install_links (
  install_id      uuid primary key,
  user_id         uuid not null references auth.users(id) on delete cascade,
  product         text not null default 'companion' check (product in ('companion', 'desktop')),
  consent_version text not null check (char_length(consent_version) between 1 and 20),
  app_version     text check (app_version is null or char_length(app_version) <= 40),
  linked_at       timestamptz not null default now()
);

create index if not exists install_links_user_idx on public.install_links (user_id);

alter table public.install_links enable row level security;

drop policy if exists "install_links: read own" on public.install_links;
create policy "install_links: read own"
  on public.install_links for select
  using (auth.uid() = user_id);

-- No insert, update or delete policy on purpose: link-install is the only
-- writer, so a client cannot attach an arbitrary install id or a consent
-- version that was never shown.
revoke insert, update, delete on public.install_links from anon, authenticated;

-- The founder view later (dashboard spec, Users screen): linked installs per
-- account with their device rows. Service role only; never exposed to clients.
create or replace view public.linked_installs
with (security_invoker = true) as
  select l.user_id, l.install_id, l.product, l.consent_version, l.app_version, l.linked_at,
         d.os, d.last_seen
  from public.install_links l
  left join public.devices d on d.user_id = l.user_id and d.device_id = l.install_id::text;

revoke all on public.linked_installs from anon, authenticated;
