-- 0133: record 15 川の防災情報 stations of office 27905 as not master dams (#1).
--
-- Office 27905 is 九州電力, not 九州農政局 (that is 20539, see 0088): all 26
-- master rows already bound to a 27905 station are 九州電力 hydro dams (天山,
-- 夜明, 一ツ瀬, 上椎葉…). Besides those dams it publishes the 貯水位 of the
-- run-of-river intake weirs feeding its power stations. Each station below was
-- checked against MLIT's own station master
--   https://www.river.go.jp/kawabou/file/files/master/obs/dam/<key>.json
-- (jrsNm 九州電力 for all 15; where a 最低水位 is filed at all it sits 1.4-4 m
-- under the 常時満水位, i.e. pondage, not a reservoir; the feed flags
-- 貯水量/貯水率 invalid, Ccd 160, in all 15 tmlist readings of 2026-09-28
-- 09:30), against the NDI master (no master name contains any of
-- these stems; prod 2026-09-28), and against
-- ダム便覧's per-水系 lists
--   https://dambinran.damnet.or.jp/dams/japan/?rivers=<水系>
-- which cover ≥15 m dams and river 堰 alike (筑後大堰 is listed). None of the 15
-- is in either list:
--
--   key            station           水系 / place (MLIT)       nearest master (prod)
--   2790500700001  鮎の瀬取水堰      嘉瀬川 佐賀市富士町関屋   北山 2.0 km (own station 2053900700074)
--   2790500700002  川上川第五取水堰  嘉瀬川 佐賀市富士町下熊川 北浦溜池 5.4 km
--   2790500700014  甲佐取水堰        緑川 美里町古閑           船津 2.9 km (own station 2282500700002)
--   2790500700013  黒川調整池堰      白川 南阿蘇村下野         立野 3.4 km (own station 2282500700006)
--   2790500700017  川辺川第一取水堰  球磨川 五木村甲           川辺川 5.4 km (planned, 相良村 site)
--   2790500700009  大山川取水堰      筑後川 日田市大山町東大山 松原 2.8 km, 大山 4.1 km (own stations)
--   2790500700007  竹田取水堰        大野川 竹田市竹田         玉来 7.2 km
--   2790500700008  津房川取水堰      駅館川 宇佐市安心院町木裳 香下 5.0 km
--   2790500700019  上米良取水堰      一ツ瀬川 西米良村上米良   市房 11.9 km
--   2790500700018  槙之口取水堰      一ツ瀬川 椎葉村大河内     none within 12 km
--   2790500700040  河頭取水堰        甲突川 鹿児島市小山田町   西之谷 5.8 km
--   2790500700041  松山取水堰        菱田川 曽於市大隅町月野   中岳 8.8 km
--   2790500700042  月野取水堰        菱田川 曽於市大隅町月野   輝北 9.7 km
--   2790500700038  万之瀬取水堰      万之瀬川 南九州市川辺町永田 金峰 6.5 km
--   2790500700043  雄川取水堰        雄川 錦江町田代川原       none within 12 km
--
-- ダム便覧 per 水系: 嘉瀬川 = 嘉瀬川/北浦溜池/北山; 緑川 = 天君/釈迦院/七滝/深迫/
-- 船津/緑川/緑川補助; 白川 = 阿蘇立野/大切畑; 球磨川 = 10 dams, none a 取水堰;
-- 筑後川 = 26 incl. 大山 and 筑後大堰, no 大山川 weir; 大野川 = 13, no 竹田;
-- 駅館川 = 小野原/香下/日指/日出生/深見; 一ツ瀬川 = 寒川/杉安/立花/長谷/東原調整池/
-- 一ツ瀬/吹山; 菱田川 = 輝北; 万之瀬川 = 川辺/金峰; 甲突川 and 雄川 none.
--
-- 大山川取水堰's open review (best 大山 at 0.8) is a name-containment hit only:
-- 大山ダム is 水資源機構's dam on 赤石川, 4.1 km away, and is bound to MLIT's
-- own 大山ダム station 2281500700018, which outscores the weir (exact name)
-- on every weekly run. No other station here reaches MATCH_THRESHOLD, so
-- match:kasenbosai never binds any of them.
UPDATE source_universe su
SET not_dam_reason = v.reason
FROM (VALUES
  ('2790500700001', '九州電力 発電用取水堰 (嘉瀬川, 佐賀市富士町関屋; MLIT master/obs/dam/2790500700001.json): not in NDI or ダム便覧 嘉瀬川水系'),
  ('2790500700002', '九州電力 発電用取水堰 (嘉瀬川, 佐賀市富士町下熊川; MLIT master/obs/dam/2790500700002.json): not in NDI or ダム便覧 嘉瀬川水系'),
  ('2790500700014', '九州電力 発電用取水堰 (緑川, 美里町古閑; MLIT master/obs/dam/2790500700014.json): not in NDI or ダム便覧 緑川水系'),
  ('2790500700013', '九州電力 調整池堰 (白川水系黒川, 南阿蘇村下野; MLIT master/obs/dam/2790500700013.json): not in NDI or ダム便覧 白川水系'),
  ('2790500700017', '九州電力 発電用取水堰 (球磨川水系川辺川, 五木村甲; MLIT master/obs/dam/2790500700017.json): not in NDI or ダム便覧 球磨川水系'),
  ('2790500700009', '九州電力 発電用取水堰 (筑後川水系大山川, 日田市大山町東大山; MLIT master/obs/dam/2790500700009.json): not 大山ダム (赤石川, 4.1 km, own station 2281500700018); not in NDI or ダム便覧'),
  ('2790500700007', '九州電力 発電用取水堰 (大野川, 竹田市竹田; MLIT master/obs/dam/2790500700007.json): not in NDI or ダム便覧 大野川水系'),
  ('2790500700008', '九州電力 発電用取水堰 (駅館川水系津房川, 宇佐市安心院町木裳; MLIT master/obs/dam/2790500700008.json): not in NDI or ダム便覧 駅館川水系'),
  ('2790500700019', '九州電力 発電用取水堰 (一ツ瀬川, 西米良村上米良; MLIT master/obs/dam/2790500700019.json): not in NDI or ダム便覧 一ツ瀬川水系'),
  ('2790500700018', '九州電力 発電用取水堰 (一ツ瀬川, 椎葉村大河内; MLIT master/obs/dam/2790500700018.json): not in NDI or ダム便覧 一ツ瀬川水系'),
  ('2790500700040', '九州電力 発電用取水堰 (甲突川, 鹿児島市小山田町; MLIT master/obs/dam/2790500700040.json): not in NDI; ダム便覧 has no dam on 甲突川'),
  ('2790500700041', '九州電力 発電用取水堰 (菱田川, 曽於市大隅町月野; MLIT master/obs/dam/2790500700041.json): not in NDI or ダム便覧 菱田川水系'),
  ('2790500700042', '九州電力 発電用取水堰 (菱田川, 曽於市大隅町月野; MLIT master/obs/dam/2790500700042.json): not in NDI or ダム便覧 菱田川水系'),
  ('2790500700038', '九州電力 発電用取水堰 (万之瀬川, 南九州市川辺町永田; MLIT master/obs/dam/2790500700038.json): not in NDI or ダム便覧 万之瀬川水系'),
  ('2790500700043', '九州電力 発電用取水堰 (雄川, 錦江町田代川原; MLIT master/obs/dam/2790500700043.json): not in NDI; ダム便覧 has no dam on 雄川')
) AS v(key, reason)
WHERE su.source_id = 'kasenbosai'
  AND su.source_external_id = v.key
  AND su.resolved_dam_id IS NULL;

-- Close the reviews the matcher staged for five of them (鮎の瀬, 津房川, 大山川,
-- 黒川調整池, 甲佐), as not a dam. Skipped for any key a dam has since been
-- stamped with, so a later deliberate pin is never closed as "not a dam".
UPDATE match_review mr
SET resolved_at     = NOW(),
    resolved_dam_id = NULL
WHERE mr.source_id = 'kasenbosai'
  AND mr.source_external_id IN (
    '2790500700001', '2790500700002', '2790500700014', '2790500700013', '2790500700017',
    '2790500700009', '2790500700007', '2790500700008', '2790500700019', '2790500700018',
    '2790500700040', '2790500700041', '2790500700042', '2790500700038', '2790500700043'
  )
  AND mr.resolved_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM dams d WHERE d.external_ids->>'kasenbosai' = mr.source_external_id
  );
