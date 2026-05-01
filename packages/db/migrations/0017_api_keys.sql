CREATE TABLE api_keys (
  id              BIGSERIAL PRIMARY KEY,
  prefix          CHAR(8) NOT NULL UNIQUE,           -- public part shown to user
  hash            BYTEA NOT NULL,                    -- sha256 of full key (prefix + secret)
  email           TEXT NOT NULL,
  label           TEXT,
  tier            TEXT NOT NULL DEFAULT 'free'
                   CHECK (tier IN ('free','partner','admin')),
  rate_per_min    INT NOT NULL DEFAULT 60,
  rate_per_day    INT NOT NULL DEFAULT 10000,
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at    TIMESTAMPTZ,
  revoked_at      TIMESTAMPTZ
);

CREATE TABLE api_key_usage (
  api_key_id      BIGINT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  bucket_minute   TIMESTAMPTZ NOT NULL,              -- truncated to the minute
  count           INT NOT NULL,
  PRIMARY KEY (api_key_id, bucket_minute)
);

CREATE INDEX api_key_usage_bucket ON api_key_usage (bucket_minute);
