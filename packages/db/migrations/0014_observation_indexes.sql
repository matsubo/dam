-- Most queries: "give me the time series for one dam"
CREATE INDEX observations_dam_time
  ON observations (dam_id, observed_at DESC);

-- Source-tracking and provenance lookups
CREATE INDEX observations_source_time
  ON observations (source_id, observed_at DESC);

-- Compress chunks older than 30 days (TimescaleDB columnar compression)
ALTER TABLE observations SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'dam_id',
  timescaledb.compress_orderby = 'observed_at DESC, source_id'
);

SELECT add_compression_policy('observations', INTERVAL '30 days', if_not_exists => TRUE);
