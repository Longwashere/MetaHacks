-- Downloads: one row per user, asset and calendar month (UTC). Free users can download a few
-- distinct assets a month; downloading the same asset again that month is free.
-- record_download() checks the allowance and records the download in one transaction, so
-- concurrent requests can't go over the limit.

create table public.downloads (
  user_id uuid not null references public.profiles (id) on delete cascade,
  asset_id text not null references public.assets (id) on delete cascade,
  -- First day of the month the download counts against.
  period date not null,
  created_at timestamptz not null default now(),
  primary key (user_id, period, asset_id)
);

alter table public.downloads enable row level security;

-- Keeps assets.downloads in step: one per user per month.
create function public.downloads_count() returns trigger
language plpgsql set search_path = '' as $$
begin
  update public.assets set downloads = downloads + 1 where id = new.asset_id;
  return null;
end;
$$;

create trigger downloads_count
  after insert on public.downloads
  for each row execute function public.downloads_count();

-- Records a download if the user has allowance left (p_limit null = unlimited).
-- Returns whether it's allowed and how many distinct assets the user has downloaded this month.
create function public.record_download(p_user_id uuid, p_asset_id text, p_limit integer)
returns table (allowed boolean, used integer)
language plpgsql set search_path = '' as $$
declare
  v_period date := date_trunc('month', now() at time zone 'utc')::date;
  v_used integer;
begin
  -- Serialise each user's downloads so two at once can't both take the last one.
  perform 1 from public.profiles where id = p_user_id for update;

  select count(*) into v_used from public.downloads d where d.user_id = p_user_id and d.period = v_period;
  if exists (select 1 from public.downloads d where d.user_id = p_user_id and d.period = v_period and d.asset_id = p_asset_id) then
    return query select true, v_used;
    return;
  end if;
  if p_limit is not null and v_used >= p_limit then
    return query select false, v_used;
    return;
  end if;

  insert into public.downloads (user_id, asset_id, period) values (p_user_id, p_asset_id, v_period);
  return query select true, v_used + 1;
end;
$$;

revoke execute on function public.record_download(uuid, text, integer) from public, anon, authenticated;
