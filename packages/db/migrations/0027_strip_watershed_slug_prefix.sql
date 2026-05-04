-- Drop the redundant `watershed-` prefix from watershed slugs. The URL is
-- already namespaced under /watersheds/, so a slug of `watershed-賀茂川`
-- produces an ugly `/watersheds/watershed-賀茂川` URL. We want
-- `/watersheds/賀茂川`.
--
-- The unique constraint on `slug` means we have to skip any rare collision
-- (a row whose stripped form already exists). In practice this never happens
-- because every prefixed slug used the format `watershed-{name}` and the
-- non-prefixed sibling didn't exist. Belt and braces, the WHERE clause
-- excludes those.
UPDATE watersheds w
SET slug = REGEXP_REPLACE(slug, '^watershed-', '')
WHERE slug LIKE 'watershed-%'
  AND NOT EXISTS (
    SELECT 1 FROM watersheds w2
    WHERE w2.slug = REGEXP_REPLACE(w.slug, '^watershed-', '')
  );
