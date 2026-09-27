-- 0067: take the kasenbosai stamp off one twin where both carry it (#79).
--
-- match_kasenbosai scored （元） and （再） alike (the name stem drops the
-- marker) and only ever added stamps, so a station could end up on both rows.
-- The matcher now keeps a twin that alone holds the station's stamp, and
-- settles the rest with preferMaster (completed （再）, else （元）). Its next run
-- fixes every both-stamped pair it can date by that rule.
--
-- It cannot date these four: their （再） has no ダム便覧 completion year (0056
-- cleared it), so preferMaster would pick the （元） and move a station the
-- prefectural feed puts on the （再）. Keep the twin the prefectural feed is
-- pinned to — 新保川（再） (niigata-bousai), 松川（再） (nagano-kasen),
-- 長柄（再） (kagawa-bousai) and 五名（元） (kagawa-bousai) — and drop the key
-- from the other, only where both rows carry the SAME key. A stamp on just one
-- twin is left alone: the matcher now keeps it there.
--
-- Evidence (public pages, 2026-09-27): only 長柄 shows kasenbosai on both
-- nagara-37 （元） and nagara-37-2 （再）. The 新保川 and 松川 （再） pages
-- display the prefectural source, which a page cannot tell apart from a
-- hidden second kasenbosai stamp, so they are covered too; the WHERE makes
-- them a no-op otherwise. Keyed by NDI id. Idempotent.
--
-- Past kasenbosai observations on the dropped twin stay where they are; the
-- admin `observations:rebind` task moves history, not a boot-time migration.

UPDATE dams drop_row
SET external_ids = drop_row.external_ids - 'kasenbosai'
FROM (VALUES
  ('1081', '1082'), -- 新保川ダム: keep （再）, drop （元）
  ('799',  '800'),  -- 松川ダム:   keep （再）, drop （元）
  ('2155', '2156'), -- 長柄ダム:   keep （再）, drop （元）
  ('2130', '2128')  -- 五名ダム:   keep （元）, drop （再）
) AS pin(keep_ndi, drop_ndi)
JOIN dams keep_row ON keep_row.external_ids->>'ndi' = pin.keep_ndi
WHERE drop_row.external_ids->>'ndi' = pin.drop_ndi
  AND drop_row.external_ids->>'kasenbosai' = keep_row.external_ids->>'kasenbosai';
