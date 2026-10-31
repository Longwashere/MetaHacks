-- Categories are open: admin uploads let Muse Spark pick a category per rig, and it may add a new
-- one when none of the existing ones fit (backend/src/lib/upload-tags.ts). Any lowercase slug is
-- allowed; the five original categories stay the built-in ones the UI always shows.
alter table assets drop constraint if exists assets_category_check;
alter table assets add constraint assets_category_check
  check (category ~ '^[a-z]([a-z0-9-]{0,22}[a-z0-9])?$');
