-- Additional master attributes from the Damnet capture. All nullable; existing
-- 2,749 rows will fill in via match_damnet.ts (and the monthly worker cron).
-- Units mirror Damnet's source values:
--   crest_length      : metres
--   embankment_volume : 千 m³ → stored as m³ (× 1_000 at write time)
--   watershed_area    : km²
--   reservoir_area    : km² (Damnet uses km² consistently for reservoirs)
--   purposes          : Japanese ダム用途コード string, e.g. "FNAWP"
--                       (F=洪水調節 N=不特定 A=農業 W=上水 I=工業 P=発電 S=消雪 R=レク)
ALTER TABLE dams ADD COLUMN IF NOT EXISTS construction_start_year SMALLINT;
ALTER TABLE dams ADD COLUMN IF NOT EXISTS purposes TEXT;
ALTER TABLE dams ADD COLUMN IF NOT EXISTS crest_length_m NUMERIC(10,2);
ALTER TABLE dams ADD COLUMN IF NOT EXISTS embankment_volume_m3 NUMERIC(18,2);
ALTER TABLE dams ADD COLUMN IF NOT EXISTS watershed_area_km2 NUMERIC(10,3);
ALTER TABLE dams ADD COLUMN IF NOT EXISTS reservoir_area_km2 NUMERIC(10,4);
ALTER TABLE dams ADD COLUMN IF NOT EXISTS left_bank_location TEXT;
ALTER TABLE dams ADD COLUMN IF NOT EXISTS main_contractor TEXT;
ALTER TABLE dams ADD COLUMN IF NOT EXISTS redevelopment_status TEXT;
