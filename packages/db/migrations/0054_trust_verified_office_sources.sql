-- 0054: trust four more sources whose own 貯水率 is 利水容量-based.
--
-- Issue #55 carries the three CSVs attached to #38 (queried 2026-09-09). A
-- re-run against production on 2026-09-25 showed 0046–0051 cleared nearly all
-- of the 72 storageRate ≠ storageVolumeM3 / effectiveActiveCapacityM3 rows.
-- What remained were dams fed by sources 0048 never verified, which the site
-- still divides by the static 有効貯水容量:
--
--   鶴田 (qsr-turuta-dam)   site 12.6 %  vs 九州地方整備局 利水貯水率 20.1 %
--   鹿野川 (skr-hiji-dam)   site 28.9 %  vs 四国地方整備局 ~60 %
--
-- Verified the way 0048 requires — adapter column choice, then the upstream
-- pulled live (2026-09-25), volume/rate compared with the annual capacity:
--
--   skr-hiji-dam    a week of 10-minute rows (n=1,056) regresses volume on rate
--                   with an intercept ≈ 0, so no (volume − floor) offset:
--                   野村 9,489 / 鹿野川 18,158 千m³, and 四国地方整備局's own
--                   渇水状況資料 prints 利水容量 9,480 / 18,100 千m³ (annual
--                   有効 12,700 / 36,200).
--   qsr-turuta-dam  the office's detail page prints 利水貯水率 and 有効貯水率
--                   side by side; at 08:00 the adapter's feed read 20.1 %,
--                   equal to 利水 (有効 was 12.1 %). Implied 60,145 千m³
--                   against annual 98,000.
--   jwa-chikugo     the page prints its own 貯水容量 next to each 貯水率 —
--                   season-tiered for 松原/下筌, a fixed purpose pool (利水 +
--                   渇水対策) elsewhere — and volume/rate reproduces it on all
--                   7 dams: 下筌 30,312 (annual 52,300), 寺内 8,229 (17,030),
--                   大山 11,001 (18,000). 合所/江川 equal their annual figure.
--   kagawa-bousai   the JSON carries no capacity, but volume/rate sits below
--                   annual for every live dam with a per-dam spread (殿川 411
--                   / 620, 内場 5,695 / 7,980, 長柄（再）2,198 / 7,740), and
--                   #39's survey found 香川 states a 利水容量 basis. 府中 lands
--                   ~1 % above 総貯水容量 — a master-rounding question, like
--                   0048's 大倉川（農）.
--
-- Not added, deliberately: tndam-hyogo divides by 満水時貯水量, which its own
-- WLgraph.jsp prints per dam (鍔市 1,070,000 m³ against 有効 974,000) — 1.5–17 %
-- ABOVE the static denominator, so trusting it would lower every 兵庫 rate
-- below the one already shown. chiba-suisei stays out for 0048's reason.
-- hkd-mlit-dam back-solves to the annual figure (金山 130.0 / 130.0 百万m³),
-- so trusting it changes nothing and would re-arm #32's swing with
-- kasenbosai. tokyo-waterworks does print its current pool (薗原
-- 1,322(300) 万m³, and volume/rate lands on the 300), but its combined
-- 村山・山口 row is matched to 村山下 alone (#54) and would back-solve above
-- that dam's annual capacity; it waits on #54. What it would gain is small
-- anyway — ktr-tone-dam, already trusted, outranks it on the 利根川 dams,
-- leaving the four 荒川 ones.
--
-- All four adapters above clamp the rate to 1, as oita/shizuoka did under
-- 0048: a dam over 100 % of its pool back-solves to its own volume and shows
-- 100 %. None of the four read over 100 % this week.
--
-- Upsert for the same reason as 0048: on a fresh database the adapters'
-- ensureSourcePriority() has not run yet, and their own upserts never touch
-- trusted_rate_basis.
INSERT INTO source_priorities (source_id, priority, description, active, trusted_rate_basis)
VALUES
  ('skr-hiji-dam',   303, '国土交通省 四国地方整備局 肱川ダム統合管理事務所 — 野村・鹿野川ダム (Ehime)', TRUE, TRUE),
  ('qsr-turuta-dam', 303, '国土交通省 九州地方整備局 鶴田ダム管理所 — 鶴田ダム (川内川水系, Kagoshima)', TRUE, TRUE),
  ('jwa-chikugo',    297, '水資源機構 筑後川ダム統合管理事務所 — daily 0時, 7 dams',                   TRUE, TRUE),
  ('kagawa-bousai',  308, 'かがわ防災Webポータル ダム諸量 — 18 ダム hourly JSON',                     TRUE, TRUE)
ON CONFLICT (source_id) DO UPDATE
  SET trusted_rate_basis = TRUE;
