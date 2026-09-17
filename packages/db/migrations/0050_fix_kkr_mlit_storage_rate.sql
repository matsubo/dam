-- 0050: kkr-mlit-dam stored storage_rate as a percentage instead of a 0–1
-- fraction.
--
-- Issue #46. 近畿地方整備局's dam.json publishes 貯水率 as a percent string
-- ("89.3"); ingest_kkr_mlit.ts wrote it straight into observations.storage_rate,
-- so the API returned storageRate = 89.3 — i.e. 8,930 % — for all 12 dams this
-- source covers, across their whole history. Same bug class as
-- 0030_fix_jwa_chiba_storage_rate.sql and 0046_fix_okinawa_eb_storage_rate.sql.
--
-- It also broke the ingest outright. storage_rate is NUMERIC(6,4), which tops
-- out at 99.9999, so the first dam to report a full reservoir overflowed the
-- column and failed the task. 一庫ダム published exactly 100.0 on 2026-09-14 and
-- every 近畿 dam has been stale since — the job was burning through its 25
-- retries with `numeric field overflow`.
--
-- Found because PR #43 repaired /api/v1/admin/jobs, whose job queries had been
-- silently returning [] (task_identifier does not exist on _private_jobs). This
-- failure was the first thing the working endpoint showed.
--
-- The threshold is 1.5 rather than 1 for the same reason 0046 used it: rows
-- where the adapter emitted NULL were filled by the 0036 trigger with
-- volume/active_capacity, already bounded to 0–1.5, and those must not be
-- divided again. kkr-mlit-dam writes storage_volume_m3 NULL, so in practice the
-- trigger never fired for it — the guard is belt and braces.

UPDATE observations
SET storage_rate = storage_rate / 100
WHERE source_id = 'kkr-mlit-dam'
  AND storage_rate > 1.5;

-- Anything left above 1.5 after the division was not a percentage we can
-- explain (a double-written row, or a reading the old code let through). NULL
-- it rather than publish it: the read path derives a rate from volume when one
-- is missing, and for this source there is no volume, so the dam simply shows
-- no rate until the next poll writes a good one.
UPDATE observations
SET storage_rate = NULL
WHERE source_id = 'kkr-mlit-dam'
  AND storage_rate > 1.5;
