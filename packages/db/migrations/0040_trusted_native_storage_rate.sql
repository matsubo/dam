-- Issue #17: 貯水率 was wrong for flood-control dams (e.g. 八田原ダム) because
-- dams.active_capacity_m3 (利水容量) is a single static value from Damnet with
-- no 洪水期/非洪水期 seasonal split, while some upstream feeds already publish
-- a correct, season-aware 利水容量-based rate that the read-time queries
-- discarded in favor of recomputing storage_volume_m3 / active_capacity_m3.
--
-- trusted_rate_basis marks source_ids whose own storage_rate (when present on
-- an observation row) is verified to be computed against 利水容量/有効貯水容量
-- (not 総貯水容量 or some other basis). A row's storage_rate alone can't be
-- trusted blindly: migration 0036's trigger and storage_rate_recompute.ts both
-- backfill storage_rate = volume/active_capacity_m3 whenever it was NULL, so a
-- non-null value may be genuine upstream data or our own static-capacity
-- recompute. Only the source_id tells them apart.
ALTER TABLE source_priorities ADD COLUMN IF NOT EXISTS trusted_rate_basis BOOLEAN NOT NULL DEFAULT FALSE;

-- Seed rows for sources that may not have run yet in this environment, using
-- each adapter's own ensureSourcePriority() values (apps/worker/src/tasks/).
-- DO NOTHING preserves whatever the adapter itself already wrote.
INSERT INTO source_priorities (source_id, priority, description, active) VALUES
  ('hiroshima-bousai', 310, '広島県防災Web — hourly, 18ダム (JSON feed, 10分更新)', true),
  ('okayama-bousai',   309, 'おかやま防災ポータル — hourly, ~15 県管理ダム (JSON feed, 30分更新)', true),
  ('tottori-bousai',   312, '鳥取県防災Web — hourly, 6ダム (百谷/佐治川/東郷/賀祥/朝鍋/菅沢; JSON feed)', true),
  ('kasenbosai',       310, '国土交通省 川の防災情報 (MLIT SCC) — 全国 800+ ダム / 10-min cadence per-dam JSON', true),
  ('miyagi-kasen',     308, '宮城県土木総合情報システム ダム現況表 — 21 ダム (18 県管理 + 3 国管理), hourly', true),
  ('shimane-bousai',   313, '島根県水防情報システム (suibou-shimane.jp) — 19ダム hourly JSON', true),
  ('niigata-bousai',   308, '新潟県河川防災情報システム — hourly, ~20 県管理ダム (防災Web dk=4 table)', true),
  ('fukui-bousai',     308, '福井県河川・砂防総合情報システム ダム諸量現況表 — 13 ダム (Shift_JIS HTML, hourly)', true),
  ('aitoyo',           295, 'あいとよネット (公益財団法人 愛知・豊川用水振興協会) — daily, 7 dams in 木曽川/豊川/矢作川 系', true),
  ('jwa-toneara',      296, '水資源機構 関東支社 利根川/荒川系 — daily 0時, 13 facilities', true),
  ('jwa-junpo',        290, '水資源機構 旬報 (real, 10-day cadence, statutory open data)', true),
  ('jwa-yoshino',      297, '水資源機構 吉野川上流総管 — hourly, 5 dams (池田/早明浦/新宮/富郷/柳瀬)', true),
  ('shimokubo',        297, '水資源機構 利根川上流総合管理所 下久保ダム 実時計 (10分間隔)', true),
  ('kochi-bousai',     308, '高知県水防情報システム ダム諸量現況表 — 11 ダム (静的 Shift_JIS HTML)', true),
  ('kumamoto-bousai',  308, '熊本県防災情報システム 地方別ダム情報 — 6 ダム (Shift_JIS JS, 60分更新)', true)
ON CONFLICT (source_id) DO NOTHING;

UPDATE source_priorities SET trusted_rate_basis = TRUE
WHERE source_id IN (
  'hiroshima-bousai', 'okayama-bousai', 'tottori-bousai', 'kasenbosai', 'miyagi-kasen',
  'shimane-bousai', 'niigata-bousai', 'fukui-bousai', 'aitoyo', 'jwa-toneara',
  'jwa-junpo', 'jwa-yoshino', 'shimokubo', 'kochi-bousai', 'kumamoto-bousai'
);

-- Per-observation effective 利水容量: when the source is trusted and reports
-- its own rate, back-solve the capacity it implies (volume/rate) so the value
-- can still be summed/averaged like a capacity across a cohort of dams;
-- otherwise fall back to the dam's static active_capacity_m3.
CREATE OR REPLACE FUNCTION effective_active_capacity_m3(
  active_capacity_m3 NUMERIC,
  storage_volume_m3 NUMERIC,
  storage_rate NUMERIC,
  trusted BOOLEAN
) RETURNS NUMERIC
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN trusted
      AND storage_rate IS NOT NULL AND storage_rate > 0
      AND storage_volume_m3 IS NOT NULL
      THEN storage_volume_m3 / storage_rate
    ELSE active_capacity_m3
  END
$$;
