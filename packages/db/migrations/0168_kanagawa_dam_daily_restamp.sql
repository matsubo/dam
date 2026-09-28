-- 0168: re-stamp kanagawa-dam history onto its real daily timeline.
--
-- summary.php serves a 30-DAY daily window (index 29 = the `lastUpdate` day,
-- 24:00 JST reading), but ingest_kanagawa stamped each hourly fetch with the
-- series' `dt` — a counter that steps back one hour per JSON key, not a
-- reading time. So every row since 2026-05-11 is the lastUpdate day's value
-- misdated 33 h (相模) to 54 h (道志) behind the fetch, one fake "hourly" point
-- per fetch.
--
-- lastUpdate rolls over at ~01:00 JST (prod: sagami's volume changes on the
-- 01:05 JST run every day), so a row fetched at JST time t carries the day
-- (t - 1 h)::date - 1. Keep one row per (dam, day) — the one fetched nearest
-- the middle of that day's fetch span, clear of either rollover — and stamp it
-- at the day's 24:00 JST, as the adapter now does. Checked read-only on prod
-- 2026-09-28: all 150 (5 dams × 30 days) rebuilt volumes equal the live
-- window's; 5 of 690 (dam, day) groups held two values, from a 00:17 JST run
-- that saw an early rollover.

CREATE TEMP TABLE kanagawa_daily ON COMMIT DROP AS
SELECT DISTINCT ON (dam_id, day)
       ((day + 1)::timestamp AT TIME ZONE 'Asia/Tokyo') AS observed_at,
       dam_id, storage_volume_m3, storage_rate, inflow_m3s, outflow_m3s,
       water_level_m, rainfall_mm, raw_snapshot_id, quality_flag, created_at
FROM (
  SELECT o.*,
         ((o.created_at AT TIME ZONE 'Asia/Tokyo') - INTERVAL '1 hour')::date - 1 AS day
  FROM observations o
  WHERE o.source_id = 'kanagawa-dam'
) s
ORDER BY dam_id, day,
         abs(extract(epoch FROM
           created_at - (((day + 1)::timestamp + INTERVAL '13 hours') AT TIME ZONE 'Asia/Tokyo')));

DELETE FROM observations WHERE source_id = 'kanagawa-dam';

INSERT INTO observations
  (observed_at, dam_id, source_id, storage_volume_m3, storage_rate, inflow_m3s,
   outflow_m3s, water_level_m, rainfall_mm, raw_snapshot_id, quality_flag, created_at)
SELECT observed_at, dam_id, 'kanagawa-dam', storage_volume_m3, storage_rate, inflow_m3s,
       outflow_m3s, water_level_m, rainfall_mm, raw_snapshot_id, quality_flag, created_at
FROM kanagawa_daily;
