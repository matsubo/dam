-- 0186: 西紀 (NDI 1368) and 栗柄 (kurisugara-28) are one dam; merge them.
--
-- Evidence, fetched 2026-09-28:
--   ダム便覧 3234  https://dambinran.damnet.or.jp/dams/japan/3234/
--     栗柄ダム（くりから）, 旧名 西紀ダム: 「ダム名は西紀ダムだったが、兵庫県の
--     公表資料では、平成27年5月24日の竣工式の時には栗柄ダムという名称になって
--     いた」. 兵庫県篠山市栗柄, 北緯35度8分15秒 東経135度13分25秒, 由良川水系
--     滝の尻川, 26.7 m / 172 m, 383 / 356 千m³, FNW.
--   NDI W01 (W01-14, W01_002 = 1368)  西紀, 由良川 / 滝の尻川, 26.7 m, 堤頂長
--     172.0 m, 383 千m³, 2013, 兵庫県篠山市栗柄 — the dam under its project name;
--     the survey predates the 2015 renaming.
--   兵庫県「西紀生活貯水池 計画概要」 web.pref.hyogo.lg.jp/ks04/documents/
--     h22fk-01-nishikisekatsuchosuichikensetsujigyo-nishikidam3.pdf
--     西紀ダム at 西紀町（現篠山市）栗柄 on 滝の尻川, 総貯水容量 383,000 m³, 有効
--     356,000 m³, 常時満水位 EL.286.8 — the level hyogo-bodik and kasenbosai
--     report for 栗柄 (286.86 m, 0132).
--
-- kurisugara-28 stays (prod id 14563): the SEO-indexed page, damnet 3234, the
-- hyogo-bodik and kasenbosai stamps and every observation. The NDI row
-- (dam-1368-28, prod id 10276) has no observations, no stamp but its NDI key
-- and no source_universe / match_review reference (prod, 2026-09-28).
--
-- Retired the way 0083 retires a row: deleted once nothing needs it. Here
-- that means no observations and nothing in external_ids but `ndi`; if either
-- stops holding, the row stays and kurisugara-28 does not take the NDI key
-- (dams_ext_ndi_uniq). A source_universe / match_review reference is moved to
-- kurisugara-28 first rather than left to ON DELETE SET NULL; backfill_progress
-- cascades. Its page 404s from then on, like nakazato-20's.
--
-- With `ndi` = 1368 on kurisugara-28 nothing re-creates the row: the boot-time
-- seed (master_upsert.sql) and upsertDamByNdi both match by the NDI key, and
-- neither rewrites an existing row's name or location, so a W01 re-import
-- leaves it 栗柄 at the point set below.
--
-- Location: 0034 put 栗柄 at 135.072 E 35.082 N, 15 km west of the dam. It
-- goes to ダム便覧's point, 117 m from kasenbosai station 0716900700021. NDI's
-- point (135.22645 E 35.14312 N) is not used: it is 675 m north, on ground at
-- 298.4 m (GSI DEM), above the dam's crest (EL.266.0 base + 26.7 m). elevation_m
-- is what master:refresh:elevation stores for the new point
-- (cyberjapandata2.gsi.go.jp getelevation.php?lon=135.2236111&lat=35.1375 →
-- 279); set here because the seed would fill a NULL with the NDI row's 298.4.
-- The watershed is 由良川 (0034's 加古川 was wrong), as on the NDI row.
--
-- 0034's other guesses (40 m, 1961) are replaced by W01 / ダム便覧's values on
-- a database where master:refresh:damnet has not already done so.

CREATE TEMP TABLE nishiki AS
SELECT n.id AS retired, k.id AS kept
FROM dams n
JOIN dams k ON k.slug = 'kurisugara-28' AND k.name = '栗柄'
WHERE n.external_ids->>'ndi' = '1368' -- 西紀
  AND n.id <> k.id
  AND n.external_ids - 'ndi' = '{}'::jsonb
  AND NOT EXISTS (SELECT 1 FROM observations o WHERE o.dam_id = n.id);

UPDATE source_universe su
SET resolved_dam_id = t.kept
FROM nishiki t
WHERE su.resolved_dam_id = t.retired;

UPDATE match_review mr
SET best_dam_id     = CASE WHEN mr.best_dam_id = t.retired THEN t.kept ELSE mr.best_dam_id END,
    resolved_dam_id = CASE WHEN mr.resolved_dam_id = t.retired THEN t.kept ELSE mr.resolved_dam_id END
FROM nishiki t
WHERE t.retired IN (mr.best_dam_id, mr.resolved_dam_id);

DELETE FROM dams d
USING nishiki t
WHERE d.id = t.retired;

DROP TABLE nishiki;

UPDATE dams
SET external_ids = external_ids || '{"ndi": "1368"}'::jsonb
WHERE slug = 'kurisugara-28'
  AND name = '栗柄'
  AND NOT (external_ids ? 'ndi')
  AND NOT EXISTS (SELECT 1 FROM dams o WHERE o.external_ids->>'ndi' = '1368');

UPDATE dams
SET location     = ST_SetSRID(ST_MakePoint(135.2236111, 35.1375), 4326)::geography,
    elevation_m  = 279,
    watershed_id = COALESCE((SELECT id FROM watersheds WHERE code = 'W01-由良川'), watershed_id)
WHERE slug = 'kurisugara-28'
  AND name = '栗柄';

UPDATE dams
SET height_m          = 26.7,
    completed_year    = 2013,
    total_capacity_m3 = COALESCE(total_capacity_m3, 383000)
WHERE slug = 'kurisugara-28'
  AND height_m = 40.0
  AND completed_year = 1961;
