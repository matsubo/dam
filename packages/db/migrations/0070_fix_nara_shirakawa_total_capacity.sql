-- 0070: give 白川（再） (奈良県天理市) its 総貯水容量 back.
--
-- Issue #79. The master carries ダム便覧's figures for 白川ダム（再） (No.1572,
-- https://dambinran.damnet.or.jp/wp-json/dmap/dam-info/124480):
-- capacity_total "1360" = capacity_active "1360" 千m³, i.e. no 堆砂容量. The
-- manager's spec page (奈良県 河川整備課, https://www.pref.nara.lg.jp/n138/9770.html,
-- 更新日 2026-07-16) reads 総貯水容量 1,560,000 m³ = 有効貯水容量 1,360,000
-- (洪水調節 500,000 + 農業用水 860,000) + 計画堆砂容量 200,000. The prefecture's
-- live ダム現況表 agrees: 貯水容量 + 空容量 = 338 + 1,222 = 1,560 千m³ on
-- 2026-09-27 18:20 JST. 有効貯水容量 (effective/active, the 貯水率 denominator)
-- is already right and is left alone.
--
-- With the total at 1,560,000, ingest:nara-kasen's check that the printed
-- sum equals the master 総貯水容量 passes and it stores 貯水容量 − 堆砂容量.
-- storage_rate is volume / active_capacity_m3, which does not change, so no
-- stored observation needs recomputing.
--
-- master:refresh:damnet writes ダム便覧's non-blank total over this
-- (COALESCE(new, existing)), so it lasts only until the next monthly refresh
-- unless ダム便覧 is corrected. Keyed by NDI id; guarded on the wrong value so
-- a rerun, or a row ダム便覧 has since changed, is untouched.

UPDATE dams SET total_capacity_m3 = 1560000
WHERE external_ids->>'ndi' = '1417'  -- shirakawa-29 白川（再）
  AND total_capacity_m3 = 1360000
  AND effective_capacity_m3 = 1360000;
