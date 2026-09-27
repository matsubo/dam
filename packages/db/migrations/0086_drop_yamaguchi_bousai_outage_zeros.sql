-- 0086: drop yamaguchi-bousai's outage placeholders (貯水位 0.00 rows).
--
-- 山口県土木防災情報システム prints a telemetry outage as 貯水位 0.00 with
-- 貯水率 / 流入量 / 全放流量 all 0. ingest_yamaguchi_bousai stored those as
-- readings, so the chart drew the reservoir dropping to EL 0 m and back.
--
-- Evidence (prod, 2026-09-27): 283 rows on 10 dams between 2026-06-10 and
-- 2026-09-14 have water_level_m = 0, and every one of them also has rate,
-- inflow and outflow 0 (or NULL). No dam in the feed sits anywhere near
-- EL 0 m — the lowest real level recorded is 見島's 19.23 m. kasenbosai, fed
-- by the same prefectural telemetry, shows the same outage at those
-- timestamps on 9 of the 10 dams (no level, or the same 0), and on the 10th,
-- 小瀬川, it holds real levels of 209.4–211.3 m where this source wrote 0.
--
-- The adapter now skips such rows, so no new ones arrive. A row carrying
-- nothing but zeros has no reading to keep, so it is deleted rather than
-- NULLed (0038's approach, for rows whose other fields were real).
--
-- Scoped to exactly that shape: a 0 level on a row that could hold any real
-- value (a non-zero rate, flow or a volume) is left alone. No-op on a fresh
-- database.
DELETE FROM observations
WHERE source_id = 'yamaguchi-bousai'
  AND water_level_m = 0
  AND storage_volume_m3 IS NULL
  AND COALESCE(storage_rate, 0) = 0
  AND COALESCE(inflow_m3s, 0) = 0
  AND COALESCE(outflow_m3s, 0) = 0;
