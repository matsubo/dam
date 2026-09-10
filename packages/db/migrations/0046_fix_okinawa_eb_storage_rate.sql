-- 0046: okinawa-eb stored storage_rate as a percentage instead of a 0–1 fraction.
--
-- 沖縄県企業局's dam-youryou.csv publishes the rate on row 2 as "95.1" (%).
-- ingest_okinawa_eb.ts wrote that straight into observations.storage_rate, so
-- the API returned storageRate = 95.1 (i.e. 9,510 %) for 山城ダム. Reported in
-- issue #38 §2-1; same bug class as 0030_fix_jwa_chiba_storage_rate.sql.
--
-- Affects both dams this source covers (倉敷 and 山城) across their whole
-- history. The threshold is 1.5 rather than 1 because rows where the adapter
-- emitted NULL were filled by the 0036 trigger with volume/active_capacity,
-- already clipped to 0–1.5 — those must not be divided again.
UPDATE observations
SET storage_rate = storage_rate / 100
WHERE source_id = 'okinawa-eb'
  AND storage_rate > 1.5;
