-- Time-series of normalized observations.
-- One row per (dam, observed_at, source). Multiple sources can disagree.
CREATE TABLE observations (
  observed_at         TIMESTAMPTZ NOT NULL,
  dam_id              BIGINT NOT NULL REFERENCES dams(id) ON DELETE RESTRICT,
  source_id           TEXT NOT NULL,                 -- 'kasenbosai', 'suimon', etc.

  storage_volume_m3   NUMERIC(18,2),                 -- 貯水量
  storage_rate        NUMERIC(6,4),                  -- 貯水率 [0..1]
  inflow_m3s          NUMERIC(12,3),                 -- 流入量
  outflow_m3s         NUMERIC(12,3),                 -- 放流量
  water_level_m       NUMERIC(8,3),                  -- 水位
  rainfall_mm         NUMERIC(8,2),                  -- 雨量

  raw_snapshot_id     BIGINT,                        -- FK added in 0012
  quality_flag        SMALLINT NOT NULL DEFAULT 0,   -- bitfield
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  PRIMARY KEY (dam_id, observed_at, source_id)
);

SELECT create_hypertable(
  'observations',
  'observed_at',
  chunk_time_interval => INTERVAL '14 days',
  if_not_exists => TRUE
);

COMMENT ON COLUMN observations.quality_flag IS
  'bitfield: 1=missing(imputed), 2=outlier, 4=interpolated, 8=mismatch_with_other_source, 16=manual_review';
