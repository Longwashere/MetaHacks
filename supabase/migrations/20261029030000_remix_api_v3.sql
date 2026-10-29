-- The v3 remix pipeline (agentic: paints, inspects and repaints until its checks pass).
alter table public.remix_jobs drop constraint if exists remix_jobs_api_version_check;
alter table public.remix_jobs add constraint remix_jobs_api_version_check check (api_version in ('v1', 'v2', 'v3'));
