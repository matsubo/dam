-- Drop the retrying ingest jobs the cron piled up before ingest lines got
-- `?jobKey=<task>`.
--
-- Each ingest tick used to add a keyless job allowed 25 attempts, retried
-- after exp(min(attempts, 10)) s, so ~4 days of backoff; the next tick never
-- replaced it. kyoto-bousai has timed out since 2026-09-24, which left one
-- job per hour retrying about every 6 h. Once the worker with the new crontab
-- runs, every tick replaces its task's keyed job (one per source), so the old
-- keyless retries only repeat work a newer run already does.
--
-- Run AFTER the worker deploy: before it, the pile regrows one job per hour.
-- Removes unlocked ingest:* jobs without a key that have failed at least once
-- (still retrying or exhausted). Keyed jobs, locked (running) jobs and every
-- non-ingest task are left alone. Goes through graphile_worker.complete_jobs,
-- graphile-worker's function for removing jobs. Idempotent: a re-run finds
-- nothing.
--
-- Prod dry-run (2026-09-27 23:26 UTC), same predicate:
--   ingest:kyoto-bousai  86 jobs, attempts 8–23 of 25, _cron.ts 09-24 08:42
--                        to 09-27 22:42 UTC, last_error "The operation timed out."
--   no other ingest task; 90 jobs in the queue in total.
--
-- Run: psql -U dam -d dam -v ON_ERROR_STOP=1 -f 2026-09-28_prune_ingest_retries.sql
-- The final SELECT should report 0.

BEGIN;

SELECT count(*) AS pruned
FROM graphile_worker.complete_jobs(ARRAY(
  SELECT j.id
  FROM graphile_worker._private_jobs j
  JOIN graphile_worker._private_tasks t ON t.id = j.task_id
  WHERE t.identifier LIKE 'ingest:%'
    AND j.key IS NULL
    AND j.locked_at IS NULL
    AND j.attempts > 0
));

SELECT count(*) AS remaining
FROM graphile_worker._private_jobs j
JOIN graphile_worker._private_tasks t ON t.id = j.task_id
WHERE t.identifier LIKE 'ingest:%'
  AND j.key IS NULL
  AND j.locked_at IS NULL
  AND j.attempts > 0;

COMMIT;
