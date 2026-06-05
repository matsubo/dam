-- 0028_add_amagase_dam.sql
--
-- 天ヶ瀬ダム (Amagase Dam) was missing from the master.
-- Location: Uji-city, Kyoto (宇治市菟道赤川谷); on the 宇治川.
-- Managed by 国土交通省 近畿地方整備局; completed 1964; arch dam, H=73m.
-- The existing entry (id=11136) with the same name is in Saga (pref_code=41)
-- and represents a different dam.

INSERT INTO dams (slug, name, pref_code, completed_year, manager, height_m, location, external_ids)
VALUES (
  'amagase-26',
  '天ヶ瀬',
  '26',
  1964,
  '国土交通省',
  73,
  ST_SetSRID(ST_MakePoint(135.8016, 34.8758), 4326),
  '{}'
)
ON CONFLICT (slug) DO NOTHING;
