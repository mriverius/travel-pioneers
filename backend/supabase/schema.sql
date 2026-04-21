-- Travel Pioneers — users schema (final shape, no company column).
--
-- This is kept as a convenient one-shot bootstrap for fresh Supabase
-- projects. If you're using Prisma migrations (`npm run prisma:migrate`)
-- you do NOT need to run this by hand — Prisma will apply the migrations
-- in `prisma/migrations/` instead.

create extension if not exists "pgcrypto";

do $$
begin
  if not exists (select 1 from pg_type where typname = 'Role') then
    create type "Role" as enum ('admin', 'member');
  end if;
end$$;

create table if not exists public.users (
  id              uuid primary key default gen_random_uuid(),
  name            text           not null,
  email           text           not null unique,
  password_hash   text           not null,
  role            "Role"         not null default 'member',
  views           text[]         not null default array['supplier-intelligence']::text[],
  last_login_at   timestamptz(6),
  created_at      timestamptz(6) not null default now(),
  updated_at      timestamptz(6) not null default now()
);

create index if not exists users_email_idx on public.users (email);

-- Row Level Security: the backend uses its own Postgres role and bypasses
-- RLS. We still enable it so accidental client-side access is denied.
alter table public.users enable row level security;
