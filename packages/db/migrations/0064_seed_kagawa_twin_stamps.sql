-- 0064: pin kagawa-bousai's 長柄 and 五名 to the rows they are bound to today.
--
-- Issue #79. kagawa-bousai never stamped a station: it matched by a name
-- stem that drops （元）/（再） and broke ties by the lowest dam id, which put
-- 長柄ダム on 長柄（再） and 五名ダム on 五名（元）. The task now binds
-- stamp-first and otherwise prefers the completed （再）, else the （元）
-- (packages/core/src/dam_binding.ts). 0056 cleared 長柄（再）'s completion
-- year (ダム便覧 has none), so without a stamp the first run would move 長柄
-- to its （元）. #79 leaves 長柄 and 五名 where they are until the operator's
-- current structure is confirmed; seeding the stamp the task would write
-- keeps both there. 内海 needs no seed: its （再） (2013) wins either way.
--
-- Keys are the feed's station_name, byte-identical to what the task stamps.
-- Keyed by NDI id. Only sets a stamp on a row that has none, and only while
-- no other row carries the key, so a binding the task has already made is
-- left alone and a fresh database is a no-op.
--
--   長柄ダム  NDI 2155  長柄（再）
--   五名ダム  NDI 2130  五名（元）

UPDATE dams d
SET external_ids = d.external_ids || jsonb_build_object('kagawa-bousai', s.station)
FROM (VALUES
  ('2155', '長柄ダム'),
  ('2130', '五名ダム')
) AS s (ndi, station)
WHERE d.external_ids->>'ndi' = s.ndi
  AND d.pref_code = '37'
  AND NOT d.external_ids ? 'kagawa-bousai'
  AND NOT EXISTS (
    SELECT 1 FROM dams o WHERE o.external_ids->>'kagawa-bousai' = s.station
  );
