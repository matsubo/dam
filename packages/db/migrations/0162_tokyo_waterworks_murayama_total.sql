-- 0162: tokyo-waterworks — unbind the 村山・山口 three-reservoir total, and
-- drop the guessed prefecture of 渡良瀬貯水池 (#1).
--
-- 村山・山口貯水池 is one row for three reservoirs. Its 貯水容量 3,435 万m³
-- (waterworks.metro.tokyo.lg.jp/suigen/suigen, 令和8年9月25日) is the 有効 of
-- 村山上 (NDI 707, 2,983,000 m³) + 村山下 (NDI 706, 11,843,000) + 山口
-- (NDI 704, 19,528,000, 埼玉). A '%村山%' LIKE bound it to 村山下（再）
-- (id 9437), which then stored 23,880,000 m³ against its 11,843,000
-- capacity. ingest_tokyo_waterworks now records the row unresolved and
-- unstamped and stores nothing for it; this takes the stamp off 9437 and
-- clears the resolved_dam_id that recordUniverse's COALESCE would otherwise
-- keep. Its stored observations are deleted by
-- deploy/ops/oneoff/2026-09-28_tokyo_waterworks_dates.sql, not here.
--
-- 渡良瀬貯水池 was recorded as prefCodes[0] = '09' while its dam, 渡良瀬遊水地
-- （一期） (NDI 614), is filed under 10. The task now records NULL for a
-- multi-prefecture entry, as jwa-junpo does (9e6fc91), but pref_code is
-- COALESCE-sticky. The 村山・山口 row spans 東京 and 埼玉 and gets NULL too.
--
-- Upsert: on a fresh database the task has not recorded the row yet, and
-- recordUniverse never touches not_dam_reason.
UPDATE dams
SET external_ids = external_ids - 'tokyo-waterworks'
WHERE external_ids->>'tokyo-waterworks' = '村山・山口貯水池';

INSERT INTO source_universe AS su
  (source_id, source_external_id, source_name, pref_code, not_dam_reason)
VALUES
  ('tokyo-waterworks', '村山・山口貯水池', '村山・山口貯水池', NULL,
   'Combined figure for 村山上 (NDI 707, 有効 2,983,000 m³) + 村山下 (NDI 706, 11,843,000) + 山口 (NDI 704, 19,528,000): 貯水容量 3,435 万m³ (waterworks.metro.tokyo.lg.jp/suigen/suigen, 令和8年9月25日).')
ON CONFLICT (source_id, source_external_id) DO UPDATE
  SET resolved_dam_id = NULL,
      pref_code = NULL,
      not_dam_reason = EXCLUDED.not_dam_reason;

UPDATE source_universe
SET pref_code = NULL
WHERE source_id = 'tokyo-waterworks'
  AND source_external_id = '渡良瀬貯水池';
