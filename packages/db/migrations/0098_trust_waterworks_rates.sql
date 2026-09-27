-- 0098: trust the 貯水率 of two city waterworks feeds.
--
-- Issue #1 (coverage). Verified the way 0048 requires — adapter column choice,
-- then the upstream's own published figures (captured 2026-09-27) back-solved
-- as volume / rate against the master's 有効貯水容量:
--
-- sasebo-suido (佐世保市水道局 水道用貯水池の貯水状況表, daily PDF). The adapter
-- stores 現在貯水量 (m³) and 貯水率, which the report divides by the 有効貯水量
-- printed on the same line — the city's 水道 pool:
--   山の田 479,184 / 87.0 % = 551 千m³   (master 有効 551)
--   相当   383,516 / 95.9 % = 400 千m³   (master 有効 400)
--   下の原 1,355,400 / 62.1 % = 2,183 千m³ (master 有効 2,182)
--   川谷   1,310,523 / 81.4 % = 1,610 千m³ (master 有効 1,910 — 農業+水道; the
--          city divides by its own 1,610 share, so untrusted it would show
--          68.6 % against the city's 81.4 %)
--
-- kitakyushu-suido (北九州市上下水道局 北九州市の水源状況, weekday HTML). The
-- adapter stores 貯水量 (万m³ → m³) and 貯水率. The city's own reservoirs
-- back-solve to their static capacity, the multipurpose ones to a 利水 pool
-- below it:
--   道原   40 / 87.8 % = 45.6 万m³ (有効 45.0), 白木 16 / 49.7 % = 32.2 (32.4)
--   油木   589 / 40.8 % = 1,444 万m³ (annual 有効 1,745)
--   ます渕 726 / 64.0 % = 1,134 万m³ (1,344), 力丸 462 / 42.8 % = 1,079 (1,250)
-- 貯水量 is printed to the 万m³, so for the small reservoirs the published rate
-- is also the more precise figure (白木 16 万m³ / 32.4 = 49.4 % vs 49.7 %).
--
-- Not added: matsue-suido divides by the static 有効貯水容量 (千本 280,269 /
-- 74.0 % = 378.7 千m³, 有効 379), which is the site's denominator already —
-- 0048's okinawa-eb reasoning.
--
-- Upsert for 0048's reason: on a fresh database the adapters'
-- ensureSourcePriority() has not run yet, and it never touches
-- trusted_rate_basis.
INSERT INTO source_priorities (source_id, priority, description, active, trusted_rate_basis)
VALUES
  ('sasebo-suido', 300, '佐世保市水道局 水道用貯水池の貯水状況表 — 6 ダム (日次 PDF, 貯水量+貯水率)', TRUE, TRUE),
  ('kitakyushu-suido', 300, '北九州市上下水道局 北九州市の水源状況 — 10 水源 (水位+貯水量+貯水率, 平日日次)', TRUE, TRUE)
ON CONFLICT (source_id) DO UPDATE
  SET trusted_rate_basis = TRUE;
