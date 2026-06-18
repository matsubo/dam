-- 0033: add 竜門ダム (Fukuoka pref=40, qsr-ryumon-dam source)
-- 朝倉市, 佐田川水系, 完成1971年, 国土交通省 九州地方整備局管理 61m
-- Separate dam from ryuumon-41 (Saga pref=41).
INSERT INTO dams (slug, name, pref_code, completed_year, manager, height_m, location, external_ids)
VALUES ('ryumon-40', '竜門', '40', 1971, '国土交通省', 61.0,
        ST_SetSRID(ST_MakePoint(130.730, 33.462), 4326),
        '{}'::jsonb)
ON CONFLICT (slug) DO NOTHING;
