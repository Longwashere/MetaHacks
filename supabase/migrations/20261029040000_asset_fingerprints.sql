-- Fingerprints of rigs (uploads, official rigs and remixes), so the same rig isn't uploaded twice
-- (backend/src/lib/uploads.ts). Every save that changes an asset's files updates them.
-- art_hash covers the page PNGs; rig_hash covers the skeleton JSON without its export-only fields.
-- An upload matching both hashes of a public rig or remix, or of one of the uploader's own, is rejected.
-- One that reuses someone else's art stays private. based_on credits the rig an upload shares its
-- art or skeleton with. Existing rows are filled in by `npm run backfill:fingerprints -w backend`.

alter table public.assets
  add column art_hash text,
  add column rig_hash text,
  add column based_on text references public.assets (id) on delete set null,
  add column based_on_name text;

create index assets_art_hash on public.assets (art_hash) where art_hash is not null;
create index assets_rig_hash on public.assets (rig_hash) where rig_hash is not null;
-- Two uploads of the same rig by one user at the same moment: the second insert fails. Originals
-- only: a copy shares its source's files, and remixes can legitimately end up identical.
create unique index assets_owner_fingerprint on public.assets (owner_id, art_hash, rig_hash)
  where remix_of is null and art_hash is not null;
