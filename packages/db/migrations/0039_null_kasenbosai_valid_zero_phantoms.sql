-- A second class of kasenbosai phantom zero, distinct from 0038's Ccd=160 case.
--
-- Some dams (e.g. 大峠ダム, 島根) publish water level + flow but report
-- storCap=0 with a "valid" quality code (Ccd=0) while BOTH rate fields are
-- missing (Ccd=160). The ingester used to store that as 0 m³, and trigger 0036
-- then derived a phantom 0.0% storage rate. These dams simply don't publish a
-- reservoir volume — the 0 is a placeholder, not an empty reservoir.
--
-- ingest_kasenbosai_v2.ts now drops storCap=0 when no rate corroborates it, so
-- no new phantom rows arrive. This nulls the accumulated ones (both volume and
-- the trigger-computed rate).
--
-- Guard: only dams whose entire kasenbosai storage series is zero. A genuinely
-- empty 穴あき flood-control dam fills during floods, so its series varies and
-- is left untouched.
UPDATE observations o
SET storage_volume_m3 = NULL,
    storage_rate      = NULL
WHERE o.source_id = 'kasenbosai'
  AND o.storage_volume_m3 = 0
  AND o.dam_id IN (
    SELECT dam_id
    FROM observations
    WHERE source_id = 'kasenbosai'
      AND storage_volume_m3 IS NOT NULL
    GROUP BY dam_id
    HAVING MAX(storage_volume_m3) = 0
  );
