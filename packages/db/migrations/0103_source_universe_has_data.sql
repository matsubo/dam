-- Whether a provider's published row actually carries a value.
--
-- `classifyDamCoverage` files every resolved-but-silent dam under
-- `published_not_ingested`, which /coverage states as 「取り込み側の不具合」.
-- For some of them that is false: 福島県 農林 lists 鉄山 / 坂下 as 調査対象外
-- and prints 鴻の巣 as a drained 0.0 %, and 福井県's 現況表 lists 滝波 with
-- "---" in every column. The provider publishes the dam and nothing else;
-- there is no ingestion bug to fix.
--
-- Inferring it ("never had an observation from that source") would also file
-- 岩堂沢 / 二ツ石 there, and those WERE an ingest bug. So the task that reads
-- the row says what it saw:
--   TRUE  the row carried a value we store
--   FALSE the provider itself marks the row empty (調査対象外, "---", a page
--         with no readings)
--   NULL  not known — the default for every task that does not tell, and for
--         a cell the parser could not read, which may be our own breakage.
-- A dam is `published_no_data` only when every active source listing it says
-- FALSE; one NULL keeps it an ingestion bug.
ALTER TABLE source_universe ADD COLUMN has_data BOOLEAN;

COMMENT ON COLUMN source_universe.has_data IS
  'Whether the upstream row carried a value on the last scan that could tell: TRUE = yes, FALSE = the provider marks it empty, NULL = unknown.';
