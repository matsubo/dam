-- One-off (prod; 3ff2fdb `fix(ingest): honor kasenbosai per-field quality
-- codes` has been deployed since 2026-07-03, and
-- 2026-09-28_kasenbosai_empty_rows.sql has run: 0 all-NULL kasenbosai rows
-- left on 2026-09-28): delete the kasenbosai rows made of 欠測 placeholders
-- on stations that never published a value. Run before that script, it
-- matches nothing: the all-NULL rows carry the stations past the cut-off.
--
-- Run once; the file is its own transaction (BEGIN … COMMIT):
--   psql -U dam -d dam -v ON_ERROR_STOP=1 -f 2026-09-28_kasenbosai_flagged_zero_rows.sql
-- Not a migration: the rows sit in compressed chunks, and a DELETE that
-- decompresses them does not belong in the migrate path (runbook §9).
--
-- Until 3ff2fdb, ingest_kasenbosai_v2 ignored the per-field quality code and
-- stored the feed's placeholder 0 for a quantity flagged 欠測 (Ccd 140/160).
-- 0038/0039 nulled the zero volumes and rates, but the zero 貯水位, 流入量 and
-- 放流量 stayed. On 15 stations every quantity is flagged, so every row they
-- have is 0.000 m EL / 0.000 m³/s: after the fix the same hours came out
-- all-NULL (deleted by 2026-09-28_kasenbosai_empty_rows.sql), and nothing with
-- a value has arrived since. The dam pages chart those zeros as readings from
-- 2026-05-19 to 2026-07-03. The prefectures' own feeds show what they were:
-- on 2026-07-01 ~09:30 JST kasenbosai stored 庭木 at 0.000 m while
-- saga-bousai read 93.99 m EL, 0.15 m³/s in; on 2026-09-28 saga-bousai prints
-- 河内 「***」 and nagasaki-kasen prints 樋口 / つづら / 笛吹 「-」 in every field.
--
-- Scope: dams whose WHOLE kasenbosai series is zero-or-NULL in every column
-- and ends before 2026-07-04 (the fix). A station still sending zeros after
-- the fix (藤ノ平, 風連: Ccd 0) is excluded, and so is any dam with a single
-- non-zero kasenbosai value (a 穴あき dam that fills in a flood).
--
-- Dry run (prod, 2026-09-28, read-only): 16,595 rows on 15 dams, 2026-05-19
-- 08:00Z .. 2026-07-03 06:50Z — 白丸調整池, 高遠, 河内防災, 厳木川調整池, 庭木,
-- 繁昌, 天ヶ瀬, 岸川防災, 樋口, つづら, 笛吹, 内谷, 日出生, 地蔵原, 宮の元.
-- Other sources on those dams are untouched.
--
-- Idempotent (a second run deletes nothing); a no-op on a fresh database.
-- The final SELECT reports what is left (expected 0).
--
-- After it, outside a transaction (obs_daily's policy only reaches back 60
-- days):
--   CALL refresh_continuous_aggregate('obs_daily', '2026-05-19', '2026-07-04');
--   CALL refresh_continuous_aggregate('obs_monthly', '2026-05-01', '2026-08-01');

BEGIN;
SET LOCAL timescaledb.max_tuples_decompressed_per_dml_transaction = 0;

CREATE TEMP TABLE placeholder_dams ON COMMIT DROP AS
SELECT dam_id
FROM observations
WHERE source_id = 'kasenbosai'
GROUP BY dam_id
HAVING MAX(observed_at) < '2026-07-04 00:00+00'
   AND BOOL_AND(num_nonnulls(NULLIF(storage_volume_m3, 0), NULLIF(storage_rate, 0),
                             NULLIF(inflow_m3s, 0), NULLIF(outflow_m3s, 0),
                             NULLIF(water_level_m, 0), NULLIF(rainfall_mm, 0)) = 0);

DELETE FROM observations o
USING placeholder_dams p
WHERE o.source_id = 'kasenbosai'
  AND o.dam_id = p.dam_id
  AND o.observed_at < '2026-07-04 00:00+00';

SELECT count(*) AS remaining_placeholder_rows
FROM observations o
JOIN placeholder_dams p ON p.dam_id = o.dam_id
WHERE o.source_id = 'kasenbosai';

COMMIT;
