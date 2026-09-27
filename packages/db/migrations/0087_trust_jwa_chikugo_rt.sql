-- 0087: trust jwa-chikugo-rt's 貯水率.
--
-- ingest_jwa_chikugo_rt reads 水資源機構 筑後川局 水管理情報WEB
-- (chikugo.ec-net.jp/chikugo/kyoku/pc/new/rep*_I60.html), whose dam pages
-- print 有効貯水量 and 貯水率 per hour. The adapter stores both as published.
--
-- Verified the way 0048 requires — adapter column choice, then the upstream's
-- own 24 hourly rows (2026-09-26 22:00 … 09-27 21:00 JST, the fixtures under
-- tests/fixtures/jwa_chikugo_rt/) back-solved as volume / rate against the
-- master's annual 有効貯水容量:
--
--   江川      23,906 – 24,088 千m³  (annual 有効 24,054; no flood pool)
--   寺内       8,215 –  8,246 千m³  (annual 有効 17,030)
--   小石原川  34,954 – 35,047 千m³  (annual 有効 39,100)
--   大山      10,993 – 11,007 千m³  (annual 有効 18,000)
--
-- A fixed pool per dam within the rounding of a one-decimal rate, and exactly
-- the 貯水容量 that water-source.html prints beside the same rate (江川 24,000
-- / 寺内 8,230 / 小石原川 35,000 / 大山 11,000 千m³) — the pool 0054 already
-- trusts for the daily jwa-chikugo. 筑後大堰 publishes no rate; the adapter
-- stores it with a NULL rate, so the 0051 trigger derives one as before.
--
-- Upsert for 0048's reason: on a fresh database the adapter's
-- ensureSourcePriority() has not run yet, and it never touches
-- trusted_rate_basis.
INSERT INTO source_priorities (source_id, priority, description, active, trusted_rate_basis)
VALUES
  ('jwa-chikugo-rt', 298, '水資源機構 筑後川局 水管理情報WEB — hourly, 5 施設 (江川/寺内/小石原川/大山/筑後大堰)', TRUE, TRUE)
ON CONFLICT (source_id) DO UPDATE
  SET trusted_rate_basis = TRUE;
