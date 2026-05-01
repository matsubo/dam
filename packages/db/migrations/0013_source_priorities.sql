CREATE TABLE source_priorities (
  source_id   TEXT PRIMARY KEY,
  priority    INT NOT NULL,                  -- higher wins on tie
  description TEXT,
  active      BOOLEAN NOT NULL DEFAULT TRUE
);

INSERT INTO source_priorities (source_id, priority, description) VALUES
  ('kasenbosai', 100, '川の防災情報 (real-time MLIT)'),
  ('suimon',      90, '水文水質DB (historical MLIT)'),
  ('damnet',      50, 'ダム便覧 (master attributes)'),
  ('ndi',         80, '国土数値情報 (master location/code)')
ON CONFLICT (source_id) DO NOTHING;
