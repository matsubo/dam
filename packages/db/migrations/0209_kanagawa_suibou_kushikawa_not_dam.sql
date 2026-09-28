-- 0209: kanagawa-suibou — 串川取水堰 is not a dam in the master (#1).
--
-- ingest_kanagawa_suibou records the two 取水堰 stations of 神奈川県雨量水位情報:
-- 飯泉取水堰 (NDI 727, ingested) and 串川取水堰 (station 3585_4_1507, 串川,
-- 相模原市緑区根小屋 — pref.kanagawa.jp/sys/suibou/web_general/suibou_joho/html/
-- stage/15/p10202_15_3585_4_1507.html, 2026-09-28). The NDI master has no
-- 串川 facility in 神奈川, so the row has no dam to link to; its level reads
-- 0.00 ± 0.02 m, a gauge height, not a reservoir.
--
-- Upsert: on a fresh database the task has not recorded the row yet, and
-- recordUniverse never touches not_dam_reason.
INSERT INTO source_universe AS su
  (source_id, source_external_id, source_name, pref_code, not_dam_reason)
VALUES
  ('kanagawa-suibou', '3585_4_1507', '串川取水堰', '14',
   '取水堰 (串川, 相模原市緑区根小屋) with no NDI master row; 神奈川県雨量水位情報 publishes only its gauge height (0.00 m on 2026-09-28).')
ON CONFLICT (source_id, source_external_id) DO UPDATE
  SET not_dam_reason = EXCLUDED.not_dam_reason;
