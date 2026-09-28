-- One-off (prod, after the fix(jwa-chikugo) fix that dates rows by the page's
-- 水源情報【令和N年M月D日】 heading is deployed): delete the jwa-chikugo rows
-- the old task fabricated on 閉庁日 by re-stamping an unchanged page with the
-- run date.
--
-- Run once; the file is its own transaction (BEGIN … COMMIT):
--   psql -U dam -d dam -v ON_ERROR_STOP=1 -f 2026-09-28_jwa_chikugo_closed_day_repeats.sql
-- then, outside it (obs_daily / obs_monthly still average the repeats in):
--   SELECT graphile_worker.add_job('aggregates:refresh');
-- Not a migration: most of these rows sit in compressed chunks (runbook §9).
--
-- Why. water-source.html carries one edition per business day, dated in its
-- heading (水源情報【令和8年9月25日】, 0時 readings of that day; "※閉庁日を除き
-- 毎日更新"). The old task stamped whatever it fetched at 10:00 JST with that
-- day's 0時, so every Saturday, Sunday and holiday got a row, and the page
-- still showed the last business day's edition. On 2026-09-28 (Mon) 12:55 JST
-- the page was still the 9/25 edition; prod held its values (江川 2,903 千m³)
-- under 9/26, 9/27 and 9/28 alike. Every Sunday row in prod (138 of 138)
-- equals the Saturday row, and 7/20 and 9/21–23 repeat in full.
--
-- Scope, deliberately narrow: a row goes only if its JST date is a 閉庁日 (no
-- edition is ever dated that day) AND its volume and rate exactly equal the
-- same dam's row one day earlier. The previous-day comparison reads the
-- pre-statement snapshot, so a run of closed days (Sun after Sat, 9/21–23)
-- goes as a whole. Kept, though also wrongly dated: a closed-day row that
-- differs from the day before (106: 100 Saturday rows holding the Friday
-- edition that came out after the 10:00 run, and 8/11's six holding the
-- 8/10 one) — the only copy of that edition's values — and every
-- business-day row. The run-date stamp shifted
-- most rows one day late (江川 matches fukuoka-bodik's previous-day 0時
-- volume on 59 dates vs the same day on 17), but which edition each run saw
-- is not recoverable, so they are not re-dated.
--
-- 閉庁日 in the data's range: Saturdays, Sundays, 海の日 7/20, 山の日 8/11,
-- 敬老の日 9/21, 国民の休日 9/22, 秋分の日 9/23; 10/12, 11/3 and 11/23 are
-- listed in case the deploy slips. The prod rows (955, 2026-05-12 ..
-- 2026-09-28 JST) never carry anything but volume and rate.
--
-- Evidence (prod, dry run 2026-09-28 12:57 JST): DELETE 204 of 955 rows on the
-- seven dams — Sundays 138, Saturdays 38, holidays 28. Grows by 7 each closed
-- day until the fix is deployed. Idempotent: a kept row's previous day is
-- unchanged or gone, so a second run deletes nothing. The final SELECT should
-- report 0.

BEGIN;
SET LOCAL timescaledb.max_tuples_decompressed_per_dml_transaction = 0;

CREATE TEMP TABLE jwa_chikugo_closed_days (d date PRIMARY KEY) ON COMMIT DROP;
INSERT INTO jwa_chikugo_closed_days
SELECT d::date
FROM generate_series('2026-05-01'::date, '2026-11-30'::date, interval '1 day') AS d
WHERE extract(isodow FROM d) IN (6, 7)
   OR d::date IN ('2026-07-20', '2026-08-11', '2026-09-21', '2026-09-22', '2026-09-23',
                  '2026-10-12', '2026-11-03', '2026-11-23');

DELETE FROM observations o
USING observations p
WHERE o.source_id = 'jwa-chikugo'
  AND o.dam_id IN (SELECT id FROM dams
                   WHERE external_ids ->> 'ndi' IN ('2468', '2474', '2477', '2479', '2480', '2484', '2486'))
  AND (o.observed_at AT TIME ZONE 'Asia/Tokyo')::date IN (SELECT d FROM jwa_chikugo_closed_days)
  AND p.source_id = 'jwa-chikugo'
  AND p.dam_id = o.dam_id
  AND p.observed_at = o.observed_at - interval '1 day'
  AND o.storage_volume_m3 IS NOT DISTINCT FROM p.storage_volume_m3
  AND o.storage_rate IS NOT DISTINCT FROM p.storage_rate;

SELECT count(*) AS closed_day_repeats_left
FROM observations o
JOIN observations p
  ON p.source_id = o.source_id
 AND p.dam_id = o.dam_id
 AND p.observed_at = o.observed_at - interval '1 day'
WHERE o.source_id = 'jwa-chikugo'
  AND (o.observed_at AT TIME ZONE 'Asia/Tokyo')::date IN (SELECT d FROM jwa_chikugo_closed_days)
  AND o.storage_volume_m3 IS NOT DISTINCT FROM p.storage_volume_m3
  AND o.storage_rate IS NOT DISTINCT FROM p.storage_rate;

COMMIT;
