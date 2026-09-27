-- One-off (prod, after feat/n4-mie-nara-wakayama is deployed): move 中里's
-- JWA readings off the 長野 stub 0031 invented, drop the stub, and clear what
-- the old jwa-chubu parser got wrong.
--
-- Order:
--   1. Deploy. The web boot runs migrations; check 0083 is recorded:
--        SELECT applied_at FROM _migrations
--        WHERE name = '0083_drop_fabricated_nakazato_nagano.sql';
--      (0083 itself deletes nothing on prod: the stub still has observations.)
--   2. Run this file once, as a single transaction:
--        psql -U dam -d dam -v ON_ERROR_STOP=1 -1 -f 2026-09-28_nakazato_stub.sql
--   3. SELECT graphile_worker.add_job('ingest:jwa-chubu');
--      rewrites the report currently on the page with the fixed parser.
--   4. SELECT graphile_worker.add_job('aggregates:refresh');
--      obs_daily / obs_monthly still hold the stub's and the wrong volumes.
-- Not a migration: it rewrites ~2,900 observations, most in compressed
-- chunks, which does not belong in the migrate path (see 0045).
--
-- Why. jwa-chubu's 中里ダム and jwa-kiso-rt's 中里貯水池 are 三重用水's
-- reservoir in いなべ市, NDI 940 (evidence in 0083's header). Both tasks bound
-- them to 'nakazato-20' (no NDI id), which holds, on prod 2026-09-27:
--   jwa-kiso-rt  2,598 rows — 中里貯水池's own readings: moved to NDI 940,
--                keeping NDI 940's copy where both exist (written after the fix)
--   jwa-chubu       67 rows — read from the 「三重用水 (中里ダム・調整池合計)」
--                block (rate 30.0 % = the 合計, volume 0): deleted
-- observations:rebind cannot do this; it is keyed by NDI and the stub has none.
--
-- The old jwa-chubu parser also took the first number after the first
-- '貯水量' on the page for every dam: each volume is the "0" of
-- 「貯水量<午前0時>」, or 徳山's printed 有効貯水量 capacity (257,400 千m³) —
-- 221 more non-null volumes on prod, all wrong. And its rate was the page's
-- 利水 rate, which is 有効-based only for 牧尾 and 中里: 阿木川 / 味噌川 / 岩屋
-- divide by a 利水 pool inside a larger 有効, 徳山 by a seasonal pool. The fixed
-- task stores no such rate (storedStorage), so the old ones go too. Only rows
-- first written before 0083 was applied are touched.

SET LOCAL timescaledb.max_tuples_decompressed_per_dml_transaction = 0;

CREATE TEMP TABLE nk ON COMMIT DROP AS
SELECT (SELECT id FROM dams WHERE slug = 'nakazato-20' AND NOT (external_ids ? 'ndi')) AS stub,
       (SELECT id FROM dams WHERE external_ids->>'ndi' = '940') AS mie,
       (SELECT applied_at FROM _migrations
        WHERE name = '0083_drop_fabricated_nakazato_nagano.sql') AS deployed_at;

DO $$
BEGIN
  IF (SELECT deployed_at FROM nk) IS NULL THEN
    RAISE EXCEPTION '0083 is not applied yet; deploy first';
  END IF;
END $$;

DELETE FROM observations o USING nk
WHERE o.dam_id = nk.stub AND o.source_id = 'jwa-chubu';

DELETE FROM observations f USING observations t, nk
WHERE f.dam_id = nk.stub AND t.dam_id = nk.mie
  AND f.source_id = 'jwa-kiso-rt' AND t.source_id = 'jwa-kiso-rt'
  AND t.observed_at = f.observed_at;

-- A rate the trigger derived (bit 32) used the stub's (absent) capacity;
-- clear it so the BEFORE UPDATE trigger derives it against NDI 940.
UPDATE observations o SET
  dam_id       = nk.mie,
  storage_rate = CASE WHEN (o.quality_flag & 32) = 32 THEN NULL ELSE o.storage_rate END,
  quality_flag = o.quality_flag & ~32
FROM nk
WHERE o.dam_id = nk.stub AND o.source_id = 'jwa-kiso-rt';

DELETE FROM dams d USING nk
WHERE d.id = nk.stub
  AND NOT EXISTS (SELECT 1 FROM observations o WHERE o.dam_id = d.id);

UPDATE observations o SET
  storage_volume_m3 = NULL,
  storage_rate = CASE
    WHEN d.external_ids->>'jwa-chubu' IN ('牧尾ダム', '中里ダム') THEN o.storage_rate
  END
FROM nk, dams d
WHERE d.id = o.dam_id
  AND o.source_id = 'jwa-chubu'
  AND o.created_at < nk.deployed_at
  AND (o.storage_volume_m3 IS NOT NULL
       OR (o.storage_rate IS NOT NULL
           AND d.external_ids->>'jwa-chubu' NOT IN ('牧尾ダム', '中里ダム')));
