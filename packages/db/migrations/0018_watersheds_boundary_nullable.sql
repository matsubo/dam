ALTER TABLE watersheds ALTER COLUMN boundary DROP NOT NULL;
COMMENT ON COLUMN watersheds.boundary IS
  'NULL until the W07 mesh-tile merge has produced a polygon for this watershed.';
