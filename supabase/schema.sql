-- Run this once in your Supabase project's SQL Editor (Supabase dashboard →
-- SQL Editor → New query → paste this → Run). Creates everything the app needs.
-- Safe to re-run — every statement below is idempotent (IF NOT EXISTS / ON CONFLICT).

create table if not exists liked_movies (
  id bigint generated always as identity primary key,
  tmdb_id integer unique not null,
  title text not null,
  year text,
  poster_path text,
  source text default 'manual',              -- 'manual' or 'letterboxd'
  letterboxd_rating numeric,                  -- 0.5-5.0 if imported from ratings.csv
  status text default 'liked',                -- 'liked' or 'watched'
  liked_at timestamptz default now(),
  last_known_provider_ids jsonb default '[]', -- provider_ids last seen as available on ANY service
  notified_available boolean default false    -- true once we've emailed about the current availability
);

create table if not exists my_services (
  provider_id integer primary key,
  provider_name text not null,
  logo_path text,
  selected boolean default false   -- true = "I actually subscribe to / have access to this"
);

-- Tracks which horror movies were streamable on your selected services as of
-- the last weekly check, so we can diff and find what's newly available.
create table if not exists horror_seen (
  tmdb_id integer primary key,
  title text not null,
  year text,
  poster_path text,
  first_seen_at timestamptz default now()
);

create table if not exists digest_log (
  id bigint generated always as identity primary key,
  sent_at timestamptz default now(),
  horror_count integer default 0,
  rec_count integer default 0,
  recipient text
);

-- Starter seed of common US streaming services so Settings isn't empty.
-- TMDb provider_ids are stable; this is a convenience seed, not a limit —
-- the app can also pull TMDb's full live provider list (see /api/services/expand).
insert into my_services (provider_id, provider_name, selected) values
  (8, 'Netflix', false),
  (9, 'Amazon Prime Video', false),
  (337, 'Disney Plus', false),
  (15, 'Hulu', false),
  (1899, 'Max', false),
  (350, 'Apple TV Plus', false),
  (531, 'Paramount Plus', false),
  (386, 'Peacock Premium', false),
  (73, 'Tubi', false),
  (300, 'Pluto TV', false),
  (613, 'Amazon Freevee', false),
  (257, 'Fubo', false),
  (43, 'Starz', false),
  (37, 'Showtime', false)
on conflict (provider_id) do nothing;


-- TMDb API terms: TMDb data may not be cached longer than 6 months, so the app
-- records when each row's TMDb data was last refreshed and refreshes or removes stale rows.
alter table horror_seen add column if not exists last_seen_at timestamptz default now();
alter table liked_movies add column if not exists tmdb_refreshed_at timestamptz default now();
alter table my_services add column if not exists tmdb_refreshed_at timestamptz default now();
