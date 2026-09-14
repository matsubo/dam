-- 0049: pick the observation the site displays by rate basis, not by clock
-- alone.
--
-- Issue #32. 北海道開発局's 18 直轄ダム are ingested by `hkd-mlit-dam` every
-- hour at :13 (10-minute values); `kasenbosai-v2` lands at :03 (hourly). Every
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
-- So: prefer a trusted-basis row while one is recent enough to be current, and
-- fall back to the newest row otherwise. kasenbosai-v2 is hourly, so the
-- preferred row is normally under an hour old — the display trades up to an
-- hour of freshness for a denominator that does not change under the reader.
-- The volume comes from the same row as the rate, so the two always agree.

CREATE OR REPLACE FUNCTION display_observation(p_dam_id BIGINT)
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
    AND o.storage_volume_m3 IS NOT NULL
    -- 'synthetic' was retired in 0045 but old rows remain in compressed
    -- chunks; the detail page already filtered it out and this function is
    -- now the single definition of "the row we display".
    AND o.source_id <> 'synthetic'
  ORDER BY
    -- A trusted row wins, but only while it is still current; past the window
    -- this collapses to plain recency and the newest row wins as before.
    (COALESCE(sp.trusted_rate_basis, FALSE)
       AND o.observed_at > NOW() - INTERVAL '24 hours') DESC,
    o.observed_at DESC
  LIMIT 1
$$;

COMMENT ON FUNCTION display_observation(BIGINT) IS
  'Observation the public read path should display for a dam: the most recent '
  'trusted_rate_basis row within 24h, else the most recent row. Keeps the rate '
  'denominator stable when several sources write the same dam (issue #32).';
