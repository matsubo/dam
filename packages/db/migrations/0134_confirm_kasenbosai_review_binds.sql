-- 0134: close the match_review rows for 22 kasenbosai auto-binds, each checked (#1).
--
-- match:kasenbosai binds a station below 0.80 (distance-only, master-side
-- ordinal, exact name across a prefecture border) and also stages it in
-- match_review. These 22 stations are bound and feeding their dams, but
-- their reviews were still open. Each was checked against MLIT's own station
-- record (https://www.river.go.jp/kawabou/file/files/master/obs/dam/<key>.json:
-- name, river, operator, address) and the NDI row's name, prefecture,
-- operator and position; where the station reports volume and rate, the
-- implied capacity (volume ÷ rate over prod's kasenbosai rows) was compared
-- with the master. All 22 are the right dam, so each review is closed on the
-- row the station is stamped on. No stamp moves and no observation changes.
--
-- Evidence (prod read 2026-09-28; m = metres between station and NDI row,
-- cap = implied capacity in 万 m³ vs NDI 有効):
--
--   distance-only 0.60
--   2128000700004 荒川第一調節池   NDI 698  荒川調節池, 25 m. MLIT: 荒川, 荒川上流
--     河川事務所, 戸田市. cap median 1,020 vs 1,060 (彩湖 is 荒川第一調節池).
--   2181100700025 高根第１ダム     NDI 902  高根第一, 5 m. MLIT: 飛騨川, 中部電力,
--     高山市高根町. Level only: 1,053–1,070 m under 常時満水位 1,080.
--   2181100700026 高根第２ダム     NDI 876  高根第二, 22 m. Same river/operator;
--     高根第一 is 2.7 km away and has its own station.
--   2181100700036 馬瀬川第２       NDI 911  馬瀬川第二, 28 m. MLIT: 馬瀬川, 中部電力.
--     cap 609.7–610.3 over 2,088 readings vs 610.
--   0844900700017 槙谷ダム         NDI 1865 槇谷 (槙/槇 variant), 431 m. MLIT:
--     落合川, 岡山県備前県民局, 吉備中央町. Volume ≤ 164.5 vs total 219.
--     okayama-bousai 90090101 is stamped on the same row.
--   2739300700022 渡ノ瀬ダム       NDI 1966 渡之瀬, 91 m. MLIT: 玖島川, 中国電力,
--     廿日市市大野; NDI operator 中国電力.
--   2255900700011 面河第三ダム     NDI 2107 面河第3, 24 m. MLIT: 仁淀川, 四国電力;
--     NDI operator 四国電力.
--   1024100700009 牛頸ダム         NDI 2448 牛頚 (頸/頚 variant), 40 m. MLIT:
--     牛頸川, 福岡県, 大野城市. cap median 210 vs total 228 (有効 unset).
--   2790500700003 玉島取水堰       NDI 2506 古明神, 10 m. MLIT: 玉島川, 九州電力,
--     唐津市七山. The NDI row is a 15 m 重力式アーチ with 1 万 m³ on 玉島川 at
--     唐津市七山 (https://www.map-navi.com/dam/2506.html, from the same NDI
--     data): one structure, which MLIT names after 九電's intake and NDI
--     after the place. A 15 m body is a dam, so the weir name does not
--     make this a not-a-dam case.
--   1075300700009 ケ知ダム         NDI 2626 鶏知 (けち), 14 m. MLIT: け知川, 長崎県,
--     対馬市美津島町ケ知. cap median 57.9 vs 58; nagasaki-kasen 2030 is
--     stamped on the same row.
--   2283500700001 ななせダム       NDI 2304 大分川 (2017), 227 m. ななせダム is
--     大分川ダム's name; MLIT: 大分河川国道事務所, 大分市下原. Volume ≤ 980
--     vs total 2,400.
--   2285600700002 川内川第二ダム   NDI 2699 川内川第2, 19 m. MLIT: 川内川,
--     電源開発, さつま町; NDI operator 電源開発. 鶴田 is 3.3 km away.
--   master-side ordinal 0.70 (the reservoir's main dam, 1st of the set)
--   2206100700001 権現ダム         NDI 1528 権現第1, 26 m. MLIT: 兵庫県企業局,
--     加古川市平荘町上原. cap 1,099.9–1,100.1 over 2,096 readings vs 1,100;
--     権現第3 has no 有効 of its own.
--   2206100700002 平荘ダム         NDI 1537 平荘第1, 41 m (第2 482 m, 第3 1.2 km).
--     MLIT: 兵庫県企業局, 平荘町池尻. cap 900.0 over 2,096 readings; the three
--     rows share the reservoir's 900, so the main dam carries it.
--   exact name across a prefecture border 0.75 (the dam spans the border)
--   2053200700031 相川ダム         NDI 248  相川, 18 m. MLIT files it under 岩手
--     (一関市藤沢町); ダム便覧 0272 (https://dambinran.damnet.or.jp/dams/japan/0272)
--     puts it at 宮城県登米市東和町, 右岸 岩手県, 東北農政局, like the NDI row.
--   2152700700004 奥只見ダム       NDI 500  奥只見, 61 m. 電源開発, 只見川 (福島/新潟).
--     cap 45,797–45,803 vs 45,800.
--   2125900700001 渡良瀬遊水地     NDI 614  渡良瀬遊水地（一期）, 410 m. MLIT: 利根川
--     上流河川事務所, 加須市. Level 11.3–11.5 m under 常時満水位 15; volume
--     ≤ 1,237 vs total 2,640. jwa-toneara/tokyo-waterworks 渡良瀬貯水池 are
--     on the same row.
--   2128900700006 下久保ダム       NDI 587  下久保, 576 m. MLIT: 神流川, 水資源機構,
--     神川町 (埼玉/群馬). Constant 8,521–8,529 denominator: a 利水-basis
--     rate, below the 12,000 有効. jwa-junpo/shimokubo are on the same row.
--   2208800700003 七色ダム（電発） NDI 1324 七色, 75 m. MLIT: 北山川, 電源開発,
--     北山村 (和歌山/三重); NDI operator 電源開発.
--   2281500700007 下筌ダム         NDI 2477 下筌（再）, 59 m (（元） 156 m). MLIT:
--     津江川, 筑後川ダム統合管理事務所. Constant 2,882–2,889 denominator
--     (利水 basis). mudam 83 and jwa-chikugo 下筌ダム are on the （再） too.
--   2790500700011 夜明ダム         NDI 2470 夜明, 20 m. MLIT: 筑後川, 九州電力,
--     日田市夜明 (大分/福岡); NDI operator 九州電力.
--   2790500700028 桑野内ダム       NDI 2335 桑野内, 7 m. MLIT: 五ヶ瀬川, 九州電力,
--     五ヶ瀬町 (宮崎/熊本); NDI operator 九州電力.
--
-- 相川 publishes nothing valid: its 331 kasenbosai rows since 2026-09-14 are
-- all NULL, written before 2fe6bed made ingest:kasenbosai-v2 skip such
-- readings. The bind is still right; it just adds no values.
--
-- Not here: 0896100700002 小瀬川ダム and 2790500700009 大山川取水堰, whose
-- best candidate carries no kasenbosai stamp, so they are not binds to confirm.
--
-- A row closes only while it is open and the station's stamp is still on
-- the NDI row named here, so a later move is never confirmed by mistake.
-- A fresh database has no such rows. Idempotent.

UPDATE match_review mr
SET resolved_dam_id = d.id,
    resolved_at     = NOW()
FROM (VALUES
  ('2128000700004', '698'),  -- 荒川第一調節池 → 荒川調節池
  ('2181100700025', '902'),  -- 高根第１ダム → 高根第一
  ('2181100700026', '876'),  -- 高根第２ダム → 高根第二
  ('2181100700036', '911'),  -- 馬瀬川第２ → 馬瀬川第二
  ('0844900700017', '1865'), -- 槙谷ダム → 槇谷
  ('2739300700022', '1966'), -- 渡ノ瀬ダム → 渡之瀬
  ('2255900700011', '2107'), -- 面河第三ダム → 面河第3
  ('1024100700009', '2448'), -- 牛頸ダム → 牛頚
  ('2790500700003', '2506'), -- 玉島取水堰 → 古明神
  ('1075300700009', '2626'), -- ケ知ダム → 鶏知
  ('2283500700001', '2304'), -- ななせダム → 大分川
  ('2285600700002', '2699'), -- 川内川第二ダム → 川内川第2
  ('2206100700001', '1528'), -- 権現ダム → 権現第1
  ('2206100700002', '1537'), -- 平荘ダム → 平荘第1
  ('2053200700031', '248'),  -- 相川ダム → 相川
  ('2152700700004', '500'),  -- 奥只見ダム → 奥只見
  ('2125900700001', '614'),  -- 渡良瀬遊水地 → 渡良瀬遊水地（一期）
  ('2128900700006', '587'),  -- 下久保ダム → 下久保
  ('2208800700003', '1324'), -- 七色ダム（電発） → 七色
  ('2281500700007', '2477'), -- 下筌ダム → 下筌（再）
  ('2790500700011', '2470'), -- 夜明ダム → 夜明
  ('2790500700028', '2335')  -- 桑野内ダム → 桑野内
) AS v (station, ndi)
JOIN dams d
  ON d.external_ids->>'ndi' = v.ndi
 AND d.external_ids->>'kasenbosai' = v.station
WHERE mr.source_id = 'kasenbosai'
  AND mr.source_external_id = v.station
  AND mr.resolved_at IS NULL;
