-- 0037: one-time backfill of storage_rate for observations that have
-- storage_volume_m3 but null storage_rate.
--
-- The trigger added in 0036 fires BEFORE INSERT OR UPDATE, so it only
-- covers rows written after the trigger was created.  Existing observations
-- (sourced from the volume-only prefectures: nagano-kasen, gunma-kasen,
-- iwate-kasen, ibaraki-bousai, hyogo-bodik, tochigi-bodik, kyoto-bousai,
-- wakayama-kasen, saitama-suibo, gifu-kasen, jwa-kiso-rt, jwa-toyokawa,
-- fukuoka-bodik) still have storage_rate = NULL.
--
-- Scope: last 30 days only (coverage window) to keep the UPDATE within
-- the uncompressed hypertable chunks and avoid expensive decompression.
-- Capped at GREATEST(0, LEAST(1.5, ...)) — same logic as the trigger.

UPDATE observations o
SET    storage_rate = GREATEST(0, LEAST(1.5, o.storage_volume_m3 / d.active_capacity_m3))
FROM   dams d
WHERE  o.dam_id            = d.id
  AND  o.observed_at       > NOW() - INTERVAL '30 days'
  AND  o.storage_rate      IS NULL
  AND  o.storage_volume_m3 IS NOT NULL
  AND  d.active_capacity_m3 IS NOT NULL
  AND  d.active_capacity_m3 > 0;
