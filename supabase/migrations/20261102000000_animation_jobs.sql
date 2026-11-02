-- Animation jobs: one row per generated animation or animation edit a user starts. They count
-- toward the monthly credits next to remix_jobs. A job reserves the minimum credit while it runs;
-- when it settles, credits is set from Muse's reported token use (see meteredCredits in
-- backend/src/lib/billing.ts). Failed jobs cost nothing; the backend leaves them out of the sum.
create table public.animation_jobs (
  id text primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  asset_id text references public.assets (id) on delete set null,
  kind text not null check (kind in ('new', 'edit')),
  -- The animation edited, or the one a new job made (null until it's saved).
  animation text,
  status text not null default 'running' check (status in ('running', 'succeeded', 'failed')),
  credits integer not null default 1 check (credits >= 0),
  -- What the job's Muse calls cost in USD at the configured rates, and the token counts behind it.
  cost_usd numeric(12, 6),
  usage jsonb,
  error text,
  created_at timestamptz not null default now()
);

create index animation_jobs_user_created on public.animation_jobs (user_id, created_at desc);

alter table public.animation_jobs enable row level security;
