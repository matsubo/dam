-- Daily aggregate, one bucket per dam per day, summarized across all sources.
-- For per-source separation see continuous-agg refinement in Plan 3.
CREATE MATERIALIZED VIEW obs_daily WITH (timescaledb.continuous) AS
SELECT
  dam_id,
  time_bucket('1 day', observed_at) AS day,
  avg(storage_volume_m3)            AS avg_storage_volume_m3,
  max(storage_volume_m3)            AS max_storage_volume_m3,
  min(storage_volume_m3)            AS min_storage_volume_m3,
  last(storage_volume_m3, observed_at) AS last_storage_volume_m3,
  avg(storage_rate)                 AS avg_storage_rate,
  sum(rainfall_mm)                  AS total_rainfall_mm,
  count(*) FILTER (WHERE storage_volume_m3 IS NOT NULL) AS n_storage_volume,
  count(*) FILTER (WHERE rainfall_mm      IS NOT NULL) AS n_rainfall
FROM observations
GROUP BY dam_id, day
WITH NO DATA;

SELECT add_continuous_aggregate_policy(
  'obs_daily',
  start_offset => INTERVAL '60 days',
  end_offset   => INTERVAL '1 hour',
  schedule_interval => INTERVAL '30 minutes'
);

CREATE MATERIALIZED VIEW obs_monthly WITH (timescaledb.continuous) AS
SELECT
  dam_id,
  time_bucket('1 month', day) AS month,
  avg(avg_storage_volume_m3) AS avg_storage_volume_m3,
  max(max_storage_volume_m3) AS max_storage_volume_m3,
  min(min_storage_volume_m3) AS min_storage_volume_m3,
  sum(total_rainfall_mm)     AS total_rainfall_mm
FROM obs_daily
GROUP BY dam_id, month
WITH NO DATA;

SELECT add_continuous_aggregate_policy(
  'obs_monthly',
  start_offset => INTERVAL '5 years',
  end_offset   => INTERVAL '1 day',
  schedule_interval => INTERVAL '1 day'
);
