-- One-off (prod; 2fe6bed `fix(kasenbosai): skip readings with every
-- quantity invalid` is already deployed): delete the kasenbosai rows that
-- carry no value.
--
-- Run once; the file is its own transaction (BEGIN … COMMIT):
--   psql -U dam -d dam -v ON_ERROR_STOP=1 -f 2026-09-28_kasenbosai_empty_rows.sql
-- Not a migration: 44,704 of these rows sit in compressed chunks, and a
-- DELETE that decompresses them does not belong in the migrate path.
--
-- Before 2fe6bed, ingest_kasenbosai_v2 stored one row per hour for stations
-- whose every quantity is flagged 欠測 (Ccd 140/160), every column NULL.
-- classifyDamCoverage counted them as coverage, so 21 dams whose only
-- observations in the 30-day window were these rows showed as 取得済み on
-- /coverage (幌加, 中和, 温根別, 御料, 風連, 相川, 山王海（再）, 葛丸, 千松,
-- 白丸調整池, 小倉, 外山, 河内防災, 厳木川調整池, 深浦, 樋口, つづら, 笛吹,
-- 内谷, 地蔵原, 宮の元). A row with no value is no reading; the coverage
-- queries now ignore such rows as well.
--
-- Evidence (prod, 2026-09-28, read-only). Dry run of the DELETE predicate
-- below: 74,021 rows on 358 dams, 2026-07-03 06:50Z .. 2026-09-27 23:00Z
-- (27,323 of them in the last 30 days), the same count as the plain
-- `IS NULL` test on all six columns. None was written after the 2fe6bed
-- deploy.
--
-- Idempotent (a second run deletes nothing); a no-op on a fresh database.
-- The final SELECT reports what is left (expected 0).
--
-- After it: obs_daily's refresh policy only reaches back 60 days, so refresh
-- the older buckets by hand (outside a transaction):
--   CALL refresh_continuous_aggregate('obs_daily', '2026-07-01', now() - interval '59 days');
--   CALL refresh_continuous_aggregate('obs_monthly', '2026-07-01', '2026-09-01');

BEGIN;
SET LOCAL timescaledb.max_tuples_decompressed_per_dml_transaction = 0;

DELETE FROM observations
WHERE source_id = 'kasenbosai'
  AND observed_at >= '2026-07-01 00:00+00'
  AND num_nonnulls(storage_volume_m3, storage_rate, inflow_m3s,
                   outflow_m3s, water_level_m, rainfall_mm) = 0;

SELECT count(*) AS remaining_empty_kasenbosai_rows
FROM observations
WHERE source_id = 'kasenbosai'
  AND num_nonnulls(storage_volume_m3, storage_rate, inflow_m3s,
                   outflow_m3s, water_level_m, rainfall_mm) = 0;

COMMIT;
