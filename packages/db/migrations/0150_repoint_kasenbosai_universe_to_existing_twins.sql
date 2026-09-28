-- 0150: point kasenbosai's 松川 and 長柄 universe rows at the （元） (#79).
--
-- 0071 moved both stations' kasenbosai stamps from the unfinished （再） to the
-- （元）, but source_universe.resolved_dam_id is only refreshed by
-- match:kasenbosai, which runs weekly and last ran (2026-09-27 12:37 UTC)
-- between 0068 and 0071. So on prod the rows still resolve to the （再）,
-- which has no stamp and never gets a kasenbosai observation, and /coverage
-- files 松川（再） and 長柄（再） under 取り込み不具合 while the （元） take the
-- readings. recordUniverse never downgrades a resolved id to NULL, so a sweep
-- that misses a prefecture file would keep the stale id for another week.
--
-- Evidence (prod, 2026-09-28 00:45 UTC): 2183100700010 resolves to 松川（再）
-- (NDI 799) while NDI 800 carries the stamp; 0947300700013 resolves to
-- 長柄（再） (NDI 2155) while NDI 2156 carries it. A fresh match:kasenbosai
-- sweep on the dev database binds both stations to the （元）.
--
-- Keyed by NDI and station id. A row moves only while it still points at the
-- （再） and the （元） holds that station's stamp, so this is idempotent, a
-- no-op once the weekly sweep has run, and a no-op on a fresh database.

UPDATE source_universe su
SET resolved_dam_id = moto.id
FROM (VALUES
  ('2183100700010', '799',  '800'),  -- 松川ダム (長野)
  ('0947300700013', '2155', '2156')  -- 長柄ダム (香川)
) AS m(station, from_ndi, to_ndi)
JOIN dams sai  ON sai.external_ids->>'ndi' = m.from_ndi
JOIN dams moto ON moto.external_ids->>'ndi' = m.to_ndi
WHERE su.source_id = 'kasenbosai'
  AND su.source_external_id = m.station
  AND su.resolved_dam_id = sai.id
  AND moto.external_ids->>'kasenbosai' = m.station;
