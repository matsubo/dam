-- One-off (prod, after the fix(jwa-chikugo-rt) parser fix is deployed): clear
-- the constant 930 千m³ 筑後大堰 (NDI 2475) "volume" jwa-chikugo-rt stored every
-- hour, and the 100 % rate the trigger derived from it.
--
-- Run once; the file is its own transaction (BEGIN … COMMIT):
--   psql -U dam -d dam -v ON_ERROR_STOP=1 -f 2026-09-28_jwa_chikugo_rt_oozeki_volume.sql
-- then, outside it (obs_daily / obs_monthly still hold the 930,000 m³ / 1.0):
--   SELECT graphile_worker.add_job('aggregates:refresh');
-- Not a migration: DML on observations stays out of the migrate path
-- (runbook §9).
--
-- Why. 水管理情報WEB repCO_I60.html (筑後大堰) prints 有効貯水量 [千m³] as 930
-- in every hourly row: all 24 rows of the 2026-09-27 and 2026-09-28 captures,
-- while 貯水位 水位 moves between TP 3.11 and 3.63 m, below the 3.15 m 設定水位
-- included. 930 千m³ is the pool's capacity (the master's active_capacity_m3),
-- not a reading: water-source.html gives 筑後大堰 820 千m³ / 88.2 % at
-- 2026-09-25 0時. The page has no 貯水率 column, so the task passed a NULL rate
-- and the 0036/0051 trigger derived 930,000 / 930,000 = 1.0000 (quality_flag
-- 32) — the site showed the weir permanently 100 % full. The fixed task stores
-- 筑後大堰's level only.
--
-- Evidence (prod, dry run 2026-09-28 12:56 JST): 28 jwa-chikugo-rt rows on
-- 筑後大堰, 2026-09-27 00:00Z .. 2026-09-28 03:00Z, every one with
-- storage_volume_m3 = 930000, storage_rate = 1.0000, quality_flag = 32.
-- Dry-run count: UPDATE 28; it grows by one row an hour until the fix is
-- deployed — run it after the deploy.
--
-- Scoped to source jwa-chikugo-rt on NDI 2475 and to the constant volume.
-- Idempotent: a cleared row no longer matches. The final SELECT should
-- report 0.

BEGIN;
SET LOCAL timescaledb.max_tuples_decompressed_per_dml_transaction = 0;

UPDATE observations
SET storage_volume_m3 = NULL,
    storage_rate      = NULL,
    quality_flag      = quality_flag & ~32
WHERE source_id = 'jwa-chikugo-rt'
  AND dam_id IN (SELECT id FROM dams WHERE external_ids ->> 'ndi' = '2475')
  AND storage_volume_m3 = 930000;

SELECT count(*) AS oozeki_volumes_left
FROM observations
WHERE source_id = 'jwa-chikugo-rt'
  AND dam_id IN (SELECT id FROM dams WHERE external_ids ->> 'ndi' = '2475')
  AND (storage_volume_m3 IS NOT NULL OR storage_rate IS NOT NULL);

COMMIT;
