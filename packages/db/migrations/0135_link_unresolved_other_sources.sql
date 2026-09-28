-- 0135: link or explain the unresolved source_universe rows of the name-keyed
-- sources (everything but kasenbosai) (#1).
--
-- Prod on 2026-09-28 had 17 unresolved rows outside kasenbosai, and the six
-- round-5 sources had not run yet. Their rows below come from running each
-- task's own parser and chooseMaster over the live pages that day. Every row
-- is either linked to its NDI row or given a cited not_dam_reason (0131).
-- None of these sources writes match_review, so there is no review to close.
--
-- Linked (stamp + resolved_dam_id):
--
--   yamagata-bousai 最上小国川流水型ダム → 最上小国川 (NDI 483, pref 06). The
--     same dam kasenbosai 0153700700017 (「最上小国川流水型ダム」) is stamped on,
--     and the feed agrees with it: 2026-09-28 09:50 JST 貯水位 276.82 m, 貯水量
--     1 千m³ vs kasenbosai 276.820 m, 1,000 m³. It is a 流水型 (dry) flood-control
--     dam, so 貯水率 0.0 % is its real state, not a missing value. The rate is
--     the source's own (trusted_rate_basis), and effective_active_capacity_m3
--     returns the master's NULL 有効 for a 0 rate, so the dam cannot enter the
--     渇水 list or the storage totals. ingest_yamagata_bousai is stamp-first
--     (stampedMaster), so the stamp holds: the name alone never matches,
--     because the stem 最上小国川流水型 is longer than the master's.
--   hyogo-kigyo 平荘ダム → 平荘第1 (NDI 1537), 権現ダム → 権現第1 (NDI 1528).
--     The page prints each reservoir once (利水容量 9,000 / 11,000 千m³,
--     web.pref.hyogo.lg.jp/kc02/ea02_000000005.html, 9/24). NDI and ダム便覧
--     give every dam body of 平荘湖 the lake's whole 有効 9,000 (1486 平荘第１,
--     3331 第２, 3332 第３), and 権現第1 carries 11,000 (第3 none). kasenbosai
--     already stores the 平荘ダム / 権現ダム telemetry on these rows (0134: cap
--     900.0 / 1,100 万m³), so this is the same binding. chooseMaster refuses the
--     stem because it reaches several rows, but a stamp wins over that
--     (stampedMaster runs first). The rows stay universe-only: the task writes
--     神谷 alone.
--   kyushu-nousei 44:大蘇ダム / 44:大谷ダム and oita-nourin 大蘇ダム / 大谷ダム
--     → 大蘇 (NDI 2306) / 大谷 (NDI 2307), both filed under 熊本 (43). Both
--     tasks now pin them in code (NDI_PINS), so no stamp is needed; resolving
--     them here only saves waiting for the next survey run. Evidence is in the
--     tasks: the PDFs' 有効 3,890 / 1,500 千m³ are the master's 有効.
--   kyushu-nousei 40:花宗ため池 → 花宗溜池 (NDI 2496), bound by the already
--     deployed ため池→溜池 fold (99c0421); its first run with it is still due.
--   shizuoka-bousai 8567001 長島ダム（国） → 長島 (NDI 758), whose row already
--     carries the shizuoka-bousai stamp. The source is retired (0101), so this
--     is bookkeeping only.
--
-- Not a master dam (not_dam_reason, the cited reason is the value itself).
-- "No master" was checked by name, by capacity and by distance on prod.
-- Rows that exist on prod are updated; the round-5 rows are upserted so the
-- mark lands whether this runs before or after the task's first scan
-- (recordUniverse never touches not_dam_reason).
UPDATE dams
SET external_ids = external_ids || jsonb_build_object(v.source, v.station)
FROM (VALUES
  ('yamagata-bousai', '最上小国川流水型ダム', '483', '06'),
  ('hyogo-kigyo', '平荘ダム', '1537', '28'),
  ('hyogo-kigyo', '権現ダム', '1528', '28')
) AS v (source, station, ndi, pref)
WHERE dams.external_ids->>'ndi' = v.ndi
  AND dams.pref_code = v.pref
  AND NOT (dams.external_ids ? v.source)
  AND NOT EXISTS (
    SELECT 1 FROM dams o WHERE o.external_ids->>v.source = v.station
  );

