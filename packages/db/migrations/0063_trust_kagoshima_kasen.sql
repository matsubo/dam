-- 0063: trust kagoshima-kasen's 貯水率（利水）.
--
-- Issue #71. ingest_kagoshima_kasen reads the 鹿児島県河川砂防情報システム
-- ダム一覧表 (servletBousaiTableStatus?dk=4), which prints two rates per dam:
-- 貯水率（治水） and 貯水率（利水）. The adapter stores only 利水.
--
-- Verified the way 0048 requires — adapter column choice, then the upstream's
-- own history (tm=…, pulled 2026-09-27) back-solved as volume / rate against
-- the master's annual 有効貯水容量:
--
--   川辺  利水  587 / 88.9 % = 660,  650 / 98.5 % = 660,  655 / 99.2 % = 660
--              千m³ — a fixed pool, intercept ≈ 0 (annual 有効 2,460)
--   大和  利水  172 / 84.2 % = 204,  199 / 97.7 % = 204 千m³ (annual 有効 721)
--   大和  治水  199 / 27.7 % = 718,  214 / 29.7 % = 721 千m³ — i.e. the static
--              有効貯水容量 the site already divides by, which is why the
--              adapter does not read it.
--
-- 西之谷 is 治水専用 and publishes no 利水 rate; the adapter stores it with a
-- NULL rate, so the 0051 trigger derives (and labels) one from the static
-- capacity exactly as before. The upstream clamps 利水 at 100.0 above 常時満水位
-- (川辺 692 千m³ printed 100.0 on 2026-07-01), so a dam over its pool
-- back-solves to its own volume and shows 100 %, as for 0054's sources.
--
-- Upsert for 0048's reason: on a fresh database the adapter's
-- ensureSourcePriority() has not run yet, and it never touches
-- trusted_rate_basis.
INSERT INTO source_priorities (source_id, priority, description, active, trusted_rate_basis)
VALUES
  ('kagoshima-kasen', 309, '鹿児島県河川砂防情報システム ダム一覧表 — 3 ダム (Shift_JIS HTML, 10分更新)', TRUE, TRUE)
ON CONFLICT (source_id) DO UPDATE
  SET trusted_rate_basis = TRUE;
