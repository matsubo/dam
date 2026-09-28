-- One-off (prod, after `fix(kanagawa-dam): read summary.php as a 30-day daily
-- window` is deployed): re-stamp kanagawa-dam history onto its daily timeline.
--
-- Run once; the file is its own transaction (BEGIN … COMMIT):
--   psql -U dam -d dam -v ON_ERROR_STOP=1 -f 2026-09-28_kanagawa_dam_daily_restamp.sql
-- then SELECT graphile_worker.add_job('ingest:kanagawa-dam');
--  and SELECT graphile_worker.add_job('aggregates:refresh');
-- Not a migration: it rewrites all ~16.4k kanagawa-dam rows, most of them in
-- compressed chunks (runbook §9).
--
-- summary.php serves a 30-DAY daily window (index 29 = the `lastUpdate` day,
-- its 24:00 JST reading), but the old adapter stamped each hourly fetch with
-- the series' `dt`, a counter that steps back one hour per JSON key. Every row
-- since 2026-05-11 is the lastUpdate day's value misdated 33 h (相模), 38 h
-- (城山), 43 h (三保), 48 h (宮ヶ瀬) or 54 h (道志) behind its fetch, one
-- fake "hourly" point per fetch.
--
-- lastUpdate rolls over at ~01:00 JST, so a row fetched at JST time t carries
-- day (t - 1 h)::date - 1. The script keeps one row per (dam, day), the one
-- fetched nearest 13:00 JST the next day (clear of either rollover), and
-- stamps it at the day's 24:00 JST, as the fixed adapter does.
--
-- Order-safe against the new worker. The old adapter wrote every hour of the
-- day and the new one writes only 15:00Z, so C = newest created_at of a row
-- not at 15:00Z is the old adapter's last run. Only rows created up to C are
-- rebuilt; rows the new worker inserted later are kept and win a conflict.
-- New-worker upserts onto an old 15:00Z key keep that row's created_at, so
-- 15:00Z rows are ranked after the rest when picking a day's row. Every day
-- the new worker overwrote is inside its 30-day window, and it rewrites that
-- window on its next run (the add_job above). Idempotent: once no row sits off
-- 15:00Z, C is NULL and the script changes nothing.
--
-- Dry run (prod, read-only SELECTs, 2026-09-28 04:1xZ): C = 04:05Z; 16,415
-- rows deleted, 0 newer than C, 690 inserted (5 dams × 138 days, 2026-05-13 …
-- 2026-09-27). The rebuilt 2026-08-29 … 09-27 volumes equal all 150 of the
-- live window's (5 dams × 30 days).
-- Rehearsed on a private copy of prod's rows (old chunks compressed), with the
-- new worker run after and, on a fresh copy, before: both ended at 690 rows,
-- all 150 window values equal to the live API; each second run changed 0.
-- The final SELECT should report 0 rows off 15:00Z.

BEGIN;
SET LOCAL timescaledb.max_tuples_decompressed_per_dml_transaction = 0;

CREATE TEMP TABLE kanagawa_daily ON COMMIT DROP AS
WITH c AS (
  SELECT max(created_at) AS old_until
  FROM observations
  WHERE source_id = 'kanagawa-dam'
    AND extract(hour FROM observed_at AT TIME ZONE 'UTC') <> 15
),
old AS (
  SELECT o.*,
         ((o.created_at AT TIME ZONE 'Asia/Tokyo') - INTERVAL '1 hour')::date - 1 AS day
  FROM observations o, c
  WHERE o.source_id = 'kanagawa-dam'
    AND o.created_at <= c.old_until
)
SELECT DISTINCT ON (dam_id, day)
       ((day + 1)::timestamp AT TIME ZONE 'Asia/Tokyo') AS new_observed_at,
       observed_at AS old_observed_at,
       dam_id, storage_volume_m3, storage_rate, inflow_m3s, outflow_m3s,
       water_level_m, rainfall_mm, raw_snapshot_id, quality_flag, created_at
FROM old
ORDER BY dam_id, day,
         extract(hour FROM observed_at AT TIME ZONE 'UTC') = 15,
         abs(extract(epoch FROM
           created_at - (((day + 1)::timestamp + INTERVAL '13 hours') AT TIME ZONE 'Asia/Tokyo')));

DELETE FROM observations o
WHERE o.source_id = 'kanagawa-dam'
  AND o.created_at <= (
    SELECT max(created_at) FROM observations
    WHERE source_id = 'kanagawa-dam'
      AND extract(hour FROM observed_at AT TIME ZONE 'UTC') <> 15
  );

INSERT INTO observations
  (observed_at, dam_id, source_id, storage_volume_m3, storage_rate, inflow_m3s,
   outflow_m3s, water_level_m, rainfall_mm, raw_snapshot_id, quality_flag, created_at)
SELECT new_observed_at, dam_id, 'kanagawa-dam', storage_volume_m3, storage_rate, inflow_m3s,
       outflow_m3s, water_level_m, rainfall_mm, raw_snapshot_id, quality_flag, created_at
FROM kanagawa_daily
ON CONFLICT (dam_id, observed_at, source_id) DO NOTHING;

SELECT count(*) FILTER (WHERE extract(hour FROM observed_at AT TIME ZONE 'UTC') <> 15) AS off_15z,
       count(*) AS rows,
       count(DISTINCT dam_id) AS dams,
       min(observed_at), max(observed_at)
FROM observations
WHERE source_id = 'kanagawa-dam';

COMMIT;
