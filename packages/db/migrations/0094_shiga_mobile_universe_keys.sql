-- 0094: drop shiga-bousai's four hand-typed universe keys.
--
-- ingest_shiga used to read the desktop /dam/dam_table.php, which
-- shiga-bousai.jp/robots.txt disallows ("Disallow: /dam/", "allow: /mobile/").
-- It now reads /mobile/dam/dam_select.php, whose 観測局一覧 names every station
-- as the portal prints it, and records that list as the universe.
--
-- The old task could not see 天川 / 犬上川 / 蔵王 / 野洲川 (the desktop page
-- linked them out to river.go.jp), so it recorded them under hand-typed keys
-- without the ダム suffix and never resolved them. The mobile list publishes
-- them as 天川ダム / 犬上川ダム / 蔵王ダム / 野洲川ダム, which the task now
-- records (蔵王 / 野洲川（再） / 犬上川 resolve to their masters). recordUniverse
-- only upserts, so the old keys would otherwise stay forever as unresolved
-- stations and inflate coverageSummary().unmatchedStations. 余呉湖 keeps its
-- key (the list prints it without ダム) and is not touched.
--
-- Prod dry run (2026-09-27): exactly these 4 rows, all resolved_dam_id NULL,
-- first_seen 2026-09-10 02:53 UTC:
--   SELECT source_external_id, resolved_dam_id FROM source_universe
--   WHERE source_id = 'shiga-bousai'
--     AND source_external_id IN ('天川', '犬上川', '蔵王', '野洲川');
--
-- Idempotent; a no-op on a fresh database.
DELETE FROM source_universe
WHERE source_id = 'shiga-bousai'
  AND source_external_id IN ('天川', '犬上川', '蔵王', '野洲川')
  AND resolved_dam_id IS NULL;
