-- Watershed boundary lookup (point-in-polygon)
CREATE INDEX watersheds_boundary_gist ON watersheds USING GIST (boundary);

-- Dam spatial lookup (radius searches)
CREATE INDEX dams_location_gist ON dams USING GIST (location);

-- Trigram for name fuzzy match in reconciliation
CREATE INDEX dams_name_trgm    ON dams    USING GIN (name gin_trgm_ops);
CREATE INDEX dams_name_kana_trgm ON dams  USING GIN (name_kana gin_trgm_ops);

-- Common filters
CREATE INDEX dams_pref_code   ON dams (pref_code);
CREATE INDEX dams_watershed   ON dams (watershed_id);
CREATE INDEX dams_manager     ON dams (manager);
