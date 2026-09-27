-- 0066: move ehime-bousai 鹿野川 and tochigi-bodik 中禅寺 stamps to the （再） (#79).
--
-- Both tasks matched by a stem that drops （元）/（再） and broke ties by the
-- lowest dam id, so each stamped the （元） row. They now keep an existing
-- stamp (stampedMaster), so the stamps already written would pin them to the
-- old structure for good; this moves them to the completed （再）. The value is
-- copied, not restated: prod's keys are whatever the task wrote. Keyed by NDI
-- id; a no-op where the （元） carries no stamp (fresh DB, or already moved).
--
-- Evidence, prod pages fetched 2026-09-27:
--
--   ehime-bousai  鹿野川  2235 （元） → 2234 （再, 2018）
--     https://dam.teraren.com/sources/ehime-bousai lists 鹿野川（元）
--     (/dams/kanogawa-38-2); that page shows 竣工 1953〜1958, latest
--     ehime-bousai 36.8 % computed against the （元）'s 2,980 万 m³.
--     /dams/kanogawa-38 is 鹿野川（再）, 竣工 1953〜2018, 有効 3,620 万 m³.
--   tochigi-bodik 中禅寺  633 （元） → 634 （再, 1998）
--     https://dam.teraren.com/sources/tochigi-bodik lists 中禅寺（元）
--     (/dams/chuuzenji-09, 竣工 1953〜1959). /dams/chuuzenji-09-2 is
--     中禅寺（再）, 竣工 1991〜1998, "まだ観測値がありません".
--     The tochigi-bodik task is adopted separately; this is data only.
--
-- Past observations move with the `observations:rebind` task, not here.

CREATE TEMP TABLE station_move (source text, from_ndi text, to_ndi text);

INSERT INTO station_move VALUES
  ('ehime-bousai',  '2235', '2234'),
  ('tochigi-bodik', '633',  '634');

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
