-- Watersheds (1st-class & 2nd-class river systems)
CREATE TABLE watersheds (
  id BIGSERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,                       -- NLNI watershed code
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  name_kana TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('first', 'second', 'other')),
  boundary GEOGRAPHY(MULTIPOLYGON, 4326) NOT NULL,
  area_km2 DOUBLE PRECISION,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Rivers
CREATE TABLE rivers (
  id BIGSERIAL PRIMARY KEY,
  watershed_id BIGINT NOT NULL REFERENCES watersheds(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('main', 'tributary', 'other')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (watershed_id, name)
);

-- Dams (master)
CREATE TABLE dams (
  id BIGSERIAL PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  name_kana TEXT,
  pref_code CHAR(2) NOT NULL,
  river_id BIGINT REFERENCES rivers(id) ON DELETE SET NULL,
  watershed_id BIGINT REFERENCES watersheds(id) ON DELETE SET NULL,
  manager TEXT,
  type TEXT,
  height_m NUMERIC(8,2),
  total_capacity_m3 NUMERIC(18,2),
  effective_capacity_m3 NUMERIC(18,2),
  flood_capacity_m3 NUMERIC(18,2),
  completed_year INT,
  location GEOGRAPHY(POINT, 4326) NOT NULL,
  external_ids JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Match review queue (low-confidence reconciliation)
CREATE TABLE match_review (
  id BIGSERIAL PRIMARY KEY,
  source_id TEXT NOT NULL,                         -- e.g. 'damnet'
  source_external_id TEXT NOT NULL,                -- the source's record id
  candidate_dam_ids BIGINT[] NOT NULL,
  best_dam_id BIGINT REFERENCES dams(id) ON DELETE SET NULL,
  confidence NUMERIC(5,4) NOT NULL,
  payload JSONB NOT NULL,                          -- the source's parsed record
  resolved_dam_id BIGINT REFERENCES dams(id) ON DELETE SET NULL,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_id, source_external_id)
);

-- Touch updated_at automatically
CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_watersheds_updated  BEFORE UPDATE ON watersheds  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_rivers_updated      BEFORE UPDATE ON rivers      FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_dams_updated        BEFORE UPDATE ON dams        FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
