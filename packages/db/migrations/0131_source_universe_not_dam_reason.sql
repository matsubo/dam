-- Why a published station is not a master dam at all.
--
-- `coverageSummary().unmatchedStations` counts every active-source row with
-- `resolved_dam_id IS NULL` as linking backlog. Some of those rows can never
-- be linked because there is no dam to link them to: a 堰, a 調整池 that is
-- not in the NDI master, a combined row such as 呑吐・大川瀬, a station with no
-- dam behind it. Without a way to say so, they sit in the backlog forever.
--
-- NULL (the default) means "not examined": the row stays backlog. A non-NULL
-- value is a cited reason, written only by later migrations:
--
--   UPDATE source_universe SET not_dam_reason = '<cited reason>'
--   WHERE source_id = '<src>' AND source_external_id = '<key>'
--     AND resolved_dam_id IS NULL;
--
-- recordUniverse never writes this column, so the reason survives every scan.
-- A row that later resolves to a dam wins over its mark: every reader keys
-- "not a dam" on `resolved_dam_id IS NULL AND not_dam_reason IS NOT NULL`.
ALTER TABLE source_universe ADD COLUMN IF NOT EXISTS not_dam_reason TEXT;

COMMENT ON COLUMN source_universe.not_dam_reason IS
  'Cited reason this published station is not a master dam (堰, 調整池 outside the NDI master, combined row). NULL = backlog if unresolved. Set by migrations only; recordUniverse never touches it; ignored once resolved_dam_id is set.';
