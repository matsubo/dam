-- One-off (prod, after the fix(jwa-toyokawa) parser fix is deployed): correct
-- the 有効貯水量 jwa-toyokawa stored with the unit's "10³" read as digits,
-- re-derive the rates computed from it, drop the release-only 放流量, and
-- delete the communication-cut rows that are nothing but unit digits.
--
-- Run once; the file is its own transaction (BEGIN … COMMIT):
--   psql -U dam -d dam -v ON_ERROR_STOP=1 -f 2026-09-28_jwa_toyokawa_units.sql
-- then, outside it (obs_daily / obs_monthly still hold the wrong volumes):
--   SELECT graphile_worker.add_job('aggregates:refresh');
-- Not a migration: most of these rows sit in compressed chunks, and DML that
-- decompresses them does not belong in the migrate path (runbook §9).
--
-- Why. 水資源機構 中部支社 リアルタイム情報 豊川水系 (mizu/chubu/realtime/
-- index_2.html) prints 有効貯水量 as `18158<span class="unit">10<sup>3</sup>
-- m<sup>3</sup></span>`. The old parser stripped the tags and took the first
-- number, 18158103, so every stored volume is (千m³ value × 1000) + 103. When
-- a cell is "cc" (communication cut) it read the unit's digits instead:
-- 貯水位 103, 有効貯水量 103, 流入量 3 and 放流量 3 (the "3" of m³/s). And the
-- only outflow on the page is 放流量（利水）, the water-supply release, not
-- the total: kasenbosai's total outflow for 大島 is > 0 at 49 of the 61
-- shared timestamps where this source stored 0.00. The fixed task stores no
-- outflow. The task never passed a rate (storageRate: null since 2691e0e), so
-- every storage_rate on these rows was derived by the trigger (0036/0051)
-- from the wrong volume.
--
-- Evidence (prod, dry run 2026-09-28 07:30 JST). jwa-toyokawa rows, all on
-- two dams, 2026-06-05 00:50Z .. 2026-09-27 21:30Z:
--
--   NDI  dam   rows   (vol − 103) % 1000 = 0   all-unit-digit rows   outflow set
--   807  大島  2,818                   2,818                     5         2,818
--   811  宇連  2,818                   2,818                    48         2,818
--
-- Every stored volume carries the artefact, and the correction is exact:
-- at the 121 timestamps kasenbosai also holds, its volume equals the stored
-- volume − 103 m³ on 119 (all 60 on 宇連, 59 of 61 on 大島). So volumes are
-- corrected (− 103), not nulled. The 53 all-unit-digit rows (level 103,
-- volume 103, inflow 3, outflow 3; neither dam goes below EL 184 m) hold no
-- reading and are deleted.
--
-- Dry-run counts: DELETE 53, UPDATE 5,583 (2,813 大島 + 2,770 宇連). Both grow
-- by two rows an hour until the fix is deployed; run it after the deploy.
--
-- Scoped to source jwa-toyokawa on the two dams by NDI id. Idempotent: a
-- corrected volume is a multiple of 1000, so (vol − 103) % 1000 is 897 and a
-- second run changes nothing. The UPDATE clears storage_rate and bit 32 so
-- the BEFORE UPDATE trigger derives the rate again from the corrected volume
-- (as observations:rebind does). The final SELECT should report 0, 0, 0.

BEGIN;
SET LOCAL timescaledb.max_tuples_decompressed_per_dml_transaction = 0;

DELETE FROM observations
WHERE source_id = 'jwa-toyokawa'
  AND dam_id IN (SELECT id FROM dams WHERE external_ids ->> 'ndi' IN ('807', '811'))
  AND water_level_m = 103
  AND storage_volume_m3 = 103
  AND inflow_m3s = 3
  AND outflow_m3s = 3;

UPDATE observations
SET storage_volume_m3 = storage_volume_m3 - 103,
    storage_rate      = NULL,
    quality_flag      = quality_flag & ~32,
    outflow_m3s       = NULL
WHERE source_id = 'jwa-toyokawa'
  AND dam_id IN (SELECT id FROM dams WHERE external_ids ->> 'ndi' IN ('807', '811'))
  AND (storage_volume_m3 - 103) % 1000 = 0;

SELECT
  count(*) FILTER (WHERE (storage_volume_m3 - 103) % 1000 = 0) AS volumes_with_103,
  count(*) FILTER (WHERE outflow_m3s IS NOT NULL)                AS outflows_left,
  count(*) FILTER (WHERE storage_volume_m3 IS NOT NULL
                     AND storage_rate IS NULL)                   AS rates_not_derived
FROM observations
WHERE source_id = 'jwa-toyokawa';

COMMIT;
