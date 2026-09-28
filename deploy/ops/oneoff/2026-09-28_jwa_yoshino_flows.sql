-- One-off (prod, after the fix(jwa-yoshino) parser fix is deployed): null the
-- inflow / outflow jwa-yoshino stored from the unit label instead of the value.
--
-- Run once; the file is its own transaction (BEGIN … COMMIT):
--   psql -U dam -d dam -v ON_ERROR_STOP=1 -f 2026-09-28_jwa_yoshino_flows.sql
-- No follow-up: obs_daily / obs_monthly carry no inflow or outflow.
-- Not a migration: most of these rows sit in compressed chunks, and DML that
-- decompresses them does not belong in the migrate path (runbook §9).
--
-- Why. 水資源機構 吉野川上流総合管理所 ダム情報掲示板 (mizu/ikeda/mizuinfo/dyn/
-- html/p0001/60/p000101.html) labels the flows
-- `流入量(<span class='unit'>m<sup>3</sup>/s</span>)</th><td>6.94…`. The old
-- parser stripped the tags and took the first number after the label, i.e.
-- the "3" of m³, so every stored 流入量 and 全放流量 is 3.000. 貯水位 (unit
-- EL.m) and 早明浦's 利水貯水率[速報値] (unit ％) carry no digit in their
-- label and were read correctly: no level below EL 87 m, no hour-to-hour
-- jump in rate above 5 points or in level above 2 m, and the 2026-09-28
-- 12:00 JST rows equal the page (88.59 / 293.00 / 220.77 / 442.41 / 279.18,
-- 早明浦 15.0 %). The page keeps no history, so the flows cannot be
-- re-derived; they are nulled.
--
-- Evidence (prod, dry run 2026-09-28 12:56 JST). jwa-yoshino rows, 5 dams,
-- 2026-06-05 01:00Z .. 2026-09-28 03:00Z, 13,815 in all:
--
--   NDI   dam     rows   inflow = outflow = 3
--   2042  富郷   2,763                  2,763
--   2045  池田   2,763                  2,763
--   2048  柳瀬   2,763                  2,763
--   2052  早明浦 2,763                  2,763
--   2053  新宮   2,763                  2,763
--
-- At the 6,767 timestamps ehime-bousai shares on 富郷 / 新宮 / 柳瀬, it never
-- has inflow = outflow = 3 (inflow 3 on 9, outflow 3 on none); at 12:00 JST
-- the page read 柳瀬 6.94 / 6.43, 新宮 4.84 / 1.57, 富郷 4.96 / 4.00.
--
-- Dry-run count: UPDATE 13,815. It grows by five rows an hour until the fix
-- is deployed; run it right after the deploy, as the fixed parser may store
-- a genuine 3.00 / 3.00 reading later.
--
-- Scoped to source jwa-yoshino on the five dams by NDI id, and to rows whose
-- inflow and outflow are both 3. Idempotent: a nulled row no longer matches.
-- The final SELECT should report 0.

BEGIN;
SET LOCAL timescaledb.max_tuples_decompressed_per_dml_transaction = 0;

UPDATE observations
SET inflow_m3s  = NULL,
    outflow_m3s = NULL
WHERE source_id = 'jwa-yoshino'
  AND dam_id IN (SELECT id FROM dams
                 WHERE external_ids ->> 'ndi' IN ('2042', '2045', '2048', '2052', '2053'))
  AND inflow_m3s = 3
  AND outflow_m3s = 3;

SELECT count(*) AS unit_digit_flows_left
FROM observations
WHERE source_id = 'jwa-yoshino'
  AND inflow_m3s = 3
  AND outflow_m3s = 3;

COMMIT;
