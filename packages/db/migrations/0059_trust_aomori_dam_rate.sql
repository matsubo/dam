-- 0059: trust aomori-dam's 貯水率 — it is now the 利水容量 rate.
--
-- Issue #67. ingest_aomori.ts used to scrape the ダム諸量状況図 map, which
-- prints no rate, and stored storage_rate NULL. It now reads each dam's
-- ダム諸量グラフ (10分) page, whose table carries 貯水量(有効容量)[1000m³],
-- 貯水率(有効容量)[%] and 貯水率(利水容量)[%], and stores the 利水 rate
-- (有効 only where 利水 prints "---").
--
-- Verified the way 0048 requires — adapter column choice, then the upstream
-- pulled live (2026-09-27 16:30–16:40 JST), volume/rate against the master's
-- annual 有効貯水容量 (active_capacity_m3), 千m³:
--
--   有効 column = the annual figure, so the page's volume and capacity agree
--   with the master:  下湯 2,111/0.1920 = 10,995 (11,000); 久吉 1,654/0.2725 =
--   6,070 (6,070); 浅虫 107/0.6300 = 170 (170); 世増 33,123 (33,100);
--   川内 14,498 (14,500); 小泊 340 (340); 飯詰 2,007 (2,030).
--   利水 column = a smaller pool, below annual on every dam that prints it:
--   津軽 42,561/0.578 = 73,635 (127,200); 浅瀬石川 15,676 at 100 % (43,100);
--   下湯 2,111 at 100 % (11,000); 久吉 1,654 at 100 % (6,070); 浅虫
--   107/0.9727 = 110 (170); 川内 5,000 (14,500); 飯詰 747 (2,030).
--   It is season-aware: 世増 (EL 94.78) and 浅瀬石川 (EL 184.63) read 100 %
--   just above their 洪水貯留準備水位 (94.40 / 184.50), well below their
--   平常時最高水位 (97.70 / 196.00) — the 洪水期 pool, not the annual one.
--
-- The one mixed-basis case is safe under a source-level flag: 遠部 and 清水目
-- (治水 + 不特定 / 治水 only) print "---" for 利水, so the adapter stores the
-- 有効 rate. That rate is volume / annual 有効, the static denominator
-- itself, so effective_active_capacity_m3() back-solves to the master figure
-- (or, at 0 %, falls through to it) — identical to the untrusted result.
--
-- Upsert for the same reason as 0048: on a fresh database the adapter's
-- ensureSourcePriority() has not run yet, and its own upsert never touches
-- trusted_rate_basis.
INSERT INTO source_priorities (source_id, priority, description, active, trusted_rate_basis)
VALUES
  ('aomori-dam', 306,
   '青森県河川砂防情報提供システム ダム諸量グラフ — hourly, 7 dams (下湯/浅虫/久吉/遠部/浅瀬石川/津軽/清水目)',
   TRUE, TRUE)
ON CONFLICT (source_id) DO UPDATE
  SET trusted_rate_basis = TRUE;
