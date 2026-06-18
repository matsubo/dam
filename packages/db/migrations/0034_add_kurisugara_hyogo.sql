-- 0034: add 栗柄ダム (Hyogo pref=28, hyogo-bodik source)
-- 丹波市青垣町, 加古川水系 栗柄川, 完成1961年, 兵庫県管理 40m
INSERT INTO dams (slug, name, pref_code, completed_year, manager, height_m, location, external_ids)
VALUES ('kurisugara-28', '栗柄', '28', 1961, '兵庫県', 40.0,
        ST_SetSRID(ST_MakePoint(135.072, 35.082), 4326),
        '{}'::jsonb)
ON CONFLICT (slug) DO NOTHING;
