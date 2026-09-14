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
-- p_max_age is the whole performance story, and it is not optional on the paths
-- that sweep every dam. Chunk exclusion is what keeps this cheap on a
-- hypertable: a time bound *inside* the pick lets TimescaleDB skip all but the
-- newest chunks, while the same bound applied to the function's result reads
-- every dam's full history first. lowStorageDams had its 30-day guard inline
-- before this migration, and moving it outside cost two orders of magnitude.
--
-- Measured on the dev copy (6.79M observations, 2,774 dams, 143 chunks), the
-- lowStorageDams shape over all dams:
--
--   bound applied after the pick   1455 ms
--   bound passed as p_max_age        19 ms
--
-- A two-probe UNION ALL rewrite was tried first, on the theory that the
-- expression ORDER BY was the problem. It is a real but secondary cost, and the
-- rewrite measured no better than what it replaced — the set operation gives
-- back whatever the ordered append saves. Keep the single ORDER BY; pass a
-- bound.
--
-- So: prefer a trusted-basis row while one is recent enough to be current, and
-- fall back to the newest row otherwise. kasenbosai is hourly, so the
-- preferred row is normally under an hour old — the display trades up to an
-- hour of freshness for a denominator that does not change under the reader.
-- The volume comes from the same row as the rate, so the two always agree.

-- Earlier signatures would be ambiguous for a defaulted call, so they are
-- dropped rather than overloaded.
DROP FUNCTION IF EXISTS display_observation(BIGINT);
DROP FUNCTION IF EXISTS display_observation(BIGINT, BOOLEAN);

CREATE OR REPLACE FUNCTION display_observation(
  p_dam_id         BIGINT,
  -- The rate paths need a volume to divide; the detail page does not. Dams fed
  -- only by level-carrying sources (ktr-kinu, tokushima-bousai, hrr-mlit and
  -- friends write storage_volume_m3 NULL) would otherwise report no observation
  -- at all and lose their live 水位/流入量/放流量.
  p_require_volume BOOLEAN  DEFAULT TRUE,
  -- Pass one on any path that runs per dam across the whole master; see above.
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
    -- 'synthetic' was retired in 0045 but old rows remain in compressed
    -- chunks; this function is the single definition of "the row we display".
    AND o.source_id <> 'synthetic'
    AND (p_max_age IS NULL OR o.observed_at > NOW() - p_max_age)
  ORDER BY
    -- A trusted row wins, but only while it is still current; past the window
    -- this collapses to plain recency and the newest row wins as before.
    (COALESCE(sp.trusted_rate_basis, FALSE)
       AND o.observed_at > NOW() - INTERVAL '24 hours') DESC,
    o.observed_at DESC
  LIMIT 1
$$;

COMMENT ON FUNCTION display_observation(BIGINT, BOOLEAN, INTERVAL) IS
  'Observation the public read path should display for a dam: the most recent '
  'trusted_rate_basis row within 24h, else the most recent row. Keeps the rate '
  'denominator stable when several sources write the same dam (issue #32). '
  'p_require_volume=FALSE for level-only paths; pass p_max_age on any path that '
  'runs per dam across the whole master, or chunk exclusion is lost.';
