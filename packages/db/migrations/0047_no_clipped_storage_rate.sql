-- 0047: stop deriving a clipped storage_rate, and give the two writers that
-- derive one a single shared definition.
--
-- 0036 fills a missing storage_rate with GREATEST(0, LEAST(1.5,
-- volume/active_capacity)). 0040 then made effective_active_capacity_m3()
-- back-solve volume/rate for trusted sources, on the premise that a non-NULL
-- rate on a trusted source came from upstream. The trigger breaks that
-- premise: it writes a rate for any row whose adapter left one out —
-- kasenbosai emits NULL whenever both storPcntIrr and storPcntEff carry a
-- non-zero quality code, and kasenbosai is trusted.
--
-- Most of the time that is harmless, because back-solving an unclipped
-- derived value is an identity: volume / (volume/capacity) = capacity. It only
-- goes wrong at the clip. A dam holding more than 1.5x its recorded capacity
-- gets rate = 1.5, and the back-solve then reports volume/1.5 as the
-- denominator — issue #38 §2-3 found 屈足 844,000 → 1,922,000, and the same
-- for 元小屋 / 新郷 / 揚川 / 三瀬谷.
--
-- A reservoir at 150 % of its 有効貯水容量 is a master-data error, not flood
-- overflow, so the clip was inventing a number either way. Return NULL
-- instead: effective_active_capacity_m3() then falls through to
-- active_capacity_m3 and the rate is derived from the volume at read time.
--
-- The 0036 trigger and the storageRate:recompute sweeper had drifted apart —
-- the trigger clipped at 1.5, the sweeper at 1.0 — so they wrote different
-- values for the same row depending on which got there first. Both now call
-- derived_storage_rate().
CREATE OR REPLACE FUNCTION derived_storage_rate(
  storage_volume_m3  NUMERIC,
  active_capacity_m3 NUMERIC
) RETURNS NUMERIC
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN storage_volume_m3 IS NULL
      OR active_capacity_m3 IS NULL
      OR active_capacity_m3 <= 0
      OR storage_volume_m3 / active_capacity_m3 > 1.5
      THEN NULL
    ELSE GREATEST(0, storage_volume_m3 / active_capacity_m3)
  END
$$;

CREATE OR REPLACE FUNCTION fill_storage_rate_from_volume()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.storage_rate IS NULL AND NEW.storage_volume_m3 IS NOT NULL THEN
    SELECT derived_storage_rate(NEW.storage_volume_m3, d.active_capacity_m3)
    INTO NEW.storage_rate
    FROM dams d
    WHERE d.id = NEW.dam_id;
  END IF;
  RETURN NEW;
END;
$$;

-- Clear the rates the old clip already stored on trusted sources. The full
-- fingerprint is "exactly 1.5 AND the volume really is over 1.5x the capacity",
-- which is the only way the old trigger could have produced it — an upstream
-- feed that genuinely published 150.0000 % would not also satisfy the ratio
-- test against a capacity it does not use. Scoped to trusted sources so the
-- UPDATE stays small on compressed chunks (see issue #31).
UPDATE observations o
SET storage_rate = NULL
FROM source_priorities sp, dams d
WHERE sp.source_id = o.source_id
  AND sp.trusted_rate_basis
  AND d.id = o.dam_id
  AND o.storage_rate = 1.5
  AND o.storage_volume_m3 IS NOT NULL
  AND o.storage_volume_m3 / NULLIF(d.active_capacity_m3, 0) > 1.5;
