-- Sea-level elevation per dam (m). Backfilled by bin/fetch_dam_elevation.ts
-- via GSI's public DEM API (国土地理院 標高API).
ALTER TABLE dams ADD COLUMN IF NOT EXISTS elevation_m REAL;