-- recordUniverse keeps an existing id over a NULL (COALESCE), so a row
-- resolved here stays resolved.
UPDATE source_universe su
SET resolved_dam_id = d.id
FROM (VALUES
  ('yamagata-bousai', '最上小国川流水型ダム', '483', '06'),
  ('hyogo-kigyo', '平荘ダム', '1537', '28'),
  ('hyogo-kigyo', '権現ダム', '1528', '28'),
  ('kyushu-nousei', '44:大蘇ダム', '2306', '43'),
  ('kyushu-nousei', '44:大谷ダム', '2307', '43'),
  ('kyushu-nousei', '40:花宗ため池', '2496', '40'),
  ('oita-nourin', '大蘇ダム', '2306', '43'),
  ('oita-nourin', '大谷ダム', '2307', '43'),
  ('shizuoka-bousai', '8567001', '758', '22')
) AS v (source, station, ndi, pref)
JOIN dams d ON d.external_ids->>'ndi' = v.ndi AND d.pref_code = v.pref
WHERE su.source_id = v.source
  AND su.source_external_id = v.station
  AND su.resolved_dam_id IS NULL;

UPDATE source_universe su
SET not_dam_reason = v.reason
FROM (VALUES
  ('kyushu-nousei', '41:朝日ダム',
   'Not in the NDI master: 佐賀 六角川水系 農業用ダム, 有効 1,200 千m³ (九州農政局 tyosui R8.9.15 PDF). No 佐賀 master row is named 朝日 or holds 有効 1,200 千m³; the closest (狩立 1,243, 都川内 1,110, 河内防災 1,102) are 佐賀県 multipurpose dams kasenbosai already binds.'),
  ('kyushu-nousei', '46:沖永良部地下ダム',
   'Subsurface dam (地下ダム, 有効 596 千m³ per 九州農政局 tyosui R8.9.15) with no NDI master row: the master has no row on 沖永良部島 (its southernmost 鹿児島 rows are 徳之島 at 27.70 N), and its only 地下ダム is 喜界地下.'),
  ('oita-nourin', '油留木ダム',
   'Not in the NDI master: 安岐川水系 農業用ダム, 有効 165 千m³, 国東市 (大分県 農業用ダム貯水率一覧 R8.9.24). The only 安岐川 master is 安岐ダム (NDI 2291, 大分県 FN, 有効 2,250 千m³; ダム便覧 2774).'),
  ('chiba-suisei', '奥谷',
   'Not in the NDI master: 安房広域 水道用 奥谷, 有効 40,000 m³ (pref.chiba.lg.jp/suisei/chosui/chosuijoukyou.html, R8.9.14). Only the next row, 第二奥谷 (80,000 m³), has a master row (NDI 660), and no other master lies within 1.6 km of 第二奥谷.'),
  ('fukushima-nourin', '半田沼',
   'Not in the NDI master: 桑折町 半田沼 (かんがい用, pref.fukushima.lg.jp/sec/36045d/noutikannri010.html). The page lists 桑折町 藤倉ダム (NDI 318) as its own row, and no other 福島 master is named 半田 or lies at 半田山.'),
  ('hyogo-bodik', '分水堰',
   'Diversion weir, not a dam: BODIK tm-dam.csv station 12 holds 2 千m³ at EL 191.03 m (2026-09-28 09:50). kasenbosai places the same-named station (0716900700014) at 34.2342 N 134.7908 E, 1.2 km from the nearest master (大日川), and no 兵庫 master is named 分水堰.'),
  ('kyoto-bousai', '瀬田洗堰1',
   'Gauge of 瀬田川洗堰, the 琵琶湖 outlet weir (the kyoto-bousai table lists it as a sluice gate); no master row in 滋賀 or 京都 is named 瀬田.'),
  ('kyoto-bousai', '瀬田洗堰2',
   'Gauge of 瀬田川洗堰, the 琵琶湖 outlet weir (the kyoto-bousai table lists it as a sluice gate); no master row in 滋賀 or 京都 is named 瀬田.'),
  ('shiga-bousai', '余呉湖',
   'Natural lake (余呉湖) regulated as a reservoir, not in the NDI master: no 滋賀 row is named 余呉, and the nearest master (丹生) is 10.6 km from kasenbosai''s 余呉湖 station at 35.5228 N 136.1992 E.'),
  ('shiga-bousai', '天川ダム',
   'Not in the NDI master: 滋賀 天川ダム (高島市, kasenbosai station 0640100700012 at 35.3922 N 136.0028 E). No 滋賀 row is named 天川, and the nearest master (奥山) is 4.5 km away.')
) AS v (source, station, reason)
WHERE su.source_id = v.source
  AND su.source_external_id = v.station
  AND su.resolved_dam_id IS NULL;

