-- Team goal (v0.8). Paste into Supabase: SQL Editor -> New query -> Run (choose "Run without RLS").
create table if not exists public.team_goals (
  id uuid primary key default gen_random_uuid(),
  period text not null unique,          -- YYYY-MM
  title text not null default 'Clients signed',
  target integer not null default 5 check (target > 0),
  progress integer not null default 0 check (progress >= 0),
  updated_by uuid references public.profiles (id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table public.team_goals enable row level security;

drop policy if exists "goals read" on public.team_goals;
create policy "goals read" on public.team_goals for select to authenticated using (true);
drop policy if exists "goals insert" on public.team_goals;
create policy "goals insert" on public.team_goals for insert to authenticated with check (true);
drop policy if exists "goals update" on public.team_goals;
create policy "goals update" on public.team_goals for update to authenticated using (true) with check (true);

alter publication supabase_realtime add table public.team_goals;
