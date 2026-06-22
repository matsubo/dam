-- 0035: patch 鶏知ダム (slug=kechi-42) to add nagasaki-kasen external_id.
--
-- Migration 0029 tried to INSERT 'け知' with dam_cd=2030, but the master seed
-- already had 'kechi-42' as '鶏知' (kanji variant), so ON CONFLICT DO NOTHING
-- silently skipped the insert.  Name-based matching cannot bridge け知↔鶏知.
-- This migration adds the external_id to the existing row so the
-- external_id-first lookup in ingest_nagasaki_kasen.ts can find it.
UPDATE dams
SET external_ids = external_ids || '{"nagasaki-kasen": "2030"}'::jsonb
WHERE slug = 'kechi-42'
  AND NOT (external_ids ? 'nagasaki-kasen');
