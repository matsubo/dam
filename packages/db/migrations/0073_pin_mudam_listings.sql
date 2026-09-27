-- 0073: move the mudam stamps of the listings backfill:mudam now pins in
-- MUDAM_OVERRIDES onto the row the listing really is (#79).
--
-- The task binds those listings by NDI from now on, but prod's stamps would
-- otherwise stay on the wrong rows until the next monthly run (20th), and
-- observations:rebind needs the stamps where the history is going. The value
-- is copied, not restated. Keyed by NDI id. A row is only changed where the
-- listing's key sits on another row and the target has no mudam key (or
-- already has this one), so this is idempotent and a no-op on a fresh
-- database.
--
-- Evidence (prod read 2026-09-27; mudam = mudam.nilim.go.jp,
-- /chronology/summary/<id> and the 諸元 table /chronology/form01/<id>/<year>,
-- whose 堤高 / 総 / 有効貯水容量 match the target row exactly and not the
-- source row):
--
--   3   桂沢      157 桂沢（元） → 156 新桂沢（再）  新桂沢 is 桂沢 raised on
--     the same axis (同軸嵩上げ, 63.6 → 75.5 m), completed 2024-03-31
--     (https://www.hkd.mlit.go.jp/sp/ikushunbetu_damu/kluhh4000000byma.html);
--     test impoundment began 2023-11-11 (https://www.kajima.co.jp/tech/
--     civil_engineering/topics/231111.html). mudam keeps one listing and dam
--     code 10100122200000; its 諸元 are the old body's through 2023 (63.6 m,
--     総 92,700 千m³, 常時満水位 187.0) and the new body's in 2024 (75.5 m,
--     147,300 千m³, サーチャージ 196.8). Prod's mudam levels (2019-12-31..
--     2024-12-30) stay ≤ 187.0 until 2023-11 (187.05–195.05), then reach
--     196.91 in 2023-12. The history straddles the raising, but it is one
--     reservoir and one level series, so all of it goes where the live
--     sources are (hkd-mlit-dam, kasenbosai on 新桂沢（再）), as 0068 did for
--     天ヶ瀬 and 美和.
--   180 遠野第二   240 遠野   → 257 遠野第2    (23.1 m, 総 248 千m³)
--   310 上市川第二 1107 上市川 → 1108 上市川第2 (67.0 m, 総 7,800 千m³)
--     "遠野第二" contains "遠野" while the master spells 第2, so the listing
--     took 遠野 from 172 遠野 (and 310 took 上市川 from 309 上市川); the
--     later listing's stamp and CSV rows overwrote the earlier's. Every one
--     of the 1,827 mudam rows on 遠野 and on 上市川 equals the 180 / 310 CSV
--     for its day (e.g. 2024-01-01: 278.44 m vs 遠野's own 306.4 m; 277.06 m
--     vs 上市川's own 184.23 m).
--   54  丸山       919 新丸山（再） → 901 丸山（元） (98.2 m, 総 79,520 千m³)
--     新丸山 (118.4 m, 131,350 千m³) is still being built
--     (https://www.cbr.mlit.go.jp/shinmaru/); prod's （再） has no completion
--     year. gifu-kasen and kasenbosai are on 丸山（元）.
--   435 木屋川   2022 木屋川（再） → 2025 木屋川（元） (41.0 m, 総 21,750 千m³)
--     The （再） is Yamaguchi's 10 m raising, adopted 2021, compensation
--     agreed 2025-10 (https://www.pref.yamaguchi.lg.jp/soshiki/132/23891.html);
--     no completion year on prod. yamaguchi-bousai and kasenbosai are on
--     木屋川（元）.
--   369 大日      1594 大日川 → 1593 大日 (36.0 m, 総 1,100 千m³)
--     大日川 (42.8 m, 2,099 千m³) is nearer the district-map marker and its
--     name contains "大日". hyogo-bodik and kasenbosai are on 大日.
--   447 黒杭川上流 1990 黒杭 → 1991 黒杭川上流 (48.0 m, 総 450 千m³)
--     黒杭 (16.9 m, 246 千m³) is nearer the marker and "黒杭川上流" contains
--     its name. yamaguchi-bousai is on 黒杭川上流.
--   366 長谷（兵庫県） 1565 長谷 → 1573 長谷 (30.3 m, 総 240 千m³)
--     mudam: 兵庫県, 千種川水系長谷川, 34°56'23" 134°26'40" — Hyogo's 長谷.
--     The district-map marker sits on 1565, Kansai Electric's 102 m 長谷
--     (9,604 千m³) 30 km away. The 1,827 mudam levels on 1565 (210.28–
--     212.40) are Hyogo's 長谷 (常時満水位 211.4; hyogo-bodik and kasenbosai
--     on 1573 read 211.42–212.72).
--   524 小ヶ倉   2592 小ヶ倉 (長崎県) → 2609 小ヶ倉 (長崎市) (41.2 m, 総 2,040 千m³)
--     mudam: 鹿尾川水系鹿尾川, 32°42'58" 129°52'35", completed 1987 —
--     2609. The marker sits on 2592 (21.1 m, 2,200 千m³), 22 km away. The
--     mudam levels on 2592 have a median of 88.67 m (常時満水位 90.6);
--     kasenbosai on 2609 reads 87.97–90.88, on 2592 0–26.23.
--
-- 172 遠野 and 309 上市川 carry no stamp on prod; the task stamps them on
-- its next run. Past observations move with `observations:rebind`, not here.

CREATE TEMP TABLE mudam_pin (key text, to_ndi text);

INSERT INTO mudam_pin VALUES
  ('3',   '156'),
  ('54',  '901'),
  ('180', '257'),
  ('310', '1108'),
  ('366', '1573'),
  ('369', '1593'),
  ('435', '2025'),
  ('447', '1991'),
  ('524', '2609');

UPDATE dams t
SET external_ids = t.external_ids || jsonb_build_object('mudam', p.key)
FROM mudam_pin p
WHERE t.external_ids->>'ndi' = p.to_ndi
  AND NOT t.external_ids ? 'mudam'
  AND EXISTS (
    SELECT 1 FROM dams s
    WHERE s.external_ids->>'mudam' = p.key
      AND s.external_ids->>'ndi' IS DISTINCT FROM p.to_ndi
  );

UPDATE dams f
SET external_ids = f.external_ids - 'mudam'
FROM mudam_pin p
JOIN dams t ON t.external_ids->>'ndi' = p.to_ndi
WHERE f.external_ids->>'mudam' = p.key
  AND t.external_ids->>'mudam' = p.key
  AND f.id <> t.id;

DROP TABLE mudam_pin;
