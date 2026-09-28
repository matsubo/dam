-- 0188: move nagasaki-kasen's 小ヶ倉ダム (dam_cd 1106) stamp to 長崎市's 小ヶ倉.
--
-- pref 42 has two 小ヶ倉 masters, NDI 2592 (諫早市, 長崎県, 有効 2,145 千m³)
-- and NDI 2609 (長崎市, 鹿尾川, 有効 1,940 千m³). The task's name rule broke
-- the tie by the lower dam id and stamped 2592. The station is 2609's:
--
--   - dam_cd 11xx is dam_m.json's 長崎市 block (式見 1101, 鹿尾 1105,
--     本河内高部 1112 …).
--   - Prod, 2026-09-28: every one of the 2,738 readings it shares an instant
--     with kasenbosai's 「小ヶ倉(補助)ダム」 (1075300700019, stamped on 2609)
--     has the same 貯水位 (87.97–90.89 m), and the 4 latest 貯水量 / 貯水率
--     (1,482,000–1,484,000 m³, 81.7–81.8 %) match too. kasenbosai's station
--     on 2592 reads 0–26 m, and the 9/1 and 9/15 九州農政局 surveys draw 2592
--     down to 434 and 159 千m³ while this station stays at 88–89 m.
--   - mudam's 小ヶ倉 (listing 524) is pinned to 2609 by migration 0073.
--
-- ingest_nagasaki_kasen now pins dam_cd 1106 to NDI 2609 (NDI_PINS), so it
-- would move the stamp on its next run; this moves it at deploy so nothing
-- reads the old binding in between. Keyed by NDI; a no-op where 2592 carries
-- no stamp (fresh DB, or already moved).
--
-- Past observations move with `observations:rebind`, not here:
--   {"moves":[{"sourceId":"nagasaki-kasen","fromNdi":"2592","toNdi":"2609"}]}

UPDATE dams t
SET external_ids = t.external_ids || jsonb_build_object('nagasaki-kasen', '1106')
FROM dams f
WHERE f.external_ids->>'ndi' = '2592'
  AND f.external_ids->>'nagasaki-kasen' = '1106'
  AND t.external_ids->>'ndi' = '2609';

UPDATE dams f
SET external_ids = f.external_ids - 'nagasaki-kasen'
FROM dams t
WHERE f.external_ids->>'ndi' = '2592'
  AND f.external_ids->>'nagasaki-kasen' = '1106'
  AND t.external_ids->>'ndi' = '2609'
  AND t.external_ids->>'nagasaki-kasen' = '1106';
