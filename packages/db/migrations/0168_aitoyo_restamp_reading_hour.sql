-- 0168: move aitoyo history to the hour its values are read.
--
-- The page's 「YYYY年M月D日現在」 table holds 「当日の24時（木曽川・豊川）または
-- 9時（矢作川）の値」, but ingest_aitoyo stamped every row at the START of the
-- 現在 day (D 00:00 JST = D-1 15:00Z): 24 h early for 牧尾/阿木川/味噌川/岩屋/
-- 宇連, 9 h early for 矢作/羽布. Prod check 2026-09-28: aitoyo's 牧尾 at
-- 09-23 15:00Z (58,534 千m³) is gifu-kasen's and jwa-chubu's 09-24 15:00Z value;
-- its 矢作 (36,300) is gifu-kasen's 09-24 00:00Z (36,305).
--
-- Only rows in the old stamp (15:00Z) written before the fixed adapter's first
-- run are moved; that run is the first 矢作川 row at 00:00Z, which the old
-- adapter could never produce.

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
