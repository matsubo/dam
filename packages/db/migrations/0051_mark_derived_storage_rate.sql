-- 0051: mark a storage_rate the trigger derived, and stop it masquerading as a
-- trusted source's own reading.
--
-- Issue #45 (found reviewing #32). 0049 made the read path prefer a
-- trusted_rate_basis row so the displayed 貯水率 stops swapping denominator
-- every hour. But `observations_fill_storage_rate` (0036, redefined in 0047)
-- fills a NULL storage_rate from volume / active_capacity_m3 for *every*
-- source, trusted included. 0047's own header records when that happens:
-- kasenbosai emits NULL whenever both storPcntIrr and storPcntEff carry a
-- non-zero quality code.
--
-- On those hours the stored "trusted" rate is 有効-based,
-- effective_active_capacity_m3() back-solves to the static capacity, and
-- nothing at read time could tell a native reading from a derived one. 美利河
-- displays 12.4 % instead of 83.6 % — the same swing #32 fixed, re-keyed from
-- the clock to the upstream quality codes.
--
-- Note what does NOT fix this: simply not deriving a rate for trusted sources.
-- The row would then carry a NULL rate, effective_active_capacity_m3() would
-- fall through to active_capacity_m3 anyway, and the reader would see the same
-- 有効-based figure. The rate has to stay; it has to be *labelled*.
--
-- quality_flag gains bit 32. The read path then prefers a trusted row whose
-- rate is the source's own, and a derived one simply loses the preference and
-- competes on recency like any other row — no worse than before #32, and
-- honest about what it is.

COMMENT ON COLUMN observations.quality_flag IS
  'bitfield: 1=missing(imputed), 2=outlier, 4=interpolated, '
  '8=mismatch_with_other_source, 16=manual_review, 32=derived_rate '
  '(storage_rate computed from volume/capacity by the 0036 trigger, not '
  'published by the source — see 0051)';

CREATE OR REPLACE FUNCTION fill_storage_rate_from_volume()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_rate NUMERIC;
BEGIN
  IF NEW.storage_rate IS NULL AND NEW.storage_volume_m3 IS NOT NULL THEN
    SELECT derived_storage_rate(NEW.storage_volume_m3, d.active_capacity_m3)
    INTO v_rate
    FROM dams d
    WHERE d.id = NEW.dam_id;

    -- Only flag when a rate was actually produced: derived_storage_rate()
    -- returns NULL above 1.5x capacity (0047), and a row left NULL has nothing
    -- derived about it.
    IF v_rate IS NOT NULL THEN
      NEW.storage_rate  := v_rate;
      NEW.quality_flag  := COALESCE(NEW.quality_flag, 0) | 32;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- Backfill. A trigger-filled rate is exactly volume / active_capacity_m3, so
-- rows that satisfy that identity to within floating-point noise are the ones
-- the trigger wrote. The comparison is deliberately tight: a source whose own
-- published rate happens to equal volume/capacity is reporting the same basis
-- anyway, so mislabelling it changes nothing about what gets displayed.
--
-- Bounded to uncompressed chunks for the reason #31 documents — an unbounded
-- UPDATE here would decompress the whole hypertable in one transaction. Older
-- rows keep an unset bit, which reads as "native": they predate the trusted
-- preference and are only reachable once a source has been silent for 24h.
UPDATE observations o
SET quality_flag = COALESCE(o.quality_flag, 0) | 32
FROM dams d
WHERE d.id = o.dam_id
  AND o.observed_at > NOW() - INTERVAL '30 days'
  AND o.storage_rate IS NOT NULL
  AND o.storage_volume_m3 IS NOT NULL
  AND d.active_capacity_m3 > 0
  AND (o.quality_flag & 32) = 0
  AND abs(o.storage_rate - o.storage_volume_m3 / d.active_capacity_m3) < 0.00005;

-- The trusted preference now requires the rate to be the source's own.
CREATE OR REPLACE FUNCTION display_observation(
  p_dam_id         BIGINT,
  p_require_volume BOOLEAN  DEFAULT TRUE,
  p_max_age        INTERVAL DEFAULT NULL
)
RETURNS TABLE (
  storage_volume_m3 NUMERIC,
  storage_rate      NUMERIC,
  source_id         TEXT,
  observed_at       TIMESTAMPTZ
)
LANGUAGE sql
STABLE
AS $$
  SELECT o.storage_volume_m3, o.storage_rate, o.source_id, o.observed_at
  FROM observations o
  LEFT JOIN source_priorities sp ON sp.source_id = o.source_id
  WHERE o.dam_id = p_dam_id
    AND (NOT p_require_volume OR o.storage_volume_m3 IS NOT NULL)
    AND o.source_id <> 'synthetic'
    AND (p_max_age IS NULL OR o.observed_at > NOW() - p_max_age)
  ORDER BY
    -- A trusted row wins while it is current AND carries the source's own rate.
    -- A derived rate (bit 32) is 有効-based whatever the source's basis is, so
    -- preferring it would display the very figure #32 set out to stop. A NULL
    -- rate is not a native reading either — it is no reading, and a trusted row
    -- without one must not outrank a newer row that has one (derived_storage_rate
    -- returns NULL above 1.5x capacity, so these exist).
    (COALESCE(sp.trusted_rate_basis, FALSE)
       AND o.storage_rate IS NOT NULL
       AND (COALESCE(o.quality_flag, 0) & 32) = 0
       AND o.observed_at > NOW() - INTERVAL '24 hours') DESC,
    o.observed_at DESC
  LIMIT 1
$$;

COMMENT ON FUNCTION display_observation(BIGINT, BOOLEAN, INTERVAL) IS
  'Observation the public read path should display for a dam: the most recent '
  'trusted_rate_basis row within 24h that carries a rate the source published '
  'itself (non-NULL, quality_flag bit 32 unset), else the most recent row. Keeps the rate '
  'denominator stable when several sources write the same dam (issues #32, #45). '
  'p_require_volume=FALSE for level-only paths; pass p_max_age on any path that '
  'runs per dam across the whole master, or chunk exclusion is lost.';
