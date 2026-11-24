-- =============================================================================
-- Accounts B, part b: user_settings, the few settings a person chose to sync
-- =============================================================================
-- Run after part a. Additive.
--
-- One row per account: settings is { key: { v, at } } for the allowlisted keys
-- only (companion/src/settings-sync.js KEYS), at = the client's time of the
-- change in ms. put_settings merges per key, the later `at` wins, and bumps
-- version. Never API keys, memory, paths, transcripts or chats: any other key
-- is refused. Hands syncs only as false.

create table if not exists public.user_settings (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  settings   jsonb not null default '{}'::jsonb,
  version    bigint not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.user_settings enable row level security;

drop policy if exists "user_settings: read own" on public.user_settings;
create policy "user_settings: read own"
  on public.user_settings for select
  using (auth.uid() = user_id);

-- Writes only through put_settings below.
revoke insert, update, delete on public.user_settings from anon, authenticated;

create or replace function public.put_settings(patch jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  me       uuid := auth.uid();
  allowed  text[] := array['ptt', 'voice', 'knotIsland', 'knotCorner', 'proactive', 'sounds', 'focusGuard', 'focusGuardFeeds', 'hands'];
  merged   jsonb;
  k        text;
  incoming jsonb;
  next_ver bigint;
begin
  if me is null then raise exception 'sign_in_required' using errcode = '28000'; end if;
  if patch is null or jsonb_typeof(patch) <> 'object' then raise exception 'bad_patch' using errcode = '22023'; end if;
  if octet_length(patch::text) > 8192 then raise exception 'too_large' using errcode = '22023'; end if;

  insert into public.user_settings (user_id) values (me) on conflict (user_id) do nothing;
  select us.settings into merged from public.user_settings us where us.user_id = me for update;

  for k, incoming in select key, value from jsonb_each(patch) loop
    if not (k = any (allowed)) then raise exception 'key_not_allowed' using errcode = '22023'; end if;
    if jsonb_typeof(incoming) <> 'object' or not (incoming ? 'v') or jsonb_typeof(incoming -> 'at') <> 'number' then
      raise exception 'bad_entry' using errcode = '22023';
    end if;
    if k = 'hands' and incoming -> 'v' <> 'false'::jsonb then raise exception 'hands_syncs_off_only' using errcode = '22023'; end if;
    if not (merged ? k) or (incoming ->> 'at')::numeric > (merged -> k ->> 'at')::numeric then
      merged := merged || jsonb_build_object(k, jsonb_build_object('v', incoming -> 'v', 'at', incoming -> 'at'));
    end if;
  end loop;

  update public.user_settings us
     set settings = merged, version = us.version + 1, updated_at = now()
   where us.user_id = me
  returning us.version into next_ver;

  return jsonb_build_object('settings', merged, 'version', next_ver);
end;
$$;

revoke all on function public.put_settings(jsonb) from public, anon;
grant execute on function public.put_settings(jsonb) to authenticated;
