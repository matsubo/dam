-- 0083: drop the '中里' dam that 0031 invented in 長野 (#79).
--
-- 0031 inserted slug nakazato-20 ('中里', pref 20, no NDI id, "approximate"
-- coordinates 137.60/35.70) because jwa-chubu's 中里ダム and jwa-kiso-rt's
-- 中里貯水池 found no 長野 master. There is none to find: both are 三重用水's
-- reservoir in いなべ市, already in the master as nakazato-24 (NDI 940,
-- 水資源開発公団二工, 有効 16,000 千m³). Evidence, pages fetched 2026-09-27:
--
--   water.go.jp/mizu/chubu/report/          中里ダム sits under 「三重用水
--                                          (中里ダム・調整池合計)」, 利水容量
--                                          16,000 千m³, 貯水量 1,760 (11.0 %)
--   water.go.jp/mizu/chubu/realtime/index.html  中里貯水池 is listed under
--                                          <h4>三重用水</h4> with 宮川・菰野・
--                                          加佐登調整池, 有効貯水量 1,752 千m³
--   pref.mie.lg.jp/D1KIGYO/12674013222.htm  三重県企業庁: 中里ダム 有効
--                                          16,000 / 現在 1,769 千m³ (11.0 %)
--
-- The two tasks now bind 中里 within pref 24; bindExternalId takes their
-- stamps off the stub on the next run.
--
-- On production the stub holds those tasks' past readings (2,597 jwa-kiso-rt
-- + 67 jwa-chubu rows, 2026-06-11 … 2026-09-27), and observations reference
-- dams ON DELETE RESTRICT. Moving them is a compressed-hypertable write,
-- which 0045 keeps out of migrations, so here the row goes only once nothing
-- references it: at once on a fresh database, and on production after the
-- one-off move that ships with this change. source_universe and match_review
-- references are ON DELETE SET NULL; backfill_progress cascades.
DELETE FROM dams d
WHERE d.slug = 'nakazato-20'
  AND NOT (d.external_ids ? 'ndi')
  AND NOT EXISTS (SELECT 1 FROM observations o WHERE o.dam_id = d.id);
