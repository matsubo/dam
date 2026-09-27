-- 0088: bind 川の防災情報 station 2053900700165 (日指ダム) to 日指 (#79).
--
-- 日指ダム (九州農政局, 大分県宇佐市安心院町 / 杵築市山香町, NDI 2262) has no
-- recent observation from any source but the monthly 九州農政局/大分県 lists,
-- yet MLIT's 川の防災情報 catalogue publishes it at 10-minute cadence under
-- the same office (ofc_cd 20539, 九州農政局) as 大蘇/日出生/輝北/切原…, all
-- of which ingest:kasenbosai already reads. match:kasenbosai cannot link it
-- because MLIT's entry carries two errors at once (prod source_universe and
-- match_review id 324, 2026-09-27):
--
--   station   33.4366667 N 131.3013889 E, filed under kbPrefCd 4101 (佐賀)
--   master    33.4371170 N 131.4328251 E, pref 44 — ダム便覧 2764 gives
--             33°26'14" N 131°25'59" E, i.e. the master is right
--
-- 12.2 km apart puts the master outside the matcher's 5 km candidate query,
-- and the 佐賀 filing makes an exact name score as a cross-prefecture reject
-- anyway (match_review: "cross-pref-reject (44 vs 41)" against 竜王池/香下).
-- The name is unique nationwide (no other 日指 in the master or the catalogue)
-- and 131.30 E lies inside 大分, so both are MLIT typos, not a different dam.
--
-- Seed the stamp ingest:kasenbosai reads (the 13-digit obs_fcd). Skipped if the
-- row already carries a kasenbosai stamp or any row already holds this key, so
-- a later deliberate move is never undone; match:kasenbosai only rewrites a
-- stamp when it binds the station elsewhere, which it cannot do here.
UPDATE dams
SET external_ids = external_ids || jsonb_build_object('kasenbosai', '2053900700165')
WHERE external_ids->>'ndi' = '2262' -- 日指ダム
  AND pref_code = '44'
  AND NOT (external_ids ? 'kasenbosai')
  AND NOT EXISTS (
    SELECT 1 FROM dams o WHERE o.external_ids->>'kasenbosai' = '2053900700165'
  );

-- The weekly match run re-records this station with resolved_dam_id NULL, and
-- recordUniverse keeps an existing id over a NULL (COALESCE), so resolving it
-- once here is what stops /coverage counting it as unlinked backlog.
UPDATE source_universe su
SET resolved_dam_id = d.id
FROM dams d
WHERE su.source_id = 'kasenbosai'
  AND su.source_external_id = '2053900700165'
  AND su.resolved_dam_id IS NULL
  AND d.external_ids->>'kasenbosai' = '2053900700165';

-- Close the human-review item the matcher staged for it.
UPDATE match_review mr
SET resolved_dam_id = d.id,
    resolved_at     = NOW()
FROM dams d
WHERE mr.source_id = 'kasenbosai'
  AND mr.source_external_id = '2053900700165'
  AND mr.resolved_dam_id IS NULL
  AND d.external_ids->>'kasenbosai' = '2053900700165';
