-- One-off (prod, after `fix(aitoyo): stamp readings at 当日 24時/9時 and poll
-- through the day` is deployed): move aitoyo history to the hour its values
-- are read.
--
-- Run once; the file is its own transaction (BEGIN … COMMIT):
--   psql -U dam -d dam -v ON_ERROR_STOP=1 -f 2026-09-28_aitoyo_restamp_reading_hour.sql
-- then SELECT graphile_worker.add_job('aggregates:refresh');
-- Not a migration: it rewrites every aitoyo row, most of them in compressed
-- chunks (runbook §9).
--
-- The page's 「YYYY年M月D日現在」 table holds 「当日の24時（木曽川・豊川）または
-- 9時（矢作川）の値」, but the old adapter stamped every row at the START of
-- the 現在 day (D 00:00 JST = D-1 15:00Z): 24 h early for 牧尾/阿木川/味噌川/
-- 岩屋/宇連, 9 h early for 矢作/羽布. Prod: aitoyo's 牧尾 at 09-23 15:00Z
-- (58,534 千m³) is gifu-kasen's and jwa-chubu's 09-24 15:00Z value; its 矢作
-- (36,300) is gifu-kasen's 09-24 00:00Z (36,305).
--
-- Order-safe against the new worker, and idempotent. Old rows are the 15:00Z
-- rows created before the first 00:00Z row (矢作/羽布 at 09:00 JST), which
-- only the fixed adapter, or this script's first run, can write. All 7 dams
-- of one run share a created_at, so after the first run the earliest moved
-- 矢作 row sets that bound and a second run finds nothing older. The new
-- worker never upserts onto an old key: its newest 15:00Z key is the page's
-- day, one day past the old stamp of the same page, so created_at stays a
-- clean split. A shifted row that lands on a key the new worker already wrote
-- (the same page read by both) keeps the worker's row; values are equal.
--
-- Dry run (prod, read-only, 2026-09-28): 511 rows moved (7 dams × 73 days,
-- 2026-05-10 … 2026-09-23 15:00Z → +24 h / +9 h); 0 conflicts; no 00:00Z row
-- yet, so the bound is 'infinity'.
-- Rehearsed on a private copy of prod's rows (old chunks compressed), with the
-- new worker run after and, on a fresh copy, before: both ended with 7 × 74
-- rows at the reading hour; each second run changed 0.
-- The final SELECT should report 0 rows at 15:00Z for 矢作/羽布.

BEGIN;
SET LOCAL timescaledb.max_tuples_decompressed_per_dml_transaction = 0;

CREATE TEMP TABLE aitoyo_restamp ON COMMIT DROP AS
SELECT o.observed_at
         + CASE WHEN d.external_ids->>'aitoyo' IN ('矢作ダム', '羽布ダム')
                THEN INTERVAL '9 hours' ELSE INTERVAL '24 hours' END AS new_observed_at,
       o.*
FROM observations o
JOIN dams d ON d.id = o.dam_id
WHERE o.source_id = 'aitoyo'
  AND extract(hour FROM o.observed_at AT TIME ZONE 'UTC') = 15
  AND o.created_at < COALESCE(
        (SELECT min(created_at) FROM observations
         WHERE source_id = 'aitoyo'
           AND extract(hour FROM observed_at AT TIME ZONE 'UTC') = 0),
        'infinity');

DELETE FROM observations o
USING aitoyo_restamp r
WHERE o.source_id = 'aitoyo'
  AND o.dam_id = r.dam_id
  AND o.observed_at = r.observed_at;

INSERT INTO observations
  (observed_at, dam_id, source_id, storage_volume_m3, storage_rate, inflow_m3s,
   outflow_m3s, water_level_m, rainfall_mm, raw_snapshot_id, quality_flag, created_at)
SELECT new_observed_at, dam_id, 'aitoyo', storage_volume_m3, storage_rate, inflow_m3s,
       outflow_m3s, water_level_m, rainfall_mm, raw_snapshot_id, quality_flag, created_at
FROM aitoyo_restamp
ON CONFLICT (dam_id, observed_at, source_id) DO NOTHING;

SELECT d.external_ids->>'aitoyo' AS dam,
       count(*) FILTER (WHERE extract(hour FROM o.observed_at AT TIME ZONE 'UTC') = 15) AS at_15z,
       count(*) FILTER (WHERE extract(hour FROM o.observed_at AT TIME ZONE 'UTC') = 0) AS at_00z,
       max(o.observed_at) AS newest
FROM observations o
JOIN dams d ON d.id = o.dam_id
WHERE o.source_id = 'aitoyo'
GROUP BY 1 ORDER BY 1;

COMMIT;
