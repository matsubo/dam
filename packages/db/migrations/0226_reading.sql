-- The reading: one rule, in one place (docs/adr/0002, GLOSSARY "Reading").
--
-- Before this, five pick rules existed: display_observation() (trusted 24 h,
-- newest, priority, source_id), the newestFirst() fragment in TypeScript
-- (newest, priority, source_id; no trusted preference, no value test), the
-- map's copy of it, the watershed series' per-dam source pick, and
-- preferredSourceForDam() (priority only, any row, no tie-break). 平年比 and
-- 全国貯水率 could therefore stand on a different row than the 貯水量 the dam
-- page shows, and a source writing only empty rows still won the chart.
--
-- source_rank(sp)    an observation's source rank on a timestamp tie: the
--                    source_priorities.priority of an ACTIVE source; inactive
--                    or unlisted sources rank -1, below every active one.
--                    IMMUTABLE (a function of its argument row), so it is
--                    inlined and could appear in a continuous aggregate.
-- dam_reading(...)   the reading of a dam at a moment.
-- window_source(...) the best source for a time window (the chart's source).
--
-- obs_daily is not rebuilt: its last_storage_volume_m3 (0223) already is the
-- daily value — the day's newest row carrying a volume, ties by source_rank's
-- ordering and source_id, no trusted preference. Its definition cannot call
-- source_rank() without a rebuild that would change no row.

CREATE FUNCTION source_rank(sp source_priorities) RETURNS INTEGER
LANGUAGE sql
IMMUTABLE
AS $$ SELECT COALESCE(CASE WHEN sp.active THEN sp.priority END, -1) $$;

COMMENT ON FUNCTION source_rank(source_priorities) IS
  'Tie-break rank of a source (GLOSSARY: Reading): its priority while active, '
  'else -1. Pass the LEFT JOINed source_priorities row; a missing row ranks -1.';

-- The rule, as one ORDER BY over a bounded set of rows:
--   1. a trusted source's row within 24 h of the moment that carries the
--      source's own rate (non-NULL, quality_flag bit 32 unset) — a derived
--      rate is 有効-based whatever the source's basis is (#32, #45);
--   2. else the newest row that carries a value;
--   then source_rank, then source_id.
-- The rows are bounded below by p_window when given; otherwise by
-- LEAST(t*, moment − 24 h), t* being the newest row with a value: rule 1
-- only looks inside the last 24 h and nothing after t* carries a value, so
-- the bound is exact. It is what keeps a 5-year look-back from sorting a
-- dam's whole history. The trusted key comes first, so the scan is never
-- an ordered append: an ordered append keeps a Merge Append over every
-- partially compressed chunk, which startup exclusion does not prune.
--
-- p_need_volume  only rows with a 貯水量 (every 貯水量 / 貯水率 view);
--                FALSE for the dam page, which also shows 水位 and flows.
-- p_window       only rows newer than the moment minus this. Any caller that
--                runs this per dam across the master SHOULD pass it: a
--                constant window prunes chunks at plan time. A reading older
--                than a view's freshness window is the same reading,
--                presented as absent.
-- p_as_of        the moment; NULL = now (and no upper bound on observed_at).
CREATE FUNCTION dam_reading(
  p_dam_id      BIGINT,
  p_need_volume BOOLEAN     DEFAULT TRUE,
  p_window      INTERVAL    DEFAULT NULL,
  p_as_of       TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (
  observed_at           TIMESTAMPTZ,
  source_id             TEXT,
  storage_volume_m3     NUMERIC,
  storage_rate          NUMERIC,
  water_level_m         NUMERIC,
  inflow_m3s            NUMERIC,
  outflow_m3s           NUMERIC,
  rainfall_mm           NUMERIC,
  quality_flag          SMALLINT,
  -- GLOSSARY "Effective capacity": the denominator of this reading's 貯水率.
  effective_capacity_m3 NUMERIC,
  -- 貯水率 = storage_volume_m3 / effective_capacity_m3; NULL without a volume
  -- or a positive denominator. Unclipped: clipping is a view's choice.
  rate                  NUMERIC,
  -- The source published storage_rate itself on its trusted basis.
  rate_published        BOOLEAN
)
LANGUAGE sql
STABLE
AS $$
  SELECT o.observed_at, o.source_id, o.storage_volume_m3, o.storage_rate,
         o.water_level_m, o.inflow_m3s, o.outflow_m3s, o.rainfall_mm, o.quality_flag,
         e.cap,
         CASE WHEN e.cap > 0 THEN o.storage_volume_m3 / e.cap END,
         COALESCE(sp.trusted_rate_basis, FALSE)
           AND o.storage_rate IS NOT NULL AND (COALESCE(o.quality_flag, 0) & 32) = 0
  FROM observations o
  LEFT JOIN source_priorities sp ON sp.source_id = o.source_id
  JOIN dams d ON d.id = o.dam_id
  CROSS JOIN LATERAL (
    SELECT effective_active_capacity_m3(d.active_capacity_m3, o.storage_volume_m3,
                                        o.storage_rate, COALESCE(sp.trusted_rate_basis, FALSE)) AS cap
  ) e
  WHERE o.dam_id = p_dam_id
    AND o.source_id <> 'synthetic'
    AND observation_has_value(o)
    AND (NOT p_need_volume OR o.storage_volume_m3 IS NOT NULL)
    AND (p_as_of IS NULL OR o.observed_at <= p_as_of)
    AND (p_window IS NULL
         OR o.observed_at > (CASE WHEN p_as_of IS NULL THEN NOW() ELSE p_as_of END) - p_window)
    AND (p_window IS NOT NULL
         OR o.observed_at >= LEAST(
              (SELECT t.observed_at FROM observations t
               WHERE t.dam_id = p_dam_id
                 AND t.source_id <> 'synthetic'
                 AND observation_has_value(t)
                 AND (NOT p_need_volume OR t.storage_volume_m3 IS NOT NULL)
                 AND (p_as_of IS NULL OR t.observed_at <= p_as_of)
               ORDER BY t.observed_at DESC
               LIMIT 1),
              (CASE WHEN p_as_of IS NULL THEN NOW() ELSE p_as_of END) - INTERVAL '24 hours'))
  ORDER BY
    (COALESCE(sp.trusted_rate_basis, FALSE)
       AND o.storage_rate IS NOT NULL
       AND (COALESCE(o.quality_flag, 0) & 32) = 0
       AND o.observed_at > (CASE WHEN p_as_of IS NULL THEN NOW() ELSE p_as_of END) - INTERVAL '24 hours') DESC,
    o.observed_at DESC,
    source_rank(sp) DESC,
    o.source_id DESC
  LIMIT 1
$$;

COMMENT ON FUNCTION dam_reading(BIGINT, BOOLEAN, INTERVAL, TIMESTAMPTZ) IS
  'The reading of a dam at a moment (GLOSSARY: Reading, docs/adr/0002): a trusted '
  'source''s own rate within 24 h, else the newest row carrying a value; ties by '
  'source_rank, then source_id; synthetic never. Returns the effective capacity too. '
  'Pass p_window on per-dam calls across the master so chunks prune at plan time.';

-- The chart's source for [p_from, p_to): the best-ranked source with a value
-- in the window (ties by source_id). A source writing only empty rows no
-- longer wins the chart (ingest_nagano_kigyo's 高遠 note). p_prefer_volume
-- puts sources that carried a 貯水量 in the window first (the watershed sum).
-- A table function so a per-dam LATERAL call is inlined.
CREATE FUNCTION window_source(
  p_dam_id         BIGINT,
  p_from           TIMESTAMPTZ,
  p_to             TIMESTAMPTZ,
  p_prefer_volume  BOOLEAN DEFAULT FALSE
)
RETURNS TABLE (source_id TEXT)
LANGUAGE sql
STABLE
AS $$
  SELECT o.source_id
  FROM observations o
  LEFT JOIN source_priorities sp ON sp.source_id = o.source_id
  WHERE o.dam_id = p_dam_id
    AND o.observed_at >= p_from
    AND o.observed_at <  p_to
    AND o.source_id <> 'synthetic'
    AND observation_has_value(o)
  GROUP BY o.source_id, source_rank(sp)
  ORDER BY p_prefer_volume AND bool_or(o.storage_volume_m3 IS NOT NULL) DESC,
           source_rank(sp) DESC,
           o.source_id DESC
  LIMIT 1
$$;

COMMENT ON FUNCTION window_source(BIGINT, TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN) IS
  'Best source for a dam over [p_from, p_to): highest source_rank among sources '
  'with a value there, then source_id; p_prefer_volume ranks volume-carrying sources first.';

DROP FUNCTION display_observation(BIGINT, BOOLEAN, INTERVAL);
