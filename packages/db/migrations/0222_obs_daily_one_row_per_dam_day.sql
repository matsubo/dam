-- obs_daily: one row per (dam_id, day), enforced (#115).
--
-- Why. Production's obs_daily held 41 (dam_id, day) groups twice, each day
-- split into two partial aggregates (a forced full refresh of a restored copy
-- split 988). The split happened in the aggregate, not in the data: on the
-- compressed chunks of `observations` some segments (dam_id) held compressed
-- batches whose observed_at ranges overlap, typically one batch per source.
-- TimescaleDB plans a compressed chunk as if its batches were ordered by the
-- leading orderby column within each segment, so a GroupAggregate on
-- time_bucket(observed_at) took the scan as sorted and closed a group each
-- time the batches interleaved:
--   SELECT dam_id, time_bucket('1 day', observed_at), count(*) FROM observations
--   WHERE dam_id = 10466 AND observed_at >= '2026-06-23' AND observed_at < '2026-06-27'
--   GROUP BY 1, 2;   -- three rows per day, one per source
-- Every refresh of such a range wrote the split rows into obs_daily, and
-- obs_monthly (averages of obs_daily) averaged them in. Any other query that
-- relies on observed_at order within a dam (last(), DISTINCT ON, ORDER BY …
-- LIMIT) was exposed the same way.
--
-- The overlapping batches came from segmentwise recompression on TimescaleDB
-- 2.26.4: compress_chunk on a partially compressed chunk matched new rows
-- against existing batches on every orderby column, so rows of a source whose
-- observed_at fell inside a batch of another source were written as a new,
-- overlapping batch (timescale/timescaledb#9731, fixed in 2.27.0 by #9739).
-- The one-off DML of 2026-09-28 (deploy/ops/oneoff/) left 8 chunks
-- (2026-05-21 .. 2026-09-10) partially compressed and the policy recompressed
-- them that way. Production runs 2.30.2 since 2026-10-12, so recompression no
-- longer creates such batches; the existing ones stay until a chunk is fully
-- recompressed.
--
-- What this does, idempotently (on production the repair was run by hand
-- before this deploy, so only step 3 changes anything there):
--   1. Fully recompress every compressed `observations` chunk with a segment
--      whose batches overlap in observed_at. 0.5 s per chunk on prod's data,
--      but it holds an ACCESS EXCLUSIVE lock on the chunk (readers wait too)
--      until this migration commits: on a database that has such chunks, run
--      it by hand first, one chunk per statement (see #115).
--   2. Recompute the obs_daily rows of every (dam_id, day) stored more than
--      once, straight from `observations`. The GROUP BY uses date_trunc, which
--      the planner cannot match to the batch order, so this cannot split a
--      group even if step 1 missed a chunk. Changing the materialization
--      hypertable invalidates those days for obs_monthly; its policy
--      refreshes them.
--   3. A unique index on (dam_id, day) of obs_daily's materialization
--      hypertable: a refresh that would split a group again fails loudly (the
--      policy job errors, the admin jobs page shows it) instead of storing
--      wrong daily figures. TimescaleDB refuses UNIQUE in CREATE INDEX ON a
--      continuous aggregate, so it goes on the hypertable behind the view.
--      Both refresh paths keep it: DELETE then INSERT (the default), or
--      MERGE on the group columns (timescaledb.enable_merge_on_cagg_refresh).

DO $$
DECLARE
  c record;
  overlapping boolean;
BEGIN
  FOR c IN
    SELECT cs.relid, cs.compress_relid
    FROM timescaledb_information.chunks ch
    JOIN _timescaledb_catalog.compression_settings cs
      ON cs.relid = format('%I.%I', ch.chunk_schema, ch.chunk_name)::regclass
    WHERE ch.hypertable_schema = 'public'
      AND ch.hypertable_name = 'observations'
      AND ch.is_compressed
      AND cs.compress_relid IS NOT NULL
  LOOP
    EXECUTE format(
      $q$SELECT EXISTS (
           SELECT 1 FROM (
             SELECT _ts_meta_min_1,
                    max(_ts_meta_max_1) OVER (
                      PARTITION BY dam_id ORDER BY _ts_meta_min_1, _ts_meta_max_1
                      ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS prev_max
             FROM %s) b
           WHERE _ts_meta_min_1 < prev_max)$q$,
      c.compress_relid)
    INTO overlapping;
    IF overlapping THEN
      RAISE NOTICE 'recompressing % (overlapping batches)', c.relid;
      PERFORM compress_chunk(c.relid, recompress => true);
    END IF;
  END LOOP;
END $$;

DO $$
DECLARE
  mat regclass;
  repaired bigint;
BEGIN
  SELECT format('%I.%I', materialization_hypertable_schema, materialization_hypertable_name)::regclass
  INTO STRICT mat
  FROM timescaledb_information.continuous_aggregates
  WHERE view_schema = 'public' AND view_name = 'obs_daily';

  EXECUTE format(
    'CREATE TEMP TABLE obs_daily_split ON COMMIT DROP AS
       SELECT dam_id, day FROM %s GROUP BY dam_id, day HAVING count(*) > 1',
    mat);
  GET DIAGNOSTICS repaired = ROW_COUNT;
  IF repaired > 0 THEN
    RAISE NOTICE 'obs_daily: recomputing % split (dam_id, day) groups', repaired;
    EXECUTE format(
      'DELETE FROM %s m USING obs_daily_split s WHERE m.dam_id = s.dam_id AND m.day = s.day',
      mat);
    -- Same columns and aggregates as the view (0015_continuous_aggregates.sql).
    EXECUTE format(
      $q$INSERT INTO %s (dam_id, day, avg_storage_volume_m3, max_storage_volume_m3,
                          min_storage_volume_m3, last_storage_volume_m3, avg_storage_rate,
                          total_rainfall_mm, n_storage_volume, n_rainfall)
         SELECT o.dam_id,
                date_trunc('day', o.observed_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',
                avg(o.storage_volume_m3),
                max(o.storage_volume_m3),
                min(o.storage_volume_m3),
                last(o.storage_volume_m3, o.observed_at),
                avg(o.storage_rate),
                sum(o.rainfall_mm),
                count(*) FILTER (WHERE o.storage_volume_m3 IS NOT NULL),
                count(*) FILTER (WHERE o.rainfall_mm IS NOT NULL)
         FROM obs_daily_split s
         JOIN observations o
           ON o.dam_id = s.dam_id
          AND o.observed_at >= s.day
          AND o.observed_at < s.day + INTERVAL '1 day'
         GROUP BY 1, 2$q$,
      mat);
  END IF;

  EXECUTE format('CREATE UNIQUE INDEX obs_daily_dam_id_day_key ON %s (dam_id, day)', mat);
END $$;
