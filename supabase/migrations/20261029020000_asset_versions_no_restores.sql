-- Restores no longer add a version: they only make an earlier part fix (or the original) current,
-- and every state they can bring back is already listed. Drop the restore rows written so far.

delete from public.asset_versions where kind = 'restore';

alter table public.asset_versions drop constraint asset_versions_kind_check;
alter table public.asset_versions add constraint asset_versions_kind_check check (kind = 'part_fix');
