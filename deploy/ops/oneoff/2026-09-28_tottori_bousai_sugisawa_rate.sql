-- One-off (prod, after fix(tottori-bousai) — no 有効容量貯水率 for 国's 菅沢 —
-- is deployed): stop tottori-bousai's stored 菅沢 rates passing as the
-- manager's own trusted rate. Each is nulled, and the BEFORE UPDATE trigger
-- (0036/0051) derives it again from the volume and flags it (bit 32).
--
-- Run once; the file is its own transaction (BEGIN … COMMIT), since most of
-- the rows sit in compressed chunks:
--   psql -U dam -d dam -v ON_ERROR_STOP=1 -f 2026-09-28_tottori_bousai_sugisawa_rate.sql
-- then, outside it (obs_daily / obs_monthly average the old rates):
--   SELECT graphile_worker.add_job('aggregates:refresh');
-- Not a migration: DML that decompresses chunks does not belong in the
-- migrate path (runbook §9).
--
-- Why. tottori-bousai is trusted_rate_basis (0040): display_observation()
-- prefers its rate as the manager's current-season 利水 rate, and
-- effective_active_capacity_m3() back-solves the denominator from it. But
-- 鳥取県防災Web's 利水容量貯水率 column is null/flg=2 for every dam (list
-- 2026-06-05-08-20 and 2026-09-28-12-40 alike), so the task stored the
-- 有効容量貯水率 column. For 菅沢 (managerCd "41" = 国; the other five are
-- 県 dams whose rate kasenbosai stores identically every hour) that is
-- volume / 15,403 千m³: 2.9 % at 450 千m³ in the 12:40 list, while the
-- manager's feeds read ~39 % (cgr-mlit-dam 0.392 at 12:00, kasenbosai
-- storPcntIrr 0.391 at 11:50). Since kasenbosai switched to storPcntIrr on
-- 2026-09-09 the two trusted rows disagree on all 382 shared hours (0 within
-- 0.011; before, both stored the 有効 figure), so the displayed 菅沢 rate
-- flips between ~3 % and ~39 % hour by hour. Rows before 09-09 carry the same
-- basis and are relabelled too: the fixed task stores none of them.
--
-- Prod dry run (2026-09-28 ~12:50 JST, read-only). tottori-bousai rows on
-- 菅沢 (NDI 1624), 2026-06-04 23:30Z .. 2026-09-28 03:20Z:
--   total                                               2,533
--   rate non-NULL, bit 32 unset, |rate − vol/15,403,000| ≤ 0.001   2,533  (max 0.000546)
--   rate non-NULL, bit 32 unset, other basis                     0
--   rate within 0.001 of vol / dams.active_capacity_m3 (17.2M)   0
--   placeholder / copied rows (level < 最低水位 − 20 m)            0
--   in compressed chunks: 1,848; uncompressed: 685
-- The count grows by one row an hour until the fix is deployed; after it,
-- new rows arrive derived (bit 32) and the predicate skips them.
--
-- The predicate matches only rows whose rate is the feed's 有効 figure: the
-- column is printed to 0.1 %, so its rate sits within 0.0005 (+ volume
-- rounding) of vol / 15,403 千m³, whereas the manager's ~39 % misses by ~0.36
-- and a trigger-derived vol / 17,200 千m³ misses by ≥ 0.0027 at 菅沢's lowest
-- stored volume (399 千m³) and carries bit 32 anyway. Idempotent: the updated
-- rows come back with bit 32 set, so a second run changes nothing. The final
-- SELECT should report 0, 0.

BEGIN;
SET LOCAL timescaledb.max_tuples_decompressed_per_dml_transaction = 0;

UPDATE observations
SET storage_rate = NULL,
    quality_flag = quality_flag & ~32
WHERE source_id = 'tottori-bousai'
  AND dam_id IN (SELECT id FROM dams WHERE external_ids ->> 'ndi' = '1624')
  AND storage_rate IS NOT NULL
  AND (quality_flag & 32) = 0
  AND abs(storage_rate - storage_volume_m3 / 15403000) <= 0.001;

SELECT
  count(*) FILTER (WHERE storage_rate IS NOT NULL AND (quality_flag & 32) = 0) AS native_rates_left,
  count(*) FILTER (WHERE storage_volume_m3 IS NOT NULL AND storage_rate IS NULL) AS rates_not_derived
FROM observations
WHERE source_id = 'tottori-bousai'
  AND dam_id IN (SELECT id FROM dams WHERE external_ids ->> 'ndi' = '1624');

COMMIT;
