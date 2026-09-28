-- 0219: trust the 貯水率 of omura-suido, hirado-suido and kanda-suido, and
-- give the non-master rows of those and sue-suido a not_dam_reason (#1,
-- coverage).
--
-- Trust — verified the way 0048 requires: read the adapter's column choice,
-- then back-solve the upstream's own figures (captured 2026-09-28) as
-- volume / rate. Each page prints the capacity it divides by:
--
-- omura-suido (大村市上下水道局 ダム（水源）情報, omura-waterworks.jp/water/).
-- Writes 池田（再） only (NDI 2583, master 有効 209,000 m³):
--   池田 183,274 / 91.6 % = 200,081 m³ — the printed 利水貯水量 200,000.
--   Untrusted, the site would show 87.7 % against the city's 91.6 %.
--
-- hirado-suido (平戸市水道局 市内水道用ダムの貯水状況, R8.9.24 edition). 貯水率 =
-- 貯水量 / the printed 満水量, the city's 水道 pool:
--   神曽根第2 89,000 / 89.0 % = 100,000 (master 有効 120,000)
--   箕坪     383,760 / 73.8 % = 520,000 (520,000)
--   阿奈田   120,822 / 92.9 % = 130,056 (160,000)
--   神の川    89,328 / 55.8 % = 160,086 (223,000)
--   桜川      94,260 / 78.6 % = 119,924 (120,000)
--   Untrusted, 神の川 would read 40.1 % against the city's 55.8 % — the same
--   case as sasebo-suido's 川谷 share in 0098.
--
-- kanda-suido (苅田町水道課 水源の状況, 令和8年9月28日現在). 貯水率 = 貯水量 /
-- the printed 有効貯水量:
--   山口 633 / 85.9 % = 737 千m³ (master 有効 736)
--   油木 6,463 / 44.7 % = 14,459 千m³ against a printed 14,450, the 洪水期
--        (6/1–10/20) 利水容量 福岡県's 主要ダム貯水状況 lists for 油木; annual
--        有効 17,450. kitakyushu-suido's 油木 is trusted for the same pool (0098).
--
-- Upsert for 0048's reason: on a fresh database the adapters'
-- ensureSourcePriority() has not run yet, and it never touches
-- trusted_rate_basis.
INSERT INTO source_priorities (source_id, priority, description, active, trusted_rate_basis)
VALUES
  ('omura-suido', 292, '大村市上下水道局 ダム（水源）情報 — 池田貯水池 (日次 07:00, 利水貯水量+利水貯水率)', TRUE, TRUE),
  ('hirado-suido', 293, '平戸市水道局 市内水道用ダムの貯水状況 — 5 ダム (約10日毎, 貯水量+貯水率)', TRUE, TRUE),
  ('kanda-suido', 293, '苅田町水道課 水源の状況 — 油木/山口 (日次, 貯水量+貯水率)', TRUE, TRUE)
ON CONFLICT (source_id) DO UPDATE
  SET trusted_rate_basis = TRUE;

-- Not dams in the master. None of these names has a row in the NDI master
-- (pref 40 / 42 checked 2026-09-28: no dam named like 平床, 轟, 東流, 井ノ口,
-- 柱田 or 男鳥).
-- Upsert: the adapters have not recorded the rows yet when this runs on
-- deploy, and recordUniverse never touches not_dam_reason.
INSERT INTO source_universe AS su
  (source_id, source_external_id, source_name, pref_code, not_dam_reason)
VALUES
  ('hirado-suido', '平床の池', '平床の池', '42',
   '平戸市 早福地区の水道水源の池 (満水量 3,000 m³, city.hirado.nagasaki.jp/kurashi/life/water/cyosuiritsu.html, 令和8年9月24日): not in the NDI dam master.'),
  ('hirado-suido', '轟川砂防ダム', '轟川砂防ダム', '42',
   '平戸市 大島地区の水道取水に使う砂防ダム (満水量 27,000 m³, same page): a 砂防 structure, not in the NDI dam master.'),
  ('hirado-suido', '東流川砂防ダム', '東流川砂防ダム', '42',
   '平戸市 大島地区の水道取水に使う砂防ダム (満水量 30,000 m³, same page): a 砂防 structure, not in the NDI dam master.'),
  ('kanda-suido', '井ノ口池', '井ノ口池', '40',
   '苅田町 南原浄水場の水源の池 (有効貯水量 220 千m³, town.kanda.lg.jp/page/2021.html, 令和8年9月28日): not in the NDI dam master.'),
  ('sue-suido', '中柱田貯水池', '中柱田貯水池', '40',
   '須恵町の水道水源の貯水池 (town.sue.fukuoka.jp/soshiki/jogesuido/jogesuido/josuido/1394.html, 更新日 2026-09-01): not in the NDI dam master.'),
  ('sue-suido', '旧男鳥溜池', '旧男鳥溜池', '40',
   '須恵町の水道水源の溜池 (same page): not in the NDI dam master.'),
  ('sue-suido', '新男鳥溜池', '新男鳥溜池', '40',
   '須恵町の水道水源の溜池 (same page): not in the NDI dam master.')
ON CONFLICT (source_id, source_external_id) DO UPDATE
  SET not_dam_reason = EXCLUDED.not_dam_reason;
