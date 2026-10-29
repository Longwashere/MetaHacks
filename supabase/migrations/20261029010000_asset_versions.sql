-- Version history for remixes: one row per change to a remix's files (a part fix, or a restore of
-- an earlier version). Every save writes new storage folders and never deletes old ones, so the
-- files a row points to stay valid. Restoring makes an earlier row's files current again and
-- records itself as a new row, so a restore can be undone too.

create table public.asset_versions (
  id text primary key,
  asset_id text not null references public.assets (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null check (kind in ('part_fix', 'restore')),
  -- The part fix's remix_jobs row (part_fix only).
  job_id text references public.remix_jobs (id) on delete set null,
  -- What the user asked for (part_fix), or the label of the version restored (restore).
  label text not null,
  -- Regions repainted (part_fix), and the subset whose meshes were swapped for boxes.
  regions text[] not null default '{}',
  boxed text[] not null default '{}',
  -- assets.files before and after the change.
  files_before jsonb not null,
  files_after jsonb not null,
  created_at timestamptz not null default now()
);

create index asset_versions_asset_created on public.asset_versions (asset_id, created_at desc);

alter table public.asset_versions enable row level security;
