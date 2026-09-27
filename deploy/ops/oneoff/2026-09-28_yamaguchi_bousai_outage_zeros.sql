-- One-off (prod, after the ingest_yamaguchi_bousai parser fix is deployed):
-- delete yamaguchi-bousai's outage placeholders (貯水位 0.00 rows).
--
-- Run once; the file is its own transaction (BEGIN … COMMIT):
--   psql -U dam -d dam -v ON_ERROR_STOP=1 -f 2026-09-28_yamaguchi_bousai_outage_zeros.sql
-- Not a migration: most of these rows sit in compressed chunks (242 of 283),
-- and a DELETE that decompresses them does not belong in the migrate path.
--
-- 山口県土木防災情報システム prints a telemetry outage as 貯水位 0.00 with
-- 貯水率 / 流入量 / 全放流量 all 0. The adapter stored those as readings, so
-- the chart drew the reservoir dropping to EL 0 m and back. It now skips
-- them, so no new ones arrive.
--
-- Evidence (prod, 2026-09-27). Dry run of the DELETE predicate below: 283
-- rows on 10 dams, 2026-06-10 06:50Z .. 2026-09-14 07:50Z — every
-- yamaguchi-bousai row with water_level_m = 0, and none of them carries a
-- non-zero rate, flow or any volume:
--
--   NDI   dam          rows      NDI   dam          rows
--   1967  小瀬川        104      2007  荒谷           26
--   2010  真締川         59      1688  湯免            9
--   2013  厚東川         51      2008  一の坂          8
--   1995  中山川         18      1712  阿武川          5
--   1996  末武川          2      1999  川上（再）      1
--
-- No dam in the feed sits anywhere near EL 0 m (the lowest real level stored
-- is 見島's 19.23 m). kasenbosai, fed by the same prefectural telemetry, shows
-- the same outage at those timestamps on 9 of the 10 dams (no level, or the
-- same 0); on 小瀬川 it holds real levels of 209.4–211.3 m where this source
-- wrote 0. A row of nothing but zeros has no reading to keep, so it is
-- deleted rather than NULLed.
--
-- Scoped to the 10 dams by NDI id and to the outage window so only their
-- chunks are touched; idempotent (a second run deletes nothing). The final
-- SELECT reports what is left (expected 0).

BEGIN;
SET LOCAL timescaledb.max_tuples_decompressed_per_dml_transaction = 0;

DELETE FROM observations
WHERE source_id = 'yamaguchi-bousai'
  AND dam_id IN (
    SELECT id FROM dams
    WHERE external_ids ->> 'ndi' IN
      ('1688', '1712', '1967', '1995', '1996', '1999', '2007', '2008', '2010', '2013')
  )
  AND observed_at >= '2026-06-10 00:00+00'
  AND observed_at <  '2026-09-15 00:00+00'
  AND water_level_m = 0
  AND storage_volume_m3 IS NULL
  AND COALESCE(storage_rate, 0) = 0
  AND COALESCE(inflow_m3s, 0) = 0
  AND COALESCE(outflow_m3s, 0) = 0;

SELECT count(*) AS remaining_zero_level_rows
FROM observations
WHERE source_id = 'yamaguchi-bousai' AND water_level_m = 0;

COMMIT;
