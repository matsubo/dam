CREATE TABLE raw_snapshots (
  id              BIGSERIAL PRIMARY KEY,
  source_id       TEXT NOT NULL,
  target_id       TEXT NOT NULL,
  fetched_at      TIMESTAMPTZ NOT NULL,
  storage_uri     TEXT NOT NULL,                  -- e.g. s3://dam-raw/raw/kasenbosai/...
  http_status     INT,
  etag            TEXT,
  bytes           INT,
  content_type    TEXT,
  parse_status    TEXT NOT NULL DEFAULT 'pending'
                  CHECK (parse_status IN ('pending','parsed','parse_error','skipped')),
  parse_error     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_id, target_id, fetched_at)
);

CREATE INDEX raw_snapshots_source_fetched_at
  ON raw_snapshots (source_id, fetched_at DESC);

ALTER TABLE observations
  ADD CONSTRAINT observations_raw_snapshot_fk
  FOREIGN KEY (raw_snapshot_id) REFERENCES raw_snapshots(id) ON DELETE SET NULL;
