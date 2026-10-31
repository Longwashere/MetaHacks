-- What each remix job costs from the user's monthly credits (see CREDITS_PER_PAGE in
-- backend/src/lib/config.ts): a remix costs per atlas page it repaints (v1/v2 1, v3 2), a part fix 1.
-- Failed jobs cost nothing; the backend leaves them out of the sum.
alter table public.remix_jobs add column if not exists credits integer not null default 1 check (credits >= 0);

-- Past remixes, priced the same way from their base rig's page count. Part fixes keep 1.
update public.remix_jobs j
set credits = (case when j.api_version = 'v3' then 2 else 1 end)
  * greatest(coalesce(jsonb_array_length(a.files -> 'textures'), 1), 1)
from public.assets a
where a.id = j.base_asset_id
  and not (j.input ? 'regions');
