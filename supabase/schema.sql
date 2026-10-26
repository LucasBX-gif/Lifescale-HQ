-- Lifescale HQ database setup
-- Paste this whole file into Supabase: SQL Editor -> New query -> Run.
-- Safe to run more than once.

-- Profiles: one row per person, created automatically on sign up.
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  name text not null default 'Unnamed',
  timezone text not null default 'UTC',
  last_seen timestamptz,
  created_at timestamptz not null default now()
);

-- Daily logs: morning check-in, end of day notes, wins count.
create table if not exists public.daily_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  log_date date not null,
  focus text,
  notes text,
  wins integer not null default 0 check (wins >= 0),
  updated_at timestamptz not null default now(),
  unique (user_id, log_date)
);

-- Flow sessions: one row per finished timer run.
create table if not exists public.flow_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  task text,
  started_at timestamptz not null,
  ended_at timestamptz not null,
  seconds integer not null check (seconds >= 0 and seconds <= 43200),
  created_at timestamptz not null default now()
);

create index if not exists flow_sessions_user_started on public.flow_sessions (user_id, started_at);
create index if not exists daily_logs_user_date on public.daily_logs (user_id, log_date);

-- Create a profile automatically when someone signs up.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, name, timezone)
  values (
    new.id,
    coalesce(nullif(new.raw_user_meta_data ->> 'name', ''), split_part(new.email, '@', 1)),
    coalesce(nullif(new.raw_user_meta_data ->> 'timezone', ''), 'UTC')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Row level security: everyone signed in can see everything (it's just you two),
-- but you can only write your own rows.
alter table public.profiles enable row level security;
alter table public.daily_logs enable row level security;
alter table public.flow_sessions enable row level security;

drop policy if exists "profiles read" on public.profiles;
create policy "profiles read" on public.profiles for select to authenticated using (true);
drop policy if exists "profiles update own" on public.profiles;
create policy "profiles update own" on public.profiles for update to authenticated using (auth.uid() = id) with check (auth.uid() = id);

drop policy if exists "logs read" on public.daily_logs;
create policy "logs read" on public.daily_logs for select to authenticated using (true);
drop policy if exists "logs insert own" on public.daily_logs;
create policy "logs insert own" on public.daily_logs for insert to authenticated with check (auth.uid() = user_id);
drop policy if exists "logs update own" on public.daily_logs;
create policy "logs update own" on public.daily_logs for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "flow read" on public.flow_sessions;
create policy "flow read" on public.flow_sessions for select to authenticated using (true);
drop policy if exists "flow insert own" on public.flow_sessions;
create policy "flow insert own" on public.flow_sessions for insert to authenticated with check (auth.uid() = user_id);
drop policy if exists "flow delete own" on public.flow_sessions;
create policy "flow delete own" on public.flow_sessions for delete to authenticated using (auth.uid() = user_id);

-- Live updates when the other person logs something.
do $$
begin
  begin
    alter publication supabase_realtime add table public.daily_logs;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.flow_sessions;
  exception when duplicate_object then null;
  end;
end $$;
