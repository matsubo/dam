-- One-off (prod, after the fix(jwa-kiso-rt) section fix is deployed): null the
-- inflow / outflow jwa-kiso-rt stored for 中里貯水池 (三重用水, NDI 940), which
-- belong to 長良川河口堰 and 木曽川大堰.
--
-- Run once; the file is its own transaction (BEGIN … COMMIT):
--   psql -U dam -d dam -v ON_ERROR_STOP=1 -f 2026-09-28_jwa_kiso_rt_nakazato_flows.sql
-- No follow-up: obs_daily / obs_monthly carry no flow columns.
-- Not a migration: most of these rows sit in compressed chunks, and DML that
-- decompresses them does not belong in the migrate path (runbook §9).
--
-- Why. 水資源機構 中部支社 リアルタイム情報 木曽川水系 (mizu/chubu/realtime/
-- index.html) prints 中里貯水池's table with 貯水位 and 有効貯水量 only. The
-- old parser ended a dam's section at the next mapped dam's <h4>; 中里 is the
-- last mapped dam, so its section ran to the end of the page, through
-- 宮川/菰野/加佐登調整池, 長良川河口堰 (流入量, 流出量) and 木曽川大堰
-- (流入量, 放流量). It stored 長良川河口堰's 流入量 as 中里's inflow and
-- 木曽川大堰's 放流量 as its outflow. The fixed task ends each section at its
-- own </table> and stores no flows for 中里. The page publishes no flow for
-- 中里 and nothing on it gives the real value, so the fields are nulled.
-- Water level and volume came from 中里's own table and stay; storage_rate
-- does not depend on flows, so it is left as is.
--
-- Evidence (2026-09-28). Live page, 観測時刻 12時40分 JST: 長良川河口堰 流入量
-- 193.44, 木曽川大堰 放流量 535.39. On prod, jwa-kiso-rt 中里 at 03:40Z holds
-- inflow 193.440 and outflow 535.390. jwa-chubu's daily report gives 中里
-- 0.25 / 0.23 m³/s (09-27) and 0.21 / 0.24 (09-24). Every jwa-kiso-rt 中里 row,
-- 2026-06-12 06:40Z .. 2026-09-28 03:40Z, carries both flows. Inflow runs from
-- min 45.5 (median 90.9) to max 1,947.02 m³/s, and outflow from min 30.3
-- (median 169.8) to max 4,782.01 m³/s, so no stored row is a 中里 reading.
-- The other five dams on the page (牧尾, 味噌川, 阿木川, 岩屋, 徳山) are
-- bounded by the next mapped dam's header. Their stored values at 03:40Z match
-- their own tables, and they agree with kasenbosai at every shared timestamp
-- (18–36 per dam, 0 differences > 0.05). They are not touched.
--
-- Dry-run count (prod, read-only, 2026-09-28 12:55 JST): UPDATE 2,613, all
-- jwa-kiso-rt rows of NDI 940. It grows by one row an hour until the fix is
-- deployed; run it after the deploy.
--
-- Scoped to source jwa-kiso-rt on NDI 940. Idempotent: a second run finds no
-- row with a flow. The final SELECT should report 0.

BEGIN;
SET LOCAL timescaledb.max_tuples_decompressed_per_dml_transaction = 0;

UPDATE observations
SET inflow_m3s  = NULL,
    outflow_m3s = NULL
WHERE source_id = 'jwa-kiso-rt'
  AND dam_id IN (SELECT id FROM dams WHERE external_ids ->> 'ndi' = '940')
  AND (inflow_m3s IS NOT NULL OR outflow_m3s IS NOT NULL);

SELECT count(*) AS flows_left
FROM observations
WHERE source_id = 'jwa-kiso-rt'
  AND dam_id IN (SELECT id FROM dams WHERE external_ids ->> 'ndi' = '940')
  AND (inflow_m3s IS NOT NULL OR outflow_m3s IS NOT NULL);

COMMIT;
