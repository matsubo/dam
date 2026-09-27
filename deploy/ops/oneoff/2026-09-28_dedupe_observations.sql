-- One-off (prod, BEFORE the round-3 observations:rebind job): drop the second
-- copy of every observation key stored twice in a compressed chunk.
--
-- Run at a quiet hour; the file is its own transaction (BEGIN … COMMIT):
--   psql -U dam -d dam -v ON_ERROR_STOP=1 -f 2026-09-28_dedupe_observations.sql
-- Run it once more after the round-3 rebind job as a check: it should change
-- nothing and report 0.
-- Needs a superuser (SET LOCAL session_replication_role; dam is one on prod).
-- Then, outside a transaction (the rewritten rows reach back to 2023-12-31):
--   CALL refresh_continuous_aggregate('obs_daily', '2023-12-31', '2026-08-28', force => true);
--   CALL refresh_continuous_aggregate('obs_monthly', '2023-12-01', '2026-09-01', force => true);
-- Not a migration: it rewrites compressed observations.
--
-- Why. observations:rebind (fixed in the same branch) removed the wrong row's
-- copy of a clashing key with DELETE … USING observations, then UPDATEd
-- dam_id. Inside UPDATE/DELETE TimescaleDB decompresses only the target's
-- batches, so the right row's compressed readings were invisible to the
-- self-join, and the UPDATE was not checked against them: in compressed
-- chunks each clash was kept twice under one primary key. Besides doubling
-- sums and counts in obs_daily, it breaks any later DML that decompresses
-- such a batch (an UPDATE, a DELETE not covering whole batches, an upsert onto
-- the key) with "duplicate key value violates unique constraint" — rehearsed
-- on dev. backfill:mudam re-upserting 2024 onto 270/799/1495 would fail so,
-- as could the round-3 rebind, which moves kasenbosai and mudam off NDI 799.
--
-- Evidence (prod, read-only, 2026-09-28; TimescaleDB 2.26.4 on prod and dev):
--   33,219 keys stored exactly twice (33,219 surplus rows); every copy pair
--   is identical in every column but created_at (0 differing groups); each
--   pair sits in one chunk; all 35 chunks are fully compressed (status 1).
--   No duplicate in an uncompressed chunk (08-27 onward): there the
--   DELETE … USING saw both rows and removed the clash.
--     source      keys    NDI (all rebind targets of the round-2 job)     observed_at (UTC)
--     kasenbosai  32,121  253 270 306 553 793 799 906 935 1427 1454 1495  2026-05-19 08:40 …
--                         1681 1701 1839 1878 2155 2454 2468 2579         2026-08-26 23:50
--     mudam        1,098  270 799 1495 (366 each)                          2023-12-31 15:00 …
--                                                                          2024-12-30 15:00
--   Per chunk: mudam 42 keys (14 days × 3 dams) in each of _hyper_1_358 …
--   _hyper_1_382, 12 in _hyper_1_357, 36 in _hyper_1_383; kasenbosai 263,
--   2,034, 2,439, 2,366, 5,855, 6,399, 6,382, 6,383 in _hyper_1_547, 626, 628,
--   630, 632, 732, 734, 736 (2026-05-07 … 08-27).
--   Origin: all 22 (source, NDI) pairs are targets of the round-2
--   observations:rebind (43 moves): the 17 kasenbosai stations stamped on
--   both twins plus kasenbosai 2156→2155 and 800→799, and mudam 269→270,
--   1496→1495, 800→799, where both twins carried the same station. The
--   kasenbosai duplicates start on 05-19, 06-08, 07-03 or 07-06 depending on
--   the dam and end with the newest compressed chunk; each mudam pair has one
--   copy created 2026-05-15 and one 2026-09-27 (the monthly retry that stamped
--   the other twin). A same-key pair can only arise on one dam_id by moving
--   rows, so ingest is not a source. Nothing on the round-1 (#57/0056) move
--   targets, and no duplicate of fukuoka-bodik, qsr-toukan-dam,
--   tochigi-bodik, ehime-bousai or gifu-kasen (the other round-2 moves).
--   Dry run of this file's selection: 183 (chunk, dam) segments in those 35
--   chunks, 91,152 rows read and deleted, 57,933 put back (−33,219). The
--   detection pass takes 43 s on prod; the rest is per segment.
--
-- How. decompress_chunk() cannot be used: it re-inserts every row through the
-- primary key index and fails on the first duplicate. Instead, per (chunk,
-- dam) segment holding a duplicate, the script keeps one row per key (the
-- earliest created_at), deletes the dam's whole segment from that chunk (a
-- DELETE on segmentby dam_id alone drops the compressed batches without
-- decompressing them), inserts the kept rows back and recompresses the chunk.
-- The rows go back unchanged: session_replication_role = replica keeps the
-- storage-rate trigger from deriving a rate for them. Writers to the chunks
-- involved wait for the transaction (EXCLUSIVE lock; reads are not blocked).
-- A key whose copies differ in any column but created_at is not touched: its
-- whole segment is skipped, since the index would refuse both copies back.
-- Such groups are listed by the second SELECT and a NOTICE. Idempotent: a
-- second run finds no duplicate and changes nothing. The last SELECT is the
-- number of duplicate keys left, 0 unless groups were skipped.

