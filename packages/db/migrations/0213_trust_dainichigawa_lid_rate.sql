-- 0213: trust dainichigawa-lid's 貯水率.
--
-- Issue #1 (coverage). ingest_dainichigawa_lid reads 大日川土地改良区「大日川ダム
-- 情報」 (dainichigawa-lid.com/dam.html and its monthly 日別ダム情報 PDFs) and
-- writes only 大日川ダム (NDI 1594, master 有効貯水容量 2,032,000 m³), storing
-- 貯水量 (万t → m³) and 貯水率 as printed.
--
-- Verified the way 0048 requires — adapter column choice, then the upstream's
-- own figures back-solved as volume / rate. Every page and PDF prints the
-- denominator it uses, 「最大貯水量191.5万ｔ」 (dam.html:
-- 「１，７４６，５００トン　／　【最大】１，９１５，０００トン」):
--
--   2026-09-28  174.65 万t / 91.2 % = 191.5 万t
--   2026-09-01  103.10 万t / 53.8 % = 191.6 万t
--
-- That is the district's own full pool, not the master's 2,032 千m³ (the 概要
-- page's 当初計画 figures are older still: 総貯水量 2,099,615 m³). Untrusted,
-- the site would divide by 2,032 千m³ and show 85.9 % where the district
-- publishes 91.2 % — the same call 0098 made for sasebo-suido's 川谷, whose
-- printed 有効貯水量 differs from the master.
--
-- Upsert for 0048's reason: on a fresh database the adapter's
-- ensureSourcePriority() has not run yet, and it never touches
-- trusted_rate_basis.
INSERT INTO source_priorities (source_id, priority, description, active, trusted_rate_basis)
VALUES
  ('dainichigawa-lid', 278, '大日川土地改良区 大日川ダム情報 — 大日川ダム (日別 PDF, 午前9時)', TRUE, TRUE)
ON CONFLICT (source_id) DO UPDATE
  SET trusted_rate_basis = TRUE;
