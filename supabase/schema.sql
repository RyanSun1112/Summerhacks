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

-- ---------------------------------------------------------------- captures
-- Permanent city-wide vibe captures. Photo bytes live in Storage; this table
-- holds the public URL + the live crowd reading frozen at capture time.
-- Run this whole file (or just the new block) in the Supabase SQL editor.

create table if not exists public.captures (
  id          uuid primary key default gen_random_uuid(),
  venue_id    text not null,
  venue_name  text not null,
  lat         double precision,
  lon         double precision,
  photo_url   text not null,
  energy      double precision not null,
  sync        double precision not null,
  arousal     double precision not null,
  vibe_label  text not null check (vibe_label in ('hype', 'calm', 'mixed')),
  captured_by text,
  zone_id     text,                              -- attendee zone at capture time
  created_at  timestamptz not null default now()
);

-- Existing projects that already ran the earlier schema:
alter table public.captures add column if not exists zone_id text;

create index if not exists captures_created_at_idx
  on public.captures (created_at desc);

create index if not exists captures_venue_id_idx
  on public.captures (venue_id);

alter table public.captures enable row level security;

-- Same pattern as venue_owners: no anon/authenticated policies. Express
-- reads/writes via SUPABASE_SERVICE_ROLE_KEY; city.html hits our API only.

-- Public photo bucket. Photos must survive server restarts and load by URL
-- on the city map without proxying through Node.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'captures',
  'captures',
  true,
  5242880,
  array['image/png', 'image/jpeg', 'image/webp']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Anyone can read capture photos (public artifact). Writes stay service-role.
drop policy if exists "Public read capture photos" on storage.objects;
create policy "Public read capture photos"
  on storage.objects for select
  using (bucket_id = 'captures');
