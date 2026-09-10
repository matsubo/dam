-- 0048: trust six more sources that publish a season-aware native 貯水率.
--
-- 0040 marked 15 sources trusted_rate_basis and left ~23 unverified. Issue #38
-- §2-2 listed 72 dams whose API storageRate disagreed with
-- storageVolumeM3 / effectiveActiveCapacityM3, concentrated in exactly those
-- unverified prefectural feeds. The disagreement was not cosmetic: with no
-- trust flag the site divided by the static annual capacity and published a
-- 渇水 warning for dams the prefecture reports as full.
--
--   稲葉ダム (oita-bousai)     site 11.2 %  vs 大分県 101.2 %
--   温海川ダム (yamagata-bousai) site  9.9 % vs 山形県  97.7 %
--   奥野ダム (shizuoka-bousai)  site 27.4 %  vs 静岡県 100.0 %
--   薗原ダム (ktr-tone-dam)     site 26.6 %  vs 利根川ダム統管 100.0 %
--
-- Each source below was verified the way 0040 requires — read the adapter's
-- column choice, then pull the upstream feed live (2026-09-11) and check that
-- volume/rate lands below the dam's annual capacity for several dams, i.e.
-- that the denominator really is a current-season pool:
--
--   oita-bousai      稲葉 694/1.012 = 686 千m³ (annual 6,190); 床木 509 (3,120)
--   yamagata-bousai  all 15 dams below annual; 温海川 445 (4,400);
--                    寒河江 55,373 (98,000); 高坂 3,313 (12,750)
--   shizuoka-bousai  奥野 1,259 (4,600); 太田川 5,229 (10,800);
--                    長島 19,669 (68,000). 大倉川（農）is the one outlier —
--                    its published rate implies 2,810 千m³ against a 2,050
--                    master figure, a master-data question, not a basis one.
--   saga-bousai      the 現況表 prints 利水容量 per dam: 本部 452/0.600 = 753
--                    against a printed 利水容量 of 750; 中木庭 2,739 (2,800)
--   ktr-tone-dam     薗原 3,755 (14,140) — the 洪水期 pool the manager
--                    publishes; 藤原 12,803 (31,000)
--   nagasaki-kasen   only after this migration's sibling adapter fix: the feed
--                    carries rate_r (利水) alongside rate/rate_y (有効), and
--                    the adapter now reads rate_r. Verified against the feed's
--                    own dam_m.json: 船津 35.5 % = 38/107 千m³ 利水.
--
-- Not added, deliberately: chiba / osaka mix denominators within the
-- prefecture (千葉 3 dams on 利水, the rest 有効; 大阪 names its exceptions in
-- a footnote), and okinawa-eb divides by 有効貯水容量, which is already the
-- static denominator. kanagawa, ehime-bousai, kagawa-bousai, hkd-mlit,
-- kkr-mlit, jwa-chikugo, jwa-chubu and jwa-chiba remain unverified.
--
-- Effect: ~60 dams switch from volume/annual-capacity to their manager's own
-- rate, and the watershed aggregates that sum effective_active_capacity_m3()
-- move with them.
-- Upsert rather than UPDATE: on a fresh database the migrations run before any
-- adapter has called its ensureSourcePriority(), so a bare UPDATE would match
-- no rows and the flag would be lost. The adapters' own upserts only ever set
-- priority / description / active, so the flag survives them.
INSERT INTO source_priorities (source_id, priority, description, active, trusted_rate_basis)
VALUES
  ('oita-bousai',     308, '大分県河川情報 ダム諸量現況表',                    TRUE, TRUE),
  ('yamagata-bousai', 308, '山形県河川・砂防情報 ダム',                        TRUE, TRUE),
  ('shizuoka-bousai', 308, '静岡県 SIPOS ダム',                                TRUE, TRUE),
  ('saga-bousai',     308, '佐賀県河川砂防情報システム ダム現況表',            TRUE, TRUE),
  ('ktr-tone-dam',    303, '国土交通省 関東地方整備局 利根川ダム統合管理事務所', TRUE, TRUE),
  ('nagasaki-kasen',  308, '長崎県河川砂防情報 ダム情報',                      TRUE, TRUE)
ON CONFLICT (source_id) DO UPDATE
  SET trusted_rate_basis = TRUE;
