-- 0107: trust shimonoseki-suido's 貯水率.
--
-- Issue #1 (coverage). ingest_shimonoseki_suido reads 下関市上下水道局「水源状況に
-- ついてお知らせします」 (city.shimonoseki.lg.jp/site/water/5617.html) and writes
-- only 湯の原ダム (NDI 2024, master 有効貯水容量 2,050,000 m³), storing 貯水量 (m³)
-- and 貯水率 as printed.
--
-- Verified the way 0048 requires — adapter column choice, then the upstream's
-- own figures back-solved as volume / rate. The page prints the 満水量 it divides
-- by, and that 満水量 follows the season (洪水期 6/15–9/15 caps 湯の原 at
-- 1,620,000 m³, per the page's own 注意):
--
--   洪水期   2025-07-14 (Wayback 20250714024937): 満水量 1,620,000,
--            699,000 / 43.1 % = 1,622 千m³ — against the static 2,050,000 it
--            would read 34.1 %.
--   非洪水期 2026-09-25 (live): 満水量 2,050,000,
--            507,000 / 24.7 % = 2,053 千m³ (master 有効 2,050).
--
-- So the rate is the city's season-aware pool; untrusted, the site would divide
-- by the annual capacity all summer and understate the dam by ~9 points.
--
-- Upsert for 0048's reason: on a fresh database the adapter's
-- ensureSourcePriority() has not run yet, and it never touches
-- trusted_rate_basis.
INSERT INTO source_priorities (source_id, priority, description, active, trusted_rate_basis)
VALUES
  ('shimonoseki-suido', 293, '下関市上下水道局 水源状況 — 湯の原ダム (貯水量+貯水率, 当日0時, 週数回更新)', TRUE, TRUE)
ON CONFLICT (source_id) DO UPDATE
  SET trusted_rate_basis = TRUE;
