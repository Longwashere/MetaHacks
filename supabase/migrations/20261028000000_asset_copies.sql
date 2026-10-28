-- Copies: a user's own copy of someone else's remix, made without running a model.
-- The copy shares the source's storage keys (every save writes a new folder, so nothing is overwritten)
-- and keeps the source's remix_of, so part fixes still start from the original rig.
-- copy_of credits the remix it was copied from and lets the backend return an existing copy.

alter table public.assets
  add column copy_of text references public.assets (id) on delete set null,
  add column copy_of_name text;

create index assets_owner_copy_of on public.assets (owner_id, copy_of) where copy_of is not null;
