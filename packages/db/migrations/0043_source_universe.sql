-- What each upstream source *publishes*, as opposed to what we managed to ingest.
--
-- Why this exists: /coverage could say a dam had no observations but never why.
-- Every ingest task already fetches the upstream's dam list, matches it to the
-- master by name, and drops the misses at a `log('no master match for …')`
-- line — 75 such sites across apps/worker. That discarded row is exactly the
-- evidence needed to tell "they publish it, we're failing to link it" apart
-- from "nobody publishes it". Record it instead of logging it.
--
-- Rollout is per source. `source_universe_runs` is what makes the negative
-- answer honest: a dam absent from this table means "nobody publishes it"
-- ONLY once every observation-producing source has recorded a run. Until
-- then the dam is 未調査, not 提供なし. Without this table the absence of a
-- row is unfalsifiable and every uninstrumented source silently reads as
-- "no upstream".

CREATE TABLE source_universe (
  source_id          TEXT NOT NULL,
  -- The upstream's own stable id (station code, page id). Sources that
  -- publish no id use the normalised dam name, in which case pref_code is
  -- required so two 「新宮」 in different prefectures don't collide.
  source_external_id TEXT NOT NULL,
  source_name        TEXT NOT NULL,          -- as published upstream
  pref_code          TEXT,
  lat                DOUBLE PRECISION,
  lng                DOUBLE PRECISION,
  -- NULL = upstream publishes this station but we can't tie it to a master
  -- dam. That is the actionable backlog.
  resolved_dam_id    BIGINT REFERENCES dams(id) ON DELETE SET NULL,
  first_seen_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Bumped on every scan. A row whose last_seen_at stops advancing means the
  -- upstream dropped the station.
  last_seen_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (source_id, source_external_id)
);

CREATE INDEX source_universe_resolved
  ON source_universe (resolved_dam_id) WHERE resolved_dam_id IS NOT NULL;

-- One row per source that has recorded its full published list at least once.
CREATE TABLE source_universe_runs (
  source_id         TEXT PRIMARY KEY,
  last_full_scan_at TIMESTAMPTZ NOT NULL,
  row_count         INT NOT NULL
);

-- Master/registry sources describe dam identity, not observations, so they
-- are not part of the "has every source been scanned?" gate.
ALTER TABLE source_priorities
  ADD COLUMN provides_observations BOOLEAN NOT NULL DEFAULT TRUE;

UPDATE source_priorities SET provides_observations = FALSE
  WHERE source_id IN ('ndi', 'damnet');
