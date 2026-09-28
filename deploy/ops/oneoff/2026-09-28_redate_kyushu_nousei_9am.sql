-- One-off (prod, after the ingest_kyushu_nousei per-block hour fix is
-- deployed): move the kyushu-nousei rows of the 佐賀, 熊本, 大分 and 宮崎
-- blocks from JST midnight to 09:00 JST on the same survey date.
--
-- Run once; the file is its own transaction (BEGIN … COMMIT):
--   psql -U dam -d dam -v ON_ERROR_STOP=1 -f 2026-09-28_redate_kyushu_nousei_9am.sql
-- Not a migration: it re-dates observations rows, which may sit in
-- compressed chunks by the time it runs.
--
-- The 九州農政局 PDF prints only the survey date, and the adapter stamped
-- every row at JST midnight (15:00Z the day before). The 11 survey columns of
-- the R8.9.15 table (4/15–9/15) were compared with prod's hourly feeds for
-- the same dams (2026-09-28):
--
--   block   matches at 15:00Z only   at 00:00Z only   e.g.
--   福岡            38                     0          江川 9/15 4,652 = fukuoka-bodik 09-14T15:00Z
--   佐賀             0                    11          厳木 9/15 3,553 = kasenbosai 09-15T00:00Z
--   熊本             0                    18          市房 9/15 4,371 = kumamoto-bousai 09-15T00:00Z
--                                                     (its 15:00Z value was 4,443)
--   大分             0                    10          石場 886, 深見 741, 日指 1,014, 並石 448 =
--                                                     oita-nourin's 「9：00現在」 rows; 耶馬渓 vs kasenbosai
--   宮崎    other volume basis; an affine fit of 田代八重/立花/綾北 against
--           kasenbosai leaves RMS 23/5/31 千m³ at 09:00 JST vs 97/28/69 at midnight
--   長崎, 鹿児島   no hourly feed to compare; left at midnight
--
-- So these four blocks were stored 9 hours early, putting a 09:00 reading
-- next to other sources' midnight values (市房 4,371,000 vs kumamoto-bousai
-- 4,443,000 at 09-14T15:00Z). The fixed adapter stamps them at 09:00 JST.
--
-- Scope: source kyushu-nousei, the 33 NDIs bound from those four blocks
-- (source_universe keys 41:/43:/44:/45:, no dam shared with another block),
-- rows at 15:00 UTC. Dry run 2026-09-28: 31 rows, all at 2026-08-31 15:00Z
-- (佐賀 8, 熊本 4, 大分 7, 宮崎 12; 大蘇/大谷 store no rows). An R8.9.15 run
-- of the old code before the deploy adds its rows at 2026-09-14 15:00Z; they
-- are moved too. A row the fixed adapter already wrote at the target instant
-- wins over the moved copy (same PDF, same values). A second run finds
-- nothing at 15:00Z and moves nothing; the final SELECT should report 0.

BEGIN;
SET LOCAL timescaledb.max_tuples_decompressed_per_dml_transaction = 0;

CREATE TEMP TABLE kyushu_nousei_9am (dam_id) AS
SELECT id FROM dams
WHERE external_ids ->> 'ndi' IN (
  -- 佐賀
  '2521', '2523', '2524', '2525', '2526', '2527', '2556', '2557',
  -- 熊本
  '2659', '2663', '2671', '2678',
  -- 大分
  '2259', '2262', '2263', '2266', '2274', '2306', '2307', '2314', '2316',
  -- 宮崎
  '2356', '2357', '2363', '2364', '2368', '2371', '2377', '2378', '2380', '2381', '2384', '2385'
);

INSERT INTO observations (observed_at, dam_id, source_id, storage_volume_m3, storage_rate,
                          inflow_m3s, outflow_m3s, water_level_m, rainfall_mm,
                          raw_snapshot_id, quality_flag, created_at)
SELECT o.observed_at + interval '9 hours', o.dam_id, o.source_id, o.storage_volume_m3,
       o.storage_rate, o.inflow_m3s, o.outflow_m3s, o.water_level_m, o.rainfall_mm,
       o.raw_snapshot_id, o.quality_flag, o.created_at
FROM observations o
JOIN kyushu_nousei_9am t ON t.dam_id = o.dam_id
WHERE o.source_id = 'kyushu-nousei'
  AND (o.observed_at AT TIME ZONE 'UTC')::time = '15:00'
ON CONFLICT (dam_id, observed_at, source_id) DO NOTHING;

DELETE FROM observations o
USING kyushu_nousei_9am t
WHERE o.dam_id = t.dam_id
  AND o.source_id = 'kyushu-nousei'
  AND (o.observed_at AT TIME ZONE 'UTC')::time = '15:00';

SELECT count(*) AS left_at_jst_midnight
FROM observations o
JOIN kyushu_nousei_9am t ON t.dam_id = o.dam_id
WHERE o.source_id = 'kyushu-nousei'
  AND (o.observed_at AT TIME ZONE 'UTC')::time = '15:00';

DROP TABLE kyushu_nousei_9am;

COMMIT;
