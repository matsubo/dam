-- 0065: pin nagano-kasen's 松川ダム station to 松川（再） (#79).
--
-- ingest:nagano-kasen never wrote a stamp; it bound 松川ダム (station
-- 2001_7_1, /dps/map/map.html) to 松川（再） only because that row has the
-- lower id. #79 makes the task stamp-first with the shared tie-break, which
-- prefers a （再） only once its completion year is on record. 0056 cleared
-- 松川（再）'s year (ダム便覧 has none), so an unstamped first run would move
-- the station — and its capacity denominator — to 松川（元） (NDI 800).
--
-- #78/#79 leave 松川 where it is until the operator's current structure is
-- confirmed. Seed the key the task now writes (the station id, same as its
-- source_universe externalId) on 松川（再） so stamp-first keeps it there.
-- Skipped if the row already carries a nagano-kasen stamp or any row
-- already has this key, so a later deliberate move is never undone.
UPDATE dams
SET external_ids = external_ids || jsonb_build_object('nagano-kasen', '2001_7_1')
WHERE external_ids->>'ndi' = '799' -- 松川ダム（再）
  AND pref_code = '20'
  AND NOT (external_ids ? 'nagano-kasen')
  AND NOT EXISTS (
    SELECT 1 FROM dams o WHERE o.external_ids->>'nagano-kasen' = '2001_7_1'
  );
