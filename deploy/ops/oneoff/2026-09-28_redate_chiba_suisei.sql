-- One-off (prod, after the ingest_chiba heading fix is deployed): move six
-- weeks of chiba-suisei rows to the survey date they belong to.
--
-- Run once, as a single transaction:
--   psql -U dam -d dam -v ON_ERROR_STOP=1 -1 -f 2026-09-28_redate_chiba_suisei.sql
-- Not a migration: it rewrites 132 rows of observations, most of them in
-- compressed chunks, which does not belong in the migrate path.
--
-- ingest_chiba.ts dated the 県内ダムの貯水状況 page by the first
-- 「令和X年M月D日H時」 in the HTML, which is the alt text of the chart image
-- above the table — not the table heading 「県内ダム貯水状況（令和X年M月D日現在）」.
-- 千葉県 updates the heading and table every week but the alt text only every
-- other week, so on alternate weeks the new figures were UPSERTed onto the
-- previous week's rows: that week's real values were overwritten and the new
-- week never got a row. The adapter now reads the heading.
--
-- Evidence (prod, 2026-09-27). The chart images are archived per survey date
-- (/suisei/chosui/images/r08MMDD.jpg) and print the 工業用水 total, i.e.
-- 山倉 + 郡 + 豊英 (NDI 691 / 684 / 685), all three bound to this source. Each
-- stored date's sum equals the NEXT survey's image, not its own:
--
--   stored     sum 工業用水   image of stored date   image of +7 days
--   05-25     12,074,800       12,118,400             06-01 12,074,800
--   06-15     12,170,000       12,145,600             06-22 12,170,000
--   07-06     12,253,800       12,249,600             07-13 12,253,800
--   07-27     11,954,300       12,154,200             08-03 11,954,300
--   08-17     12,024,900       12,163,700             08-24 12,024,900
--   09-07     11,808,700       11,981,400             09-14 11,808,700
--
-- The 水道用 totals agree the same way (e.g. 09-07 stored 25,557,455 = the
-- 09-14 image's 25,597,455 minus 奥谷's 40,000, the one dam with no master
-- row). The other five stored dates (06-08, 06-29, 07-21, 08-10, 08-31) match
-- their own images and are left alone. The overwritten weeks' per-dam values
-- are not recoverable; only their totals survive in the images.
--
-- Guarded per date by that 工業用水 sum, so a database whose rows were fetched
-- in the right week (and so hold that week's own figures) is not touched and a
-- second run finds nothing to move. A row already present at the survey date
-- (the fixed adapter re-reading 09-14) wins over the moved copy; the values
-- are identical. The final SELECT reports what remains per date.

CREATE TEMP TABLE chiba_suisei_lagged (stored_at, survey_at, industrial_m3) AS
VALUES
  ('2026-05-25 00:00+00'::timestamptz, '2026-06-01 00:00+00'::timestamptz, 12074800::numeric),
  ('2026-06-15 00:00+00'::timestamptz, '2026-06-22 00:00+00'::timestamptz, 12170000::numeric),
  ('2026-07-06 00:00+00'::timestamptz, '2026-07-13 00:00+00'::timestamptz, 12253800::numeric),
  ('2026-07-27 00:00+00'::timestamptz, '2026-08-03 00:00+00'::timestamptz, 11954300::numeric),
  ('2026-08-17 00:00+00'::timestamptz, '2026-08-24 00:00+00'::timestamptz, 12024900::numeric),
  ('2026-09-07 00:00+00'::timestamptz, '2026-09-14 00:00+00'::timestamptz, 11808700::numeric);

DELETE FROM chiba_suisei_lagged l
WHERE (
  SELECT sum(o.storage_volume_m3)
  FROM observations o
  JOIN dams d ON d.id = o.dam_id
  WHERE o.source_id = 'chiba-suisei'
    AND o.observed_at = l.stored_at
    AND d.external_ids ->> 'ndi' IN ('691', '684', '685')
) IS DISTINCT FROM l.industrial_m3;

INSERT INTO observations (observed_at, dam_id, source_id, storage_volume_m3, storage_rate,
                          inflow_m3s, outflow_m3s, water_level_m, rainfall_mm,
                          raw_snapshot_id, quality_flag)
SELECT l.survey_at, o.dam_id, o.source_id, o.storage_volume_m3, o.storage_rate,
       o.inflow_m3s, o.outflow_m3s, o.water_level_m, o.rainfall_mm,
       o.raw_snapshot_id, o.quality_flag
FROM observations o
JOIN chiba_suisei_lagged l ON o.observed_at = l.stored_at
WHERE o.source_id = 'chiba-suisei'
ON CONFLICT (dam_id, observed_at, source_id) DO NOTHING;

DELETE FROM observations o
USING chiba_suisei_lagged l
WHERE o.source_id = 'chiba-suisei'
  AND o.observed_at = l.stored_at;

DROP TABLE chiba_suisei_lagged;

SELECT observed_at::date AS survey_date, count(*) AS dams
FROM observations
WHERE source_id = 'chiba-suisei' AND observed_at >= '2026-05-25'
GROUP BY 1 ORDER BY 1;
