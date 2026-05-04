-- Realtime ingest is no longer in scope (the service publishes historical
-- data only). Drop the kasenbosai / suimon rows from source_priorities so
-- the /sources UI doesn't list ingest sources we never run.
-- Idempotent: deletes are no-ops if the rows are already gone.
DELETE FROM source_priorities WHERE source_id = 'kasenbosai';
DELETE FROM source_priorities WHERE source_id = 'suimon';
