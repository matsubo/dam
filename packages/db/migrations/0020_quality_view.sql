-- Per-dam-day missing-rate over the last 24 hours.
-- Only includes dams that have ever been observed (avoid noise from never-collected dams).
CREATE OR REPLACE VIEW quality_missing_24h AS
SELECT
  d.id   AS dam_id,
  d.slug AS dam_slug,
  COUNT(*) AS expected_hours,
  COUNT(o.observed_at) AS present_hours,
  (COUNT(*) - COUNT(o.observed_at))::float / GREATEST(COUNT(*), 1) AS missing_rate
FROM dams d
JOIN generate_series(
  date_trunc('hour', NOW() - INTERVAL '24 hours'),
  date_trunc('hour', NOW()),
  INTERVAL '1 hour'
) AS h(ts) ON TRUE
LEFT JOIN observations o
  ON o.dam_id = d.id
 AND date_trunc('hour', o.observed_at) = h.ts
WHERE EXISTS (SELECT 1 FROM observations o2 WHERE o2.dam_id = d.id)
GROUP BY d.id, d.slug;
