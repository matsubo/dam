-- 0211: record six jwa-toyokawa facilities as not master dams (#1).
--
-- jwa-toyokawa now records every facility on 水資源機構 中部支社's 豊川水系
-- real-time map (water.go.jp/mizu/chubu/realtime/index_2.html, 2026-09-28):
-- 宇連, 大島, seven 豊川用水 調整池 and five 頭首工. Eight bind to master rows.
-- The six below have no master row to bind to:
--
--   - None is in the NDI W01 ダム master: prod on 2026-09-28 has no dams row
--     whose name contains 三ツ口, 芦ヶ池 / 芦ケ池, 大入, 振草, 牟呂 or 寒狭.
--   - None is on ダム便覧's 豊川水系 list
--     (dambinran.damnet.or.jp/dams/japan/?rivers=豊川, 2026-09-28), which
--     lists nine: 宇連, 大島, 大野頭首工, 大原調整池, 駒場池, 設楽, 初立池,
--     万場調整池 and 宝地池. That list also carries the 豊川用水 facilities
--     outside the 豊川 basin (初立池 is at 田原市伊良湖町, 万場調整池 at
--     豊橋市西赤沢町), so it is where 三ツ口池 and 芦ヶ池調整池 would appear if
--     ダム便覧 held them.
--   - The four 頭首工 print a bare "m" 貯水位; 大入 (0.84 m) and 振草 (3.42 m)
--     on 2026-09-28 15:40 are gauge heights, not reservoir elevations.
--
-- Upsert: on a fresh database, and on prod until the first run after deploy,
-- the task has not recorded these rows yet. recordUniverse never writes
-- not_dam_reason, so the mark survives every scan.
INSERT INTO source_universe AS su
  (source_id, source_external_id, source_name, pref_code, not_dam_reason)
VALUES
  ('jwa-toyokawa', '三ツ口池', '三ツ口池', '23',
   '豊川用水の調整池. Not in the NDI W01 master nor on ダム便覧''s 豊川水系 list (dambinran.damnet.or.jp/dams/japan/?rivers=豊川, 2026-09-28), which carries the other 豊川用水 調整池.'),
  ('jwa-toyokawa', '芦ヶ池調整池', '芦ヶ池調整池', '23',
   '豊川用水の調整池. Not in the NDI W01 master nor on ダム便覧''s 豊川水系 list (dambinran.damnet.or.jp/dams/japan/?rivers=豊川, 2026-09-28), which carries the other 豊川用水 調整池.'),
  ('jwa-toyokawa', '大入頭首工', '大入頭首工', '23',
   '豊川用水の頭首工 (取水堰). Not in the NDI W01 master nor on ダム便覧''s 豊川水系 list (dambinran.damnet.or.jp/dams/japan/?rivers=豊川, 2026-09-28); its 貯水位 is a gauge height.'),
  ('jwa-toyokawa', '振草頭首工', '振草頭首工', '23',
   '豊川用水の頭首工 (取水堰). Not in the NDI W01 master nor on ダム便覧''s 豊川水系 list (dambinran.damnet.or.jp/dams/japan/?rivers=豊川, 2026-09-28); its 貯水位 is a gauge height.'),
  ('jwa-toyokawa', '牟呂松原頭首工', '牟呂松原頭首工', '23',
   '豊川用水の頭首工 (取水堰). Not in the NDI W01 master nor on ダム便覧''s 豊川水系 list (dambinran.damnet.or.jp/dams/japan/?rivers=豊川, 2026-09-28).'),
  ('jwa-toyokawa', '寒狭川頭首工', '寒狭川頭首工', '23',
   '豊川用水の頭首工 (取水堰). Not in the NDI W01 master nor on ダム便覧''s 豊川水系 list (dambinran.damnet.or.jp/dams/japan/?rivers=豊川, 2026-09-28).')
ON CONFLICT (source_id, source_external_id) DO UPDATE
  SET not_dam_reason = EXCLUDED.not_dam_reason
  WHERE su.resolved_dam_id IS NULL;