INSERT INTO source_universe AS su
  (source_id, source_external_id, source_name, pref_code, not_dam_reason)
VALUES
  ('hyogo-suigen', '呑吐ダム・大川瀬ダム', '呑吐ダム・大川瀬ダム', '28',
   'Combined figure for 呑吐 (NDI 1534) + 大川瀬 (NDI 1535): one 貯水率 for two dams (web.pref.hyogo.lg.jp/kk05/ac07_000000162.html). The page lists them apart during a 渇水, and those rows bind.'),
  ('shimonoseki-suido', '内日貯水池', '内日貯水池', '35',
   'Combined figure for 内日第1 (NDI 1731, 有効 1,000,000 m³) + 内日第2 (NDI 1730, 900,000): 満水量 1,900,000 (city.shimonoseki.lg.jp/site/water/5617.html).'),
  ('hyogo-kigyo', '黒川ダム', '黒川ダム', '28',
   'The figure is the 県企業庁''s 3,980 千m³ share of 黒川ダム (NDI 1563, 関西電力 pumped-storage upper pool, 有効 21,360 千m³), printed full at 100.0 % while the pool swings daily (web.pref.hyogo.lg.jp/kc02/ea02_000000005.html). It does not describe the dam.'),
  ('awaji-suido', '天川第1ダム', '天川第1ダム', '28',
   'Not in the NDI master: 淡路 天川水系 天川第１ダム, 貯水量 133,600 m³ (awaji-suido.jp/osirase-01.html, R8.9.23). Only 天川第2 (NDI 1556) has a row, and no other master lies within 3 km of 天川第2.'),
  ('awaji-suido', '成相・北富士ダム', '成相・北富士ダム', '28',
   'Combined figure for 成相 (NDI 1592) + 北富士 (NDI 1596): 2,062,500 m³ (awaji-suido.jp/osirase-01.html, R8.9.23). hyogo-bodik and kasenbosai carry each dam.'),
  ('kitakyushu-suido', '頓田貯水池', '頓田貯水池', '40',
   'Combined figure for 頓田第1（再） (NDI 2421, 有効 440 万m³) + 頓田第2（再） (NDI 2420, 475 万m³): 890 万m³ at 97.3 % implies 915 (city.kitakyushu.lg.jp/suidou/s00900011.html).'),
  ('cgr-okakawa-dam', '新田原井堰', '新田原井堰', '33',
   'Weir (井堰) on 吉井川, 利水容量 2,000 千m³ (cgr.mlit.go.jp/okakawa 3kasenndamukeika.pdf, 2026-09-25). Not in the NDI master: no 岡山 row is named 新田原, and 岡山''s only 堰 row is 坂根堰 (NDI 1742).')
ON CONFLICT (source_id, source_external_id) DO UPDATE
  SET not_dam_reason = EXCLUDED.not_dam_reason
  WHERE su.resolved_dam_id IS NULL;
