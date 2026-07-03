-- kasenbosai (川の防災情報) reports missing 貯水量/貯水率 as value 0 with a
-- per-field quality code Ccd=160. The ingester ignored the code and stored
-- those as real observations, so ~12 dams showed a phantom 0.0% storage rate
-- on the drought list (e.g. 呑吐ダム at "0 m³" while passing 2.8 m³/s).
--
-- The ingester now honors Ccd (ingest_kasenbosai_v2.ts), so no new phantom
-- rows arrive. This cleans up the existing ones.
--
-- Targeting: only dams whose kasenbosai storage series is ALL-zero. A dam
-- that never reports storage has max(volume) = 0 across every row, while a
-- genuinely empty flood-control dam (穴あきダム) fills during floods and thus
-- shows variance. This avoids wiping real "reservoir is empty" readings.
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
