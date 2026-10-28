-- RigForge schema. Only the backend (service-role key) reads and writes these tables:
-- RLS is on with no policies, so the public anon key can't touch them.
-- File columns hold storage keys (e.g. "spine/spineboy/Spineboy.atlas"), not URLs; the backend
-- turns them into URLs, so moving the bucket to another domain is a config change.

-- ---------------------------------------------------------------------------
-- Profiles: one per auth user, plus their subscription state (written by the Stripe webhook)
-- ---------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  name text not null default '',
  avatar_url text,
  stripe_customer_id text unique,
  plan text not null default 'free' check (plan in ('free', 'pro')),
  subscription_id text,
  subscription_status text,
  current_period_end timestamptz,
  created_at timestamptz not null default now()
);

-- Google sign-in fills raw_user_meta_data with full_name / name and avatar_url / picture.
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, name, avatar_url)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name', split_part(new.email, '@', 1), ''),
    coalesce(new.raw_user_meta_data ->> 'avatar_url', new.raw_user_meta_data ->> 'picture')
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Assets: official rigs (owner_id null) and user remixes
-- ---------------------------------------------------------------------------
create table public.assets (
  id text primary key,
  owner_id uuid references public.profiles (id) on delete cascade,
  author_id text not null,
  author_name text not null,
  name text not null,
  description text not null default '',
  category text not null check (category in ('character', 'creature', 'effect', 'prop', 'ui')),
  style text not null check (style in ('cartoon', 'anime', 'pixel', 'painterly', 'flat')),
  tags text[] not null default '{}',
  prompt text,
  remix_of text references public.assets (id) on delete set null,
  remix_of_name text,
  visibility text not null default 'private' check (visibility in ('public', 'private')),
  spine_version text not null,
  bone_count integer not null default 0,
  slot_count integer not null default 0,
  animations jsonb not null default '[]',
  accent text not null,
  downloads integer not null default 0,
  saves integer not null default 0,
  thumbnail_url text,
  -- { skeleton, atlas, textures[], premultipliedAlpha, skin } as storage keys; null = no files yet
  files jsonb,
  -- Mock-only colour wash used by a few seeded demo remixes
  tint text,
  -- Lower-cased name, description, prompt and tags, kept up to date by a trigger, for search
  search_text text not null default '',
  created_at timestamptz not null default now()
);

create index assets_public_saves on public.assets (saves desc) where visibility = 'public';
create index assets_public_created on public.assets (created_at desc) where visibility = 'public';
create index assets_owner on public.assets (owner_id, created_at desc);
create index assets_remix_of on public.assets (remix_of);

create function public.assets_search_text() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.search_text := lower(concat_ws(' ', new.name, new.description, new.prompt, array_to_string(new.tags, ' ')));
  return new;
end;
$$;

create trigger assets_search_text
  before insert or update of name, description, prompt, tags on public.assets
  for each row execute function public.assets_search_text();

-- ---------------------------------------------------------------------------
-- Library: assets a user has bookmarked
-- ---------------------------------------------------------------------------
create table public.library (
  user_id uuid not null references public.profiles (id) on delete cascade,
  asset_id text not null references public.assets (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, asset_id)
);

create index library_user_created on public.library (user_id, created_at desc);

-- Keeps assets.saves in step with the library.
create function public.library_saves() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    update public.assets set saves = saves + 1 where id = new.asset_id;
  else
    update public.assets set saves = greatest(saves - 1, 0) where id = old.asset_id;
  end if;
  return null;
end;
$$;

create trigger library_saves
  after insert or delete on public.library
  for each row execute function public.library_saves();

-- ---------------------------------------------------------------------------
-- Remix jobs: one row per remix a user starts; also the monthly usage count
-- ---------------------------------------------------------------------------
create table public.remix_jobs (
  id text primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  base_asset_id text references public.assets (id) on delete set null,
  api_version text not null check (api_version in ('v1', 'v2')),
  input jsonb not null,
  status text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'failed')),
  error text,
  edit_prompt text,
  prompt_status text not null default 'original',
  asset_id text references public.assets (id) on delete set null,
  created_at timestamptz not null default now()
);

create index remix_jobs_user_created on public.remix_jobs (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Lock everything down to the service role
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.assets enable row level security;
alter table public.library enable row level security;
alter table public.remix_jobs enable row level security;
