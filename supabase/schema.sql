-- Wakbu Slime — Supabase schema
-- Run this in the Supabase SQL editor (Project → SQL → New query).
-- Safe to re-run: uses IF NOT EXISTS / OR REPLACE where possible.

-- ─── profiles ─────────────────────────────────────────────
-- Mirrors auth.users. `is_premium` and `premium_expires_at` are kept in
-- sync by the RevenueCat webhook (see edge function below).
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  display_name text,
  avatar_url text,
  is_premium boolean not null default false,
  premium_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "profiles are self-readable" on public.profiles;
create policy "profiles are self-readable"
  on public.profiles for select
  using (auth.uid() = id);

drop policy if exists "profiles are self-updatable" on public.profiles;
create policy "profiles are self-updatable"
  on public.profiles for update
  using (auth.uid() = id);

-- Auto-create a profile row on first sign-in.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, display_name, avatar_url)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'name', new.raw_user_meta_data->>'full_name'),
    new.raw_user_meta_data->>'avatar_url'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ─── daily_usage ──────────────────────────────────────────
-- One row per (user, day-in-KST). Server-authoritative so clients can't
-- cheat the free-tier cap by clearing local storage.
create table if not exists public.daily_usage (
  user_id uuid not null references auth.users (id) on delete cascade,
  usage_date date not null,
  count integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, usage_date)
);

alter table public.daily_usage enable row level security;

drop policy if exists "daily_usage self-read" on public.daily_usage;
create policy "daily_usage self-read"
  on public.daily_usage for select
  using (auth.uid() = user_id);

-- Atomic increment RPC. Returns { count, usage_date } for today (KST).
-- Premium users still increment (useful for analytics) but the client
-- ignores the limit for them.
create or replace function public.increment_daily_usage()
returns table (count integer, usage_date date)
language plpgsql
security definer
set search_path = public
as $$
declare
  today_kst date := (now() at time zone 'Asia/Seoul')::date;
  new_count integer;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  insert into public.daily_usage (user_id, usage_date, count)
  values (auth.uid(), today_kst, 1)
  on conflict (user_id, usage_date)
  do update set count = public.daily_usage.count + 1, updated_at = now()
  returning public.daily_usage.count into new_count;

  return query select new_count, today_kst;
end;
$$;

grant execute on function public.increment_daily_usage() to authenticated;

-- Read-only helper: today's count without incrementing.
create or replace function public.get_daily_usage()
returns table (count integer, usage_date date)
language plpgsql
security definer
set search_path = public
as $$
declare
  today_kst date := (now() at time zone 'Asia/Seoul')::date;
  cur integer;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  select du.count into cur
  from public.daily_usage du
  where du.user_id = auth.uid() and du.usage_date = today_kst;

  return query select coalesce(cur, 0), today_kst;
end;
$$;

grant execute on function public.get_daily_usage() to authenticated;

-- ─── delete_current_user ──────────────────────────────────
-- Lets the signed-in user permanently delete their own auth.users row.
-- profiles + daily_usage are cascaded via their FK (on delete cascade),
-- so no manual cleanup needed. RevenueCat side is unaffected; call
-- Purchases.logOut() from the client after invoking this to detach the
-- anonymous customer.
create or replace function public.delete_current_user()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  delete from auth.users where id = auth.uid();
end;
$$;

grant execute on function public.delete_current_user() to authenticated;
