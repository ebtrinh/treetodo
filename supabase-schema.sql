-- Run this once in the Supabase SQL editor (https://supabase.com/dashboard → SQL Editor).
-- Stores the whole tree as a single JSON blob per tree id.

create table if not exists public.trees (
  id text primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.trees enable row level security;

-- Personal single-user tool: allow the anon key full access to this table.
-- Tighten this (e.g. add auth + per-user rows) if the app ever goes multi-user.
drop policy if exists "public read"  on public.trees;
drop policy if exists "public write" on public.trees;
create policy "public read"  on public.trees for select using (true);
create policy "public write" on public.trees for all    using (true) with check (true);

-- Let the browser receive live updates when another device edits the tree.
alter publication supabase_realtime add table public.trees;
