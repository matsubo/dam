-- 0056: move station stamps off the （元） twin / wrong namesake (#57).
--
-- Ingest tasks matched stations by a name stem that drops （元）/（再） and broke
-- ties by the lowest dam id, so these sources bound the old structure, or
-- (兵庫 長谷) the other same-name dam. Hidden until #54 gave each row its own
-- specs; now the wrong row's capacity divides the live volume.
--
-- The tasks now keep an existing stamp and prefer the completed （再） on a
-- tie (packages/core/src/dam_binding.ts). This moves the stamps they already
-- wrote, so stamp-first binding starts from the right row. The value is
-- copied, not restated — prod's keys (station names, ids) are whatever the
-- task wrote. Keyed by NDI id.
--
-- Pairs, from the census of live dam pages on 2026-09-26 crossed with the
-- ダム便覧 completion year of each （再）. Only pairs whose （再） completion is
-- on record are moved: a blank year means either "under construction"
-- (佐久間（再）) or "not recorded", so 新保川 / 松川 / 狭山池 / 長柄 / 五名 stay.
--
--   hyogo-bodik     菅生    1566 （元） → 1567 （再, 2010）
--   hyogo-bodik     長谷    1565 神河町 犬見川 → 1573 たつの市 長谷川
--                   (feed: 61 千m³ at 211 m; たつの 215 千m³, 神河 8,260 千m³)
--   niigata-bousai  笠堀    1014 → 1013 (2017)
--   shimane-bousai  美田    1700 → 1701 (2002)
--   fukuoka-bodik   曲渕    2458 → 2459 (1992)
--   nagasaki-kasen  萱瀬    2578 → 2579 (2000)
--   qsr-toukan-dam  下筌    2476 → 2477 (1986)
--
-- skr-hiji-dam (鹿野川) and qsr-turuta-dam (鶴田) write no stamp; the tie-break
-- alone moves them. Their past observations, and those of the pairs above,
-- are moved by the `observations:rebind` task, not here: it has to decompress
-- chunks, which does not belong in a boot-time migration.

-- The tie-break reads dams.completed_year, and the pre-#54 matcher copied the
-- （元）'s year onto its （再） (佐久間（再） showed 1956). master:refresh:damnet
-- cannot undo it: a blank ダム便覧 year keeps the existing value. Clear it for
-- the （再） rows whose ダム便覧 record has no completion year, so they read as
-- not (yet) completed — their （元） stays the current structure.
UPDATE dams SET completed_year = NULL
WHERE external_ids->>'ndi' IN (VALUES
  ('919'), -- 1136 新丸山ダム（再）
  ('2601'), -- 2603 浦上ダム（再）
  ('799'), -- 3082 松川ダム（再）
  ('1081'), -- 3115 新保川ダム（再）
  ('2128'), -- 3257 五名ダム（再）
  ('2155'), -- 3311 長柄ダム（再）
  ('785'), -- 3326 佐久間ダム（再）
  ('2022') -- 3605 木屋川ダム（再）
);

CREATE TEMP TABLE station_move (source text, from_ndi text, to_ndi text);

INSERT INTO station_move VALUES
  ('hyogo-bodik',    '1566', '1567'),
  ('hyogo-bodik',    '1565', '1573'),
  ('niigata-bousai', '1014', '1013'),
  ('shimane-bousai', '1700', '1701'),
  ('fukuoka-bodik',  '2458', '2459'),
  ('nagasaki-kasen', '2578', '2579'),
  ('qsr-toukan-dam', '2476', '2477');

UPDATE dams t
SET external_ids = t.external_ids || jsonb_build_object(m.source, f.external_ids->>m.source)
FROM station_move m
JOIN dams f ON f.external_ids->>'ndi' = m.from_ndi
WHERE t.external_ids->>'ndi' = m.to_ndi
  AND f.external_ids ? m.source;

UPDATE dams f
SET external_ids = f.external_ids - m.source
FROM station_move m
JOIN dams t ON t.external_ids->>'ndi' = m.to_ndi
WHERE f.external_ids->>'ndi' = m.from_ndi
  AND t.external_ids ? m.source;

DROP TABLE station_move;
