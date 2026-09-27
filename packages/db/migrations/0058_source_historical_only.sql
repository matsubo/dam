-- Some providers are a one-off dump, not a feed.
--
-- `classifyDamCoverage`'s gate asks whether every observation-producing
-- provider has recorded the list it publishes. Two sources can never answer
-- that question, because there is no recurring scan to record:
--
--   mudam            NILIM ダム諸量 DB — a historical dump. 928,847 observations,
--                    newest 2024-12-30. Confirmed values run one to two years
--                    behind by design.
--   kagoshima-bodik  backfill-only; it has no crontab entry at all. 153,515
--                    observations, newest 2009-08-07.
--
-- Left in the gate they hold it open forever, and while it is open no dam
-- anywhere can be classified `not_published` — /coverage reports 提供元なし = 0
-- and files every uncovered dam under 未調査, which is the whole feature
-- failing to answer.
--
-- The tempting fix — record their dumps as a universe — is worse: their ~500
-- dams would become `published_not_ingested`, which the page states as
-- 「提供元が公開済み・紐付けも済み。取り込み側の不具合」. That is a false
-- accusation for a dump that is years behind on purpose, and coverage already
-- reports these dams honestly under its 歴史データ含む metric.
--
-- `universe_enumerable = FALSE` (0044) was the other candidate and is not the
-- same claim: 鹿児島県防災 publishes a list we cannot enumerate, while these two
-- publish a list we simply have no ongoing scan for. Keeping them apart keeps
-- both caveats readable in `coverageSummary`.
ALTER TABLE source_priorities
  ADD COLUMN historical_only BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN source_priorities.historical_only IS
  'TRUE when the provider is a one-off historical dump or backfill-only source with no recurring scan, so it is excluded from the source_universe gate.';

UPDATE source_priorities SET historical_only = TRUE
  WHERE source_id IN ('mudam', 'kagoshima-bodik');
