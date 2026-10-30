-- The live view's log of a v2 or v3 remix (RemixLive: events and the last preview), saved when the
-- job settles so the "What Muse is doing" tab can show it after the remix finishes.
alter table public.remix_jobs add column if not exists live jsonb;
