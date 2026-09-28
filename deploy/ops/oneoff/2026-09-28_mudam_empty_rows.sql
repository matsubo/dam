-- One-off (prod, after `fix(mudam): skip CSV days where every column is
-- blank` is deployed): delete the mudam rows that carry no value.
--
-- Run once; the file is its own transaction (BEGIN … COMMIT):
--   psql -U dam -d dam -v ON_ERROR_STOP=1 -f 2026-09-28_mudam_empty_rows.sql
-- Not a migration: all 21,543 of these rows sit in compressed chunks
-- (2019–2024), and a DELETE that decompresses them does not belong in the
-- migrate path.
--
-- mudam's day CSV header reads （※空欄はデータがなし）: a blank cell means no
-- data. parseMudamCsv still emitted a row for every date, so a blank day was
-- stored with every quantity NULL. Those rows counted toward 歴史データ
-- (coverageHeadline().historicalDamCount) and, for 長良川河口堰, the empty
-- 2024-12-30 row was its newest observation of any source. backfill_mudam now
-- skips such days, so no new ones arrive.
--
-- Evidence (prod, 2026-09-28, read-only). Dry run of the DELETE predicate
-- below: 21,543 rows on 153 dams, 2019-12-31 15:00Z .. 2024-12-30 15:00Z,
-- the same count as the plain `IS NULL` test on all six columns. 5 dams hold
-- nothing else from mudam (1,827 rows each for 利根川河口堰, 琵琶湖開発,
-- 筑後大堰, 長良川河口堰; 366 for 笛吹); most others lose a stray blank day
-- such as 2024-02-29 (木地山, 南畑（再）).
--
-- Idempotent (a second run deletes nothing); a no-op on a fresh database.
-- The final SELECT reports what is left (expected 0).
--
-- After it: obs_daily's refresh policy only reaches back 60 days and
-- obs_monthly's 5 years, so refresh the mudam range by hand (outside a
-- transaction):
--   CALL refresh_continuous_aggregate('obs_daily', '2019-12-31', '2025-01-01');
--   CALL refresh_continuous_aggregate('obs_monthly', '2019-12-01', '2025-01-01');

BEGIN;
SET LOCAL timescaledb.max_tuples_decompressed_per_dml_transaction = 0;

DELETE FROM observations
WHERE source_id = 'mudam'
  AND num_nonnulls(storage_volume_m3, storage_rate, inflow_m3s,
                   outflow_m3s, water_level_m, rainfall_mm) = 0;

SELECT count(*) AS remaining_empty_mudam_rows
FROM observations
WHERE source_id = 'mudam'
  AND num_nonnulls(storage_volume_m3, storage_rate, inflow_m3s,
                   outflow_m3s, water_level_m, rainfall_mm) = 0;

COMMIT;
