-- One-off (prod, after fix(tokyo-waterworks) — page-dated observations, no
-- 村山・山口 row, migration 0162 — is deployed): delete the weekend/holiday
-- copies the old task dated by the run date, delete the 村山・山口 total it
-- stored on 村山下（再）, and move 小河内's rows to the 7時 the page gives.
--
-- Run once; the file is its own transaction (BEGIN … COMMIT):
--   psql -U dam -d dam -v ON_ERROR_STOP=1 -f 2026-09-28_tokyo_waterworks_dates.sql
-- then, outside it (obs_daily / obs_monthly still hold the deleted rows):
--   SELECT graphile_worker.add_job('aggregates:refresh');
-- Not a migration: most of these rows sit in compressed chunks, and DML that
-- decompresses them does not belong in the migrate path (runbook §9). It
-- aborts unless 0162 is applied, i.e. unless the fixed task is deployed.
--
-- Why. 東京都水道局's 貯水量情報 page (waterworks.metro.tokyo.lg.jp/suigen/
-- suigen) carries 「令和N年M月D日(X曜日)」 and per table 「利根川水系 0時現在」,
-- 「荒川水系 0時現在」, 「多摩川水系 7時現在」, and it is updated on business
-- days only (on Monday 2026-09-28 it still read 令和8年9月25日(金曜日)). The
-- old task stamped every row with the run date at 00:00 JST, so:
--
--   1. Every weekend and holiday got a copy of the previous business day. Per
--      observed_at, the 15 stored rows are identical to the previous day's
--      on exactly 48 of 145 days (2026-05-07 .. 09-28): every Sat/Sun, 7/20,
--      8/11, 9/21–9/23, and 9/28 (the page had not moved by the 12:00/18:00
--      runs). The other 97 are genuine: from 06-06, when ktr-tone-dam starts,
--      the stored volume on a genuine day equals ktr-tone-dam's at the same
--      instant on 7–9 of the 利根川 dams they share, and on a copied day on
--      0–1 (e.g. 奈良俣 stored 70,426,000 on 9/25–9/28; ktr-tone-dam 09-25
--      00:00 70,426,000, then 69,815,000 / 69,347,000 / 68,774,000). A copy
--      is recognised by all 15 rows repeating together, which no genuine day
--      does.
--   2. 村山・山口貯水池 is the total of three reservoirs (3,435 万m³ =
--      村山上 + 村山下 + 山口, see 0162) and was stored on 村山下（再）
--      (NDI 706, 有効 11,843,000 m³): 16,512,000 .. 26,946,000 m³. The row
--      was only ever stamped with that listing, and no other source writes
--      the dam, so every tokyo-waterworks row on it is the total. Deleted.
--   3. 小河内 (NDI 709) is in the 多摩川 table, 「7時現在」. The captures on
--      2025-10-16, 2026-06-05 (web.archive.org) and 2026-09-28 all say 7時,
--      and against kasenbosai's hourly 小河内 (86 days since it starts on
--      7/3) the stored value equals the reading nearest 07:00 JST 22 times
--      and the one nearest 00:00 4 times. Its genuine rows move from 00:00
--      to 07:00 JST; a row the fixed task already wrote at 07:00 wins over
--      the moved copy (same page, same values).
--
-- Dry run (prod, 2026-09-28): 2,175 tokyo-waterworks rows on 15 dams, 145
-- days. Step 1 deletes 720 (48 days × 15), step 2 the other 97 on NDI 706,
-- step 3 moves 97. 1,358 rows remain: 97 days on each of 14 dams.
--
-- Scoped to source tokyo-waterworks and its dams by NDI id. Step 1 only looks
-- at days the old task wrote (小河内 at 00:00 JST; the fixed task writes it
-- at 07:00), and step 3 moves those rows off 00:00, so a second run finds no
-- such day and changes nothing. The final SELECT should report 0, 0, 0.

BEGIN;
SET LOCAL timescaledb.max_tuples_decompressed_per_dml_transaction = 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM _migrations WHERE name = '0162_tokyo_waterworks_murayama_total.sql'
  ) THEN
    RAISE EXCEPTION '0162 is not applied: deploy fix(tokyo-waterworks) first';
  END IF;
END
$$;

CREATE TEMP TABLE tokyo_waterworks_dams ON COMMIT DROP AS
SELECT id AS dam_id, external_ids ->> 'ndi' AS ndi
FROM dams
WHERE external_ids ->> 'ndi' IN ('611', '571', '583', '637', '638', '596', '587', '636', '614',
                                 '694', '698', '696', '702', '709', '706');

