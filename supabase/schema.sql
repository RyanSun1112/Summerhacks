-- Pulse venue ownership (option a): venues stay as JSON files in venues/;
-- this table only maps venue_id -> Supabase auth user id.
-- Run in the Supabase SQL editor once per project.

create table if not exists public.venue_owners (
  venue_id   text primary key,
  owner_id   uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

create index if not exists venue_owners_owner_id_idx
  on public.venue_owners (owner_id);

-- Server uses the service role key for all reads/writes to this table.
-- Keep RLS on so the anon key can never touch ownership from the browser.
alter table public.venue_owners enable row level security;

-- No policies for anon/authenticated — intentional. Clients never query this
-- table directly; Express does via SUPABASE_SERVICE_ROLE_KEY.
