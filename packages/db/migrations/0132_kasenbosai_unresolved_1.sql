-- 0132: settle 16 unresolved 川の防災情報 stations (#1, slice K1).
--
-- match:kasenbosai left these catalogue stations with resolved_dam_id NULL
-- (prod source_universe / match_review, 2026-09-28). Each was checked against
-- the master, ダム便覧 (its 2,570-dam /dams/japan/ index, scraped 2026-09-28)
-- and the station's own live values
-- (/kawabou/file/files/tmlist/dam/20260928/0920/<obs_fcd>.json).
--
-- 1. 0716900700021 栗柄ダム → 栗柄 (dams.slug kurisugara-28, damnet 3234).
--    The station sits 110 m from ダム便覧 3234's 35°8'15"N 135°13'25"E
--    (https://dambinran.damnet.or.jp/dams/japan/3234/) and at 09:10 JST read
--    286.86 m / 212 千m³ / in 0.03 / out 0.04 m³/s, exactly hyogo-bodik's row
--    for 栗柄 at the same minute (286.86 m / 212,000 m³ / 0.032 / 0.043).
--    That row was inserted by 0034 at 135.072 E 35.082 N, 15 km off, so the
--    matcher never sees it; the 0.4 "distance-only" review points at 西紀
--    (NDI 1368, 583 m), which is the same dam under its project name: same
--    26.7 m / 383 千m³ / 2013 as ダム便覧 3234, and 兵庫県's 西紀生活貯水池
--    (西紀ダム) sits at 西紀町（現篠山市）栗柄 (web.pref.hyogo.lg.jp/ks04/
--    documents/h22fk-01-nishikisekatsuchosuichikensetsujigyo-nishikidam3.pdf).
--    Stamp the row hyogo-bodik already feeds so both sources chart one page;
--    merging the duplicate NDI 1368 row is left to a master clean-up.
--    Stable: no candidate within 5 km scores ≥ 0.6, so bindStation never runs
--    for this station and nothing takes the stamp off again.
--
-- 2. 0896100700002 小瀬川ダム (山口県 office 8961) → 小瀬川 (NDI 1967).
--    Same dam as the 広島県 office's station 0870500700001, which holds the
--    single kasenbosai stamp (exact name, 1.0, beats this station's
--    cross-prefecture 0.75 every run): both read 210.8 m, in 4.95, out 0.95
--    m³/s at 09:10 JST. Resolve the universe row only; the stamp stays put.
--
-- 3. Not a master dam (source_universe.not_dam_reason, 0131): 14 stations,
--    reasons inline below. None is in ダム便覧's index and none has a master
--    row within 5 km scoring ≥ 0.6, except the 浄土寺川 貯砂ダム, whose exact
--    name loses 浄土寺川 (NDI 1258) to the main station 53 m away every run.
--    Five are real structures the NDI master leaves out on purpose or by
--    omission (仙美里 11.7 m, 滝本 14.7 m, 川代 9.0 m, 追立 砂防, 天川 35.3 m);
--    天川 is the one a future master addition could still link.
--
-- Every open match_review row for these stations is closed (0131's
-- convention: resolved_at set; resolved_dam_id NULL = not a dam).
-- ingest:kasenbosai-v2 only fetches the latest value, so nothing backfills.

UPDATE dams
SET external_ids = external_ids || jsonb_build_object('kasenbosai', '0716900700021')
WHERE slug = 'kurisugara-28' -- 栗柄
  AND external_ids->>'damnet' = '3234'
  AND NOT (external_ids ? 'kasenbosai')
  AND NOT EXISTS (
    SELECT 1 FROM dams o WHERE o.external_ids->>'kasenbosai' = '0716900700021'
  );

UPDATE source_universe su
SET resolved_dam_id = d.id
FROM dams d
WHERE su.source_id = 'kasenbosai'
  AND su.source_external_id = '0716900700021'
  AND su.resolved_dam_id IS NULL
  AND d.external_ids->>'kasenbosai' = '0716900700021';

-- Only while 小瀬川 is still stamped with the 広島 station, i.e. while the
-- premise "the dam is already linked through its twin station" holds.
UPDATE source_universe su
SET resolved_dam_id = d.id
FROM dams d
WHERE su.source_id = 'kasenbosai'
  AND su.source_external_id = '0896100700002'
  AND su.resolved_dam_id IS NULL
  AND d.external_ids->>'ndi' = '1967' -- 小瀬川
  AND d.external_ids->>'kasenbosai' = '0870500700001';

UPDATE match_review mr
SET resolved_dam_id = su.resolved_dam_id,
    resolved_at     = NOW()
FROM source_universe su
WHERE mr.source_id = 'kasenbosai'
  AND mr.source_external_id IN ('0716900700021', '0896100700002')
  AND mr.resolved_at IS NULL
  AND su.source_id = mr.source_id
  AND su.source_external_id = mr.source_external_id
  AND su.resolved_dam_id IS NOT NULL;

UPDATE source_universe su
SET not_dam_reason = v.reason
FROM (VALUES
  ('0460900700008',
   '浄土寺川ダム上流の貯砂ダム: 本体 (NDI 1258) は観測所 0460900700005 が紐付け済み。水位 360.05 m は本体の 344.53 m と別の池 (2026-09-28 09:10 JST) — https://dambinran.damnet.or.jp/dams/japan/3038/'),
  ('2335700700010',
   '電源開発 本別発電所の取水ダム (利別川, 堤高 11.7 m, 1962): 15 m 未満で NDI master・ダム便覧に無い — https://ja.wikipedia.org/wiki/電力会社管理ダム'),
  ('2183100700006',
   '諏訪湖出口の水門 (天竜川起点, 長野県): ダムではない — https://ja.wikipedia.org/wiki/釜口水門'),
  ('0640100700010',
   '堤体の無い自然湖 (導水路・放水路と水門で運用): NDI master・ダム便覧に無い — https://www.pref.shiga.lg.jp/ha04/1458.html'),
  ('0640100700012',
   '防衛省が饗庭野演習場内に造り滋賀県が運用する治水ダム (堤高 35.3 m, 2006): 実在するが NDI master・ダム便覧に無い — https://www.pref.shiga.lg.jp/ha04/1458.html'),
  ('2206100700003',
   '近畿農政局のゲート式ダム (篠山川, 堤高 9.0 m, 河道貯留): 15 m 未満で NDI master・ダム便覧に無い — https://www.maff.go.jp/kinki/seibi/sekei/kokuei/kakogawa/kakogawa05.html'),
  ('2206100700007',
   '東播用水の明石川への注水口: 近畿農政局 加古川水系総合管理所のダムは鴨川・糀屋・呑吐・大川瀬・川代のみ — https://www.maff.go.jp/kinki/seibi/sekei/kokuei/kakogawa/kakogawa05.html'),
  ('2206100700008',
   '頭首工 (加古川西部地区, 堤高 1.0 m) — https://www.maff.go.jp/kinki/seibi/sekei/kokuei/kakogawa/kakogawa05.html'),
  ('2206100700009',
   '頭首工 (加古川西部地区, 堤高 1.3 m) — https://www.maff.go.jp/kinki/seibi/sekei/kokuei/kakogawa/kakogawa05.html'),
  ('2206100700010',
   '頭首工 (加古川西部地区, 堤高 1.4 m) — https://www.maff.go.jp/kinki/seibi/sekei/kokuei/kakogawa/kakogawa05.html'),
  ('2206100700011',
   '頭首工 (加古川西部地区, 堤高 1.2 m) — https://www.maff.go.jp/kinki/seibi/sekei/kokuei/kakogawa/kakogawa05.html'),
  ('0716900700014',
   '大日ダム分水堰 (兵庫県洲本土木「大日・牛内ダム 大日・分水堰工事」, 南あわじ市賀集, 1998): 堰 — https://www.moricho.co.jp/results-land-post/大日ダム分水堰/'),
  ('2739300700028',
   '中国電力の小堰堤 (太田川水系滝山川, 堤高 14.7 m, 総貯水 270 千m³): 15 m 未満で NDI master・ダム便覧に無い — https://ja.wikipedia.org/wiki/太田川'),
  ('0921700700005',
   '徳島県の砂防ダム兼 坂州発電所取水 (坂州木頭川, 堤高 29.5 m, 1952): NDI master・ダム便覧に無い — https://ja.wikipedia.org/wiki/追立ダム')
) AS v(key, reason)
WHERE su.source_id = 'kasenbosai'
  AND su.source_external_id = v.key
  AND su.resolved_dam_id IS NULL;

UPDATE match_review mr
SET resolved_at = NOW()
FROM source_universe su
WHERE mr.source_id = 'kasenbosai'
  AND mr.resolved_at IS NULL
  AND mr.resolved_dam_id IS NULL
  AND su.source_id = mr.source_id
  AND su.source_external_id = mr.source_external_id
  AND su.resolved_dam_id IS NULL
  AND su.not_dam_reason IS NOT NULL
  AND su.source_external_id IN (
    '0460900700008', '2335700700010', '2183100700006', '0640100700010',
    '0640100700012', '2206100700003', '2206100700007', '2206100700008',
    '2206100700009', '2206100700010', '2206100700011', '0716900700014',
    '2739300700028', '0921700700005'
  );
