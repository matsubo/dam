-- The provider's own stamp on the newest value it publishes for a row.
--
-- `classifyDamCoverage` calls a dam `covered` when an observation landed in
-- the last 30 days. For a monthly or irregular provider that window is
-- shorter than the provider's own cadence: 佐渡 農業用ダム still prints its
-- 8月15日 survey, 兵庫県「県内の水源の状況」 its 9月1日 one, 長崎市 its 8月24日
-- table on 2026-10-02. We hold every one of those values, yet the 30-day
-- window filed the dams under `published_not_ingested` — 「取り込み側の不具合」,
-- which is false: there is nothing newer to take.
--
-- So the task that reads the row says which date the provider printed:
--   a timestamp  the observed_at the task stores for the row's current value
--   NULL         not told (the default for every task that does not set it)
-- Each scan overwrites it. A dam is also `covered` when a source listing it
-- was scanned within 7 days, gave this stamp, and we hold a non-empty
-- observation from that source at or after it. A value the task parsed the
-- date for but failed to store keeps the dam `published_not_ingested`.
ALTER TABLE source_universe ADD COLUMN published_at TIMESTAMPTZ;

COMMENT ON COLUMN source_universe.published_at IS
  'observed_at of the newest value the upstream published for this row on the last scan that could tell; NULL = not told.';
