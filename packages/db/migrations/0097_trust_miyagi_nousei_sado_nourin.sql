-- 0097: trust the native 貯水率 of two new agricultural sources (#1, N18).
--
-- miyagi-nousei — 宮城県 農政部「農業用水の状況」(ingest_miyagi_nousei). The PDF
-- prints 利水容量 (ため池: 満水貯水量), 現在貯水量 and 貯水率 on the same row, and
-- the adapter keeps a row only if 貯水率 = 現在貯水量 / that capacity (or the
-- PDF's own 100 % clamp). Back-solved volume / rate from the 令和8年9月15日 PDF
-- (pulled 2026-09-27) against the master's 有効貯水容量:
--
--   岩堂沢   12,449 / 95.8 %  = 12,995 千m³  (master 13,000)
--   二ツ石    7,923 / 81.7 %  =  9,698 千m³  (master  9,700)
--   七ヶ宿   51,891 / 80.5 %  = 64,461 千m³  (master 99,500 — 利水 pool 64,500)
--   釜房     14,196 / 99.2 %  = 14,311 千m³  (master 39,300 — 利水 pool 14,314)
--   愛子       824 / 76.3 %  =  1,080 千m³  (master 愛子溜池 1,200)
--   孫沢溜池   148.4 / 21.7 % =    684 千m³  (master   857)
--
-- i.e. the denominator is the manager's 利水 / 満水 pool, at or below the
-- annual capacity — what 0048 requires. Where master and source agree
-- (岩堂沢/二ツ石) nothing changes; where they differ the prefecture's own rate
-- is the one shown.
--
-- sado-nourin — 新潟県 佐渡地域振興局「農業用ダムの貯水量情報」
-- (ingest_sado_nourin). Each page prints its 有効貯水量, the current volume and
-- a whole-percent 貯水率; the adapter drops a page where the rate does not
-- round from volume / 有効貯水量. Back-solved from the pages as of 令和8年8月15日
-- (pulled 2026-09-27):
--
--   羽茂     367,800 / 80 % = 459,750 m³  (page 460,000; master 460,000)
--   藤津川   386,509 / 54 % = 715,757 m³  (page 718,000; master 718,000)
--   小倉川   529,469 / 75 % = 705,959 m³  (page 706,790; master 900,000)
--   竹田川   594,520 / 68 % = 874,294 m³  (page 879,946; master 900,000)
--
-- The whole-percent rounding bounds the back-solved capacity within ~1 %.
--
-- Not trusted: kagawa-tameike (same slice) prints a rate with no volume, so
-- nothing can be back-solved.
--
-- Upsert for 0048's reason: on a fresh database the adapters'
-- ensureSourcePriority() has not run yet, and it never touches
-- trusted_rate_basis.
INSERT INTO source_priorities (source_id, priority, description, active, trusted_rate_basis)
VALUES
  ('miyagi-nousei', 286, '宮城県 農政部 農業用水の状況 — 主要ダム 17 基 + ため池 9 か所, 月1-2回 (貯水量+貯水率)', TRUE, TRUE),
  ('sado-nourin',   281, '新潟県 佐渡地域振興局 農業用ダムの貯水量情報 — 県営農業用ダム 7 基, 月1-2回 (貯水量+貯水率)', TRUE, TRUE)
ON CONFLICT (source_id) DO UPDATE
  SET trusted_rate_basis = TRUE;
