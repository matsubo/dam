-- 0036: trigger to compute storage_rate from storage_volume_m3 / active_capacity_m3
--
-- Many ingest sources report storage volume but not storage rate.  When a dam
-- has active_capacity_m3 in the master we can derive the rate automatically.
-- This unlocks coverage for ~15 prefecture sources (Nagano, Gunma, Iwate,
-- Hyogo, Tochigi, Ibaraki, Kyoto, Wakayama, Saitama, Gifu, Fukuoka, etc.)
-- that provide 貯水量 but set storageRate = null.
--
-- The function fires BEFORE INSERT OR UPDATE so the computed value is stored
-- inline — no separate UPDATE pass needed.  Rows that already carry an
-- explicit storage_rate are left unchanged (IF NEW.storage_rate IS NULL guard).
--
-- Denominator: active_capacity_m3 (利水容量), consistent with the 利水容量貯水率
-- that kasenbosai stores.  Capped at 1.5 (150 %) to handle flood overflow.

CREATE OR REPLACE FUNCTION fill_storage_rate_from_volume()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.storage_rate IS NULL AND NEW.storage_volume_m3 IS NOT NULL THEN
    SELECT
      CASE
        WHEN d.active_capacity_m3 IS NOT NULL AND d.active_capacity_m3 > 0
          THEN GREATEST(0, LEAST(1.5, NEW.storage_volume_m3 / d.active_capacity_m3))
        ELSE NULL
      END
    INTO NEW.storage_rate
    FROM dams d
    WHERE d.id = NEW.dam_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER observations_fill_storage_rate
  BEFORE INSERT OR UPDATE ON observations
  FOR EACH ROW
  EXECUTE FUNCTION fill_storage_rate_from_volume();
