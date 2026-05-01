CREATE TABLE backfill_progress (
  source_id   TEXT NOT NULL,
  dam_id      BIGINT NOT NULL REFERENCES dams(id) ON DELETE CASCADE,
  year        INT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('pending','running','completed','failed','skipped')),
  attempts    INT NOT NULL DEFAULT 0,
  last_error  TEXT,
  started_at  TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  rows_written INT,
  PRIMARY KEY (source_id, dam_id, year)
);

CREATE INDEX backfill_progress_status_year
  ON backfill_progress (status, year DESC);