BEGIN;
SET LOCAL timescaledb.max_tuples_decompressed_per_dml_transaction = 0;
SET LOCAL session_replication_role = replica;

-- One pass over the table (43 s on prod); the grouping is on plain columns.
CREATE TEMP TABLE dedupe_group ON COMMIT DROP AS
SELECT dam_id, source_id, observed_at, count(*) AS copies,
       count(DISTINCT to_jsonb(o) - 'created_at') AS variants
FROM observations o
GROUP BY dam_id, source_id, observed_at
HAVING count(*) > 1;

CREATE TEMP TABLE dedupe_segment ON COMMIT DROP AS
SELECT format('%I.%I', c.chunk_schema, c.chunk_name)::regclass AS chunk,
       c.range_start, c.range_end, g.dam_id,
       bool_or(g.variants > 1) AS skipped,
       count(*) AS dup_keys,
       sum(g.copies - 1) AS surplus_rows
FROM dedupe_group g
JOIN timescaledb_information.chunks c
  ON c.hypertable_schema = 'public' AND c.hypertable_name = 'observations'
 AND g.observed_at >= c.range_start AND g.observed_at < c.range_end
GROUP BY 1, 2, 3, 4;

CREATE TEMP TABLE dedupe_keep (LIKE observations) ON COMMIT DROP;

-- Each statement names its dam and chunk range as literals, so it reads one
-- segment instead of joining the whole hypertable.
DO $$
DECLARE
  seg record;
  n bigint;
BEGIN
  SELECT count(*) INTO n FROM dedupe_group WHERE variants > 1;
  IF n > 0 THEN
    RAISE NOTICE 'dedupe: % duplicate keys differ beyond created_at; their segments are skipped', n;
  END IF;
  FOR seg IN SELECT DISTINCT chunk FROM dedupe_segment WHERE NOT skipped LOOP
    EXECUTE format('LOCK TABLE %s IN EXCLUSIVE MODE', seg.chunk);
  END LOOP;
  -- Taken after the locks, so no write to these segments is lost.
  FOR seg IN SELECT * FROM dedupe_segment WHERE NOT skipped LOOP
    EXECUTE format(
      'INSERT INTO dedupe_keep SELECT DISTINCT ON (source_id, observed_at) * FROM observations'
      ' WHERE dam_id = %s AND observed_at >= %L AND observed_at < %L'
      ' ORDER BY source_id, observed_at, created_at',
      seg.dam_id, seg.range_start, seg.range_end);
    EXECUTE format('DELETE FROM %s WHERE dam_id = %s', seg.chunk, seg.dam_id);
    EXECUTE format('SELECT count(*) FROM %s WHERE dam_id = %s', seg.chunk, seg.dam_id) INTO n;
    IF n > 0 THEN
      RAISE EXCEPTION 'dedupe: % rows of dam % left in %', n, seg.dam_id, seg.chunk;
    END IF;
  END LOOP;
END $$;

INSERT INTO observations (observed_at, dam_id, source_id, storage_volume_m3, storage_rate,
                          inflow_m3s, outflow_m3s, water_level_m, rainfall_mm,
                          raw_snapshot_id, quality_flag, created_at)
SELECT observed_at, dam_id, source_id, storage_volume_m3, storage_rate,
       inflow_m3s, outflow_m3s, water_level_m, rainfall_mm,
       raw_snapshot_id, quality_flag, created_at
FROM dedupe_keep;

SELECT compress_chunk(chunk) FROM (SELECT DISTINCT chunk FROM dedupe_segment WHERE NOT skipped) c;

-- What was rewritten, per dam and chunk.
SELECT d.external_ids->>'ndi' AS ndi, s.chunk, s.dup_keys, s.surplus_rows
FROM dedupe_segment s JOIN dams d ON d.id = s.dam_id
WHERE NOT s.skipped
ORDER BY s.chunk, 1;

-- Left alone: copies that differ beyond created_at.
SELECT d.external_ids->>'ndi' AS ndi, g.source_id, g.observed_at, g.copies, g.variants
FROM dedupe_group g JOIN dams d ON d.id = g.dam_id
WHERE g.variants > 1
ORDER BY 1, 2, 3;

SELECT count(*) AS duplicate_keys_left
FROM (
  SELECT 1 FROM observations
  GROUP BY dam_id, source_id, observed_at
  HAVING count(*) > 1
) dup;

COMMIT;
