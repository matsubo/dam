-- 0220: sokobaru-dam — the two intake weirs on the 底原ダム管理システム menu
-- are not dams (#1).
--
-- ingest_sokobaru_dam records the menu's five facilities. 底原 / 真栄里 / 石垣
-- bind to NDI 2752 / 2753 / 2751; 二又堰 and 平喜名堰 stay unresolved, and
-- would otherwise sit in the unmatched backlog forever. Their pages
-- (www.cosmos.ne.jp/~sokobaru/00006001.html, 00007001.html, captured
-- 2026-09-28) carry 堰水位 / 責任放流量 / 取水量 / 洪水吐 / 土砂吐 only, no
-- storage, and the NDI master has no 二又 or 平喜名 row in any prefecture
-- (prod, 2026-09-28).
--
-- Upsert: on the deploy that adds the task, the task has not recorded the
-- rows yet, and recordUniverse never touches not_dam_reason (as in 0162).
INSERT INTO source_universe AS su
  (source_id, source_external_id, source_name, pref_code, not_dam_reason)
VALUES
  ('sokobaru-dam', '二又堰', '二又堰', '47',
   'Intake weir, not a dam: its 底原ダム管理システム page (cosmos.ne.jp/~sokobaru/00006001.html, 2026-09-28) lists 堰水位 / 責任放流量 / 取水量 / 洪水吐 / 土砂吐 and no storage; no 二又 row in the NDI master.'),
  ('sokobaru-dam', '平喜名堰', '平喜名堰', '47',
   'Intake weir, not a dam: its 底原ダム管理システム page (cosmos.ne.jp/~sokobaru/00007001.html, 2026-09-28) lists 堰水位 / 責任放流量 / 取水量 / 洪水吐 / 土砂吐 and no storage; no 平喜名 row in the NDI master.')
ON CONFLICT (source_id, source_external_id) DO UPDATE
  SET not_dam_reason = EXCLUDED.not_dam_reason;
