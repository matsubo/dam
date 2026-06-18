-- 0032: add 棚野ダム (Tokushima pref=36, tokushima-bousai source)
-- 那賀郡那賀町, 那賀川水系 坂州木頭川, 完成1973年, 徳島県管理 39.5m
INSERT INTO dams (slug, name, pref_code, completed_year, manager, height_m, location, external_ids)
VALUES ('tanano-36', '棚野', '36', 1973, '徳島県', 39.5,
        ST_SetSRID(ST_MakePoint(134.062, 33.820), 4326),
        '{}'::jsonb)
ON CONFLICT (slug) DO NOTHING;
