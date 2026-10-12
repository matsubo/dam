-- Deterministic "last value" when several sources report the same timestamp.
--
-- Why. Several sources often publish the same dam at the same observed_at
-- (prefecture 防災 feeds and kasenbosai both stamp the hour). Every "newest
-- reading" pick ordered by observed_at alone, so on a tie the row came from
-- whichever source the plan met last:
--   - obs_daily.last_storage_volume_m3 = last(storage_volume_m3, observed_at):
--     a refresh could flip a day between two sources' volumes, or to NULL when
--     the tied row was a level-only source's. It also returned NULL whenever
--     the day's newest row had no volume, although the day had volumes. On a
--     restored copy of prod (2026-10-12) 3,262 dam-days had such a tie, and
--     5,423 of 1,060,115 materialized days differ from the rule below (5,413
--     NULL where the day has a volume, 10 another source's volume).
--   - display_observation(), the dam page's reading, had no tie-break either.
--
-- The rule, everywhere: among the candidate rows, the newest observed_at
-- wins; on a tie, the source with the higher source_priorities.priority (an
-- inactive or unlisted source ranks below every active one, as in
-- preferredSourceForDam and the watershed series), then the greater
-- source_id. obs_daily's last value only considers rows that carry a volume,
-- as display_observation(dam) does for the volume it displays.
--
-- obs_daily has to be redefined for that (a continuous aggregate's query
-- cannot be altered), and obs_monthly is built on it. To keep both readable
-- throughout, the new pair is built under other names, filled from the same
-- queries a refresh runs, and swapped in at the end of this transaction:
-- readers only wait for the drop/rename at the end (well under a second on a
-- restored copy of prod; the whole migration took ~10 s there). Each new
-- aggregate starts with its whole range marked invalid, so its policy (and
-- aggregates:refresh) re-materializes anything written while this ran.
--
-- The tie-break reads source_priorities at materialization time; a later
-- change of priorities reaches old days only through a forced refresh.

SET LOCAL lock_timeout = '10s';
SET LOCAL work_mem = '256MB';

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
    o.observed_at DESC,
    -- Same timestamp from several sources: source priority, then source_id (0223).
    COALESCE(CASE WHEN sp.active THEN sp.priority END, -1) DESC,
    o.source_id DESC
  LIMIT 1
$$;

COMMENT ON FUNCTION display_observation(BIGINT, BOOLEAN, INTERVAL) IS
  'Observation the public read path should display for a dam: the most recent '
  'trusted_rate_basis row within 24h that carries a rate the source published '
  'itself (non-NULL, quality_flag bit 32 unset), else the most recent row; on a '
  'timestamp tie the higher active source_priorities.priority, then source_id. '
  'Keeps the rate denominator stable when several sources write the same dam '
  '(issues #32, #45). p_require_volume=FALSE for level-only paths; pass p_max_age '
  'on any path that runs per dam across the whole master, or chunk exclusion is lost.';

-- Same columns, names and order as 0015's obs_daily; only last_storage_volume_m3
-- changes. The ROW key orders by time, then rank, then source_id.
CREATE MATERIALIZED VIEW obs_daily_next WITH (timescaledb.continuous, timescaledb.materialized_only = true) AS
SELECT
  o.dam_id,
  time_bucket('1 day', o.observed_at) AS day,
  avg(o.storage_volume_m3)            AS avg_storage_volume_m3,
  max(o.storage_volume_m3)            AS max_storage_volume_m3,
  min(o.storage_volume_m3)            AS min_storage_volume_m3,
  last(o.storage_volume_m3,
       ROW(o.observed_at, COALESCE(CASE WHEN sp.active THEN sp.priority END, -1), o.source_id))
    FILTER (WHERE o.storage_volume_m3 IS NOT NULL) AS last_storage_volume_m3,
  avg(o.storage_rate)                 AS avg_storage_rate,
  sum(o.rainfall_mm)                  AS total_rainfall_mm,
  count(*) FILTER (WHERE o.storage_volume_m3 IS NOT NULL) AS n_storage_volume,
  count(*) FILTER (WHERE o.rainfall_mm      IS NOT NULL) AS n_rainfall
FROM observations o
LEFT JOIN source_priorities sp ON sp.source_id = o.source_id
GROUP BY o.dam_id, day
WITH NO DATA;

-- Unchanged from 0015, now on top of obs_daily_next.
CREATE MATERIALIZED VIEW obs_monthly_next WITH (timescaledb.continuous, timescaledb.materialized_only = true) AS
SELECT
  dam_id,
  time_bucket('1 month', day) AS month,
  avg(avg_storage_volume_m3) AS avg_storage_volume_m3,
  max(max_storage_volume_m3) AS max_storage_volume_m3,
  min(min_storage_volume_m3) AS min_storage_volume_m3,
  sum(total_rainfall_mm)     AS total_rainfall_mm
FROM obs_daily_next
GROUP BY dam_id, month
WITH NO DATA;

-- Fill both from their own partial views (the query a refresh inserts from),
-- add 0222's unique key under a temporary name, then swap.
DO $$
DECLARE
  daily_mat    regclass;
  daily_part   regclass;
  monthly_mat  regclass;
  monthly_part regclass;
BEGIN
  SELECT format('%I.%I', ca.materialization_hypertable_schema, ca.materialization_hypertable_name)::regclass,
         format('%I.%I', c.partial_view_schema, c.partial_view_name)::regclass
  INTO STRICT daily_mat, daily_part
  FROM timescaledb_information.continuous_aggregates ca
  JOIN _timescaledb_catalog.continuous_agg c
    ON c.user_view_schema = ca.view_schema AND c.user_view_name = ca.view_name
  WHERE ca.view_schema = 'public' AND ca.view_name = 'obs_daily_next';

  SELECT format('%I.%I', ca.materialization_hypertable_schema, ca.materialization_hypertable_name)::regclass,
         format('%I.%I', c.partial_view_schema, c.partial_view_name)::regclass
  INTO STRICT monthly_mat, monthly_part
  FROM timescaledb_information.continuous_aggregates ca
  JOIN _timescaledb_catalog.continuous_agg c
    ON c.user_view_schema = ca.view_schema AND c.user_view_name = ca.view_name
  WHERE ca.view_schema = 'public' AND ca.view_name = 'obs_monthly_next';

  EXECUTE format('INSERT INTO %s SELECT * FROM %s', daily_mat, daily_part);
  EXECUTE format('CREATE UNIQUE INDEX obs_daily_next_dam_id_day_key ON %s (dam_id, day)', daily_mat);
  EXECUTE format('INSERT INTO %s SELECT * FROM %s', monthly_mat, monthly_part);

  DROP MATERIALIZED VIEW obs_monthly;
  DROP MATERIALIZED VIEW obs_daily;
  ALTER MATERIALIZED VIEW obs_daily_next RENAME TO obs_daily;
  ALTER MATERIALIZED VIEW obs_monthly_next RENAME TO obs_monthly;
  EXECUTE format('ALTER INDEX %I.obs_daily_next_dam_id_day_key RENAME TO obs_daily_dam_id_day_key',
                 (SELECT n.nspname FROM pg_class r JOIN pg_namespace n ON n.oid = r.relnamespace
                  WHERE r.oid = daily_mat));
END $$;

-- Same policies as 0015 (dropped with the old aggregates).
SELECT add_continuous_aggregate_policy(
  'obs_daily',
  start_offset => INTERVAL '60 days',
  end_offset   => INTERVAL '1 hour',
  schedule_interval => INTERVAL '30 minutes'
);

SELECT add_continuous_aggregate_policy(
  'obs_monthly',
  start_offset => INTERVAL '5 years',
  end_offset   => INTERVAL '1 day',
  schedule_interval => INTERVAL '1 day'
);