-- 1. Days whose rows all repeat the previous day's, among the old task's days.
CREATE TEMP TABLE tokyo_waterworks_copies ON COMMIT DROP AS
WITH old_days AS (
  SELECT o.observed_at
  FROM observations o
  JOIN tokyo_waterworks_dams t ON t.dam_id = o.dam_id AND t.ndi = '709'
  WHERE o.source_id = 'tokyo-waterworks'
    AND extract(hour FROM o.observed_at AT TIME ZONE 'Asia/Tokyo') = 0
), snapshots AS (
  SELECT o.observed_at,
         string_agg(o.dam_id || ':' || coalesce(o.storage_volume_m3::text, '-')
                    || ':' || coalesce(o.storage_rate::text, '-'), ',' ORDER BY o.dam_id) AS sig
  FROM observations o
  JOIN old_days USING (observed_at)
  JOIN tokyo_waterworks_dams t ON t.dam_id = o.dam_id
  WHERE o.source_id = 'tokyo-waterworks'
  GROUP BY o.observed_at
), chained AS (
  SELECT observed_at, sig, lag(sig) OVER (ORDER BY observed_at) AS previous_sig
  FROM snapshots
)
SELECT observed_at FROM chained WHERE sig = previous_sig;

DELETE FROM observations o
USING tokyo_waterworks_copies c, tokyo_waterworks_dams t
WHERE o.source_id = 'tokyo-waterworks'
  AND o.observed_at = c.observed_at
  AND o.dam_id = t.dam_id;

-- 2. The 村山・山口 total on 村山下（再）.
DELETE FROM observations o
USING tokyo_waterworks_dams t
WHERE o.source_id = 'tokyo-waterworks'
  AND o.dam_id = t.dam_id
  AND t.ndi = '706';

-- 3. 小河内 00:00 → 07:00 JST.
INSERT INTO observations (observed_at, dam_id, source_id, storage_volume_m3, storage_rate,
                          inflow_m3s, outflow_m3s, water_level_m, rainfall_mm,
                          raw_snapshot_id, quality_flag)
SELECT o.observed_at + interval '7 hours', o.dam_id, o.source_id, o.storage_volume_m3,
       o.storage_rate, o.inflow_m3s, o.outflow_m3s, o.water_level_m, o.rainfall_mm,
       o.raw_snapshot_id, o.quality_flag
FROM observations o
JOIN tokyo_waterworks_dams t ON t.dam_id = o.dam_id AND t.ndi = '709'
WHERE o.source_id = 'tokyo-waterworks'
  AND extract(hour FROM o.observed_at AT TIME ZONE 'Asia/Tokyo') = 0
ON CONFLICT (dam_id, observed_at, source_id) DO NOTHING;

DELETE FROM observations o
USING tokyo_waterworks_dams t
WHERE o.source_id = 'tokyo-waterworks'
  AND o.dam_id = t.dam_id
  AND t.ndi = '709'
  AND extract(hour FROM o.observed_at AT TIME ZONE 'Asia/Tokyo') = 0;

-- Days left whose 00:00 rows all repeat the previous day's, rows left on
-- 村山下（再）, 小河内 rows left at 00:00 JST.
WITH snapshots AS (
  SELECT o.observed_at,
         string_agg(o.dam_id || ':' || coalesce(o.storage_volume_m3::text, '-')
                    || ':' || coalesce(o.storage_rate::text, '-'), ',' ORDER BY o.dam_id) AS sig
  FROM observations o
  JOIN tokyo_waterworks_dams t ON t.dam_id = o.dam_id
  WHERE o.source_id = 'tokyo-waterworks'
    AND extract(hour FROM o.observed_at AT TIME ZONE 'Asia/Tokyo') = 0
  GROUP BY o.observed_at
), chained AS (
  SELECT sig, lag(sig) OVER (ORDER BY observed_at) AS previous_sig FROM snapshots
)
SELECT
  (SELECT count(*) FROM chained WHERE sig = previous_sig) AS copied_days,
  (SELECT count(*) FROM observations o JOIN tokyo_waterworks_dams t ON t.dam_id = o.dam_id
   WHERE o.source_id = 'tokyo-waterworks' AND t.ndi = '706') AS murayama_rows,
  (SELECT count(*) FROM observations o JOIN tokyo_waterworks_dams t ON t.dam_id = o.dam_id
   WHERE o.source_id = 'tokyo-waterworks' AND t.ndi = '709'
     AND extract(hour FROM o.observed_at AT TIME ZONE 'Asia/Tokyo') = 0) AS ogochi_at_midnight;

COMMIT;
