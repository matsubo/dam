-- One-off (prod, after the fix(jwa-fukudou) rate-tolerance fix is deployed):
-- fill in the 山口調整池 (NDI 2487) volume the old tie check dropped from the
-- 2026-09-28 0時 jwa-fukudou row.
--
-- Run once; the file is its own transaction (BEGIN … COMMIT):
--   psql -U dam -d dam -v ON_ERROR_STOP=1 -f 2026-09-28_jwa_fukudou_rounded_rate.sql
-- Not a migration: DML on observations stays out of the migrate path
-- (runbook §9). If the fixed worker ran while info02.html still showed
-- 9月28日 0時, it has already rewritten the row and this changes nothing.
--
-- Why. info02.html prints 貯水率 rounded to a whole percent: the 9/28 0時
-- edition (Last-Modified 2026-09-28 01:49 JST) reads EL 117.02 m, 総貯水量
-- 3,753,400 m³, 貯水率 94.0 %, and 3,753,400 / 4,000,000 = 93.835 %. The old
-- check allowed ±0.05 pt, so the volume was not stored. The fixed task stores
-- 総貯水量 − 堆砂容量 (4,000,000 − 3,900,000) = 3,653,400 m³ with a NULL rate,
-- which the 0036/0051 trigger derives against 有効貯水容量 (0.9368, bit 32).
--
-- Evidence (prod, dry run 2026-09-28 12:55 JST): jwa-fukudou holds two rows;
-- 2026-09-24 15:00Z carries 3,658,400 m³, 2026-09-27 15:00Z carries
-- water_level_m 117.02 and NULL volume/rate. Dry-run count: UPDATE 1.
--
-- Scoped to that one row, and only while its volume is still NULL, so a
-- second run changes nothing. The final SELECT should report 3653400.00.

BEGIN;
SET LOCAL timescaledb.max_tuples_decompressed_per_dml_transaction = 0;

UPDATE observations
SET storage_volume_m3 = 3653400,
    storage_rate      = NULL,
    quality_flag      = quality_flag & ~32
WHERE source_id = 'jwa-fukudou'
  AND dam_id IN (SELECT id FROM dams WHERE external_ids ->> 'ndi' = '2487')
  AND observed_at = '2026-09-27 15:00:00+00'
  AND water_level_m = 117.02
  AND storage_volume_m3 IS NULL;

SELECT storage_volume_m3, storage_rate, quality_flag
FROM observations
WHERE source_id = 'jwa-fukudou'
  AND dam_id IN (SELECT id FROM dams WHERE external_ids ->> 'ndi' = '2487')
  AND observed_at = '2026-09-27 15:00:00+00';

COMMIT;
