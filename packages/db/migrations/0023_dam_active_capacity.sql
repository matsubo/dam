-- 利水容量 (active conservation storage) — distinct from 有効貯水容量 and
-- 洪水調節容量. Backfilled from Damnet's capacity_active (in 千 m³) by
-- apps/web/bin/match_damnet.ts.
ALTER TABLE dams ADD COLUMN IF NOT EXISTS active_capacity_m3 NUMERIC(18,2);
