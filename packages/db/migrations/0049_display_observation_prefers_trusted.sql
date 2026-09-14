-- 0049: pick the observation the site displays by rate basis, not by clock
-- alone.
--
-- Issue #32. 北海道開発局's 18 直轄ダム are ingested by `hkd-mlit-dam` every
-- hour at :13 (10-minute values); `kasenbosai` lands at :03 (hourly). Every
-- read picked `ORDER BY observed_at DESC LIMIT 1`, so from :13 to the next :03
-- the hkd row won — and hkd is not `trusted_rate_basis`, so
-- effective_active_capacity_m3() fell back to the static 有効貯水容量 instead
-- of back-solving the 利水 denominator from a trusted native rate. 美利河 read
-- 83.6 % at 07:10 and 11.4 % at 08:55 on the same day, from the same reservoir.
--
-- Note for anyone tempted by the other obvious fix: marking `hkd-mlit-dam`
-- trusted is WRONG. Its own published 貯水率 is 有効容量-based, verified
-- against the live pages on 2026-09-14 by dividing 貯水量 by the published
-- rate:
--
--   美利河   1,290 / 8.8 %  = 14,659 千m³ vs 有効 14,500, 利水 2,159
--   滝里    17,785 / 22.4 % = 79,397 千m³ vs 有効 85,000, 利水 31,260
--   大雪     2,726 / 4.9 %  = 55,633 千m³ vs 有効 54,700, 利水 24,456
--   岩尾内   2,351 / 2.4 %  = 97,958 千m³ vs 有効 96,300, 利水 47,494
--
-- Trusting it would lock the low reading in permanently instead of only for
-- the 50 minutes it currently wins.
--
-- Shape matters as much as semantics here. Expressing this as one ORDER BY over
-- a computed key (trusted AND recent, then observed_at) forces a sort of the
-- dam's entire history on every call — no index can supply that ordering, and
-- on a hypertable the sort input includes compressed chunks, so it decompresses
-- everything to discard all but one row. Measured on dev: cost 612 per dam
-- against 1.8 for the old index-backed pick, and lowStorageDams runs it once
-- per dam across the whole master. It is written as two index-backed probes
-- (trusted-and-recent, then newest-overall) combined with UNION ALL instead.
--
-- The trusted-source set is an ARRAY(SELECT ...) InitPlan rather than
-- IN (SELECT ...) deliberately: as a semi-join the planner turns the probe into
-- a hash join and the sort comes back.
--
-- So: prefer a trusted-basis row while one is recent enough to be current, and
-- fall back to the newest row otherwise. kasenbosai is hourly, so the
-- preferred row is normally under an hour old — the display trades up to an
-- hour of freshness for a denominator that does not change under the reader.
-- The volume comes from the same row as the rate, so the two always agree.

-- Two signatures would be ambiguous for a one-argument call, so the original is
-- dropped rather than overloaded.
DROP FUNCTION IF EXISTS display_observation(BIGINT);

CREATE OR REPLACE FUNCTION display_observation(
  p_dam_id         BIGINT,
  -- The rate paths need a volume to divide; the detail page does not. Dams fed
  -- only by level-carrying sources (ktr-kinu, tokushima-bousai, hrr-mlit and
  -- friends write storage_volume_m3 NULL) would otherwise report no observation
  -- at all and lose their live 水位/流入量/放流量.
  p_require_volume BOOLEAN DEFAULT TRUE
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
  SELECT x.storage_volume_m3, x.storage_rate, x.source_id, x.observed_at
  FROM (
    (
      -- Probe 1: the newest trusted-basis row still current.
      SELECT o.storage_volume_m3, o.storage_rate, o.source_id, o.observed_at, 0 AS pri
      FROM observations o
      WHERE o.dam_id = p_dam_id
        AND (NOT p_require_volume OR o.storage_volume_m3 IS NOT NULL)
        AND o.source_id <> 'synthetic'
        AND o.observed_at > NOW() - INTERVAL '24 hours'
        AND o.source_id = ANY(ARRAY(
          SELECT sp.source_id FROM source_priorities sp WHERE sp.trusted_rate_basis
        ))
      ORDER BY o.observed_at DESC
      LIMIT 1
    )
    UNION ALL
    (
      -- Probe 2: the newest row of any source, used when probe 1 is empty.
      SELECT o.storage_volume_m3, o.storage_rate, o.source_id, o.observed_at, 1 AS pri
      FROM observations o
      WHERE o.dam_id = p_dam_id
        AND (NOT p_require_volume OR o.storage_volume_m3 IS NOT NULL)
        AND o.source_id <> 'synthetic'
      ORDER BY o.observed_at DESC
      LIMIT 1
    )
  ) x
  ORDER BY x.pri
  LIMIT 1
$$;

COMMENT ON FUNCTION display_observation(BIGINT, BOOLEAN) IS
  'Observation the public read path should display for a dam: the most recent '
  'trusted_rate_basis row within 24h, else the most recent row. Keeps the rate '
  'denominator stable when several sources write the same dam (issue #32). '
  'p_require_volume=FALSE for paths that show level-only readings.';
