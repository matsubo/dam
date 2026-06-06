-- 0029_add_kechi_dam.sql
--
-- け知ダム (Kechi Dam) — 対馬市, Nagasaki Prefecture.
-- On け知川 (Kechi River), southern Tsushima Island.
-- Operated by 長崎県; dam_cd=2030 in the nagasaki-kasen API.
-- Type: G (gravity), Height: 29m, Completed: 1976.
-- Coordinates are approximate (対馬島南部, け知川流域).

INSERT INTO dams (slug, name, pref_code, completed_year, manager, height_m, location, external_ids)
VALUES (
  'kechi-42',
  'け知',
  '42',
  1976,
  '長崎県',
  29,
  ST_SetSRID(ST_MakePoint(129.325, 34.15), 4326),
  '{"nagasaki-kasen": "2030"}'
)
ON CONFLICT (slug) DO NOTHING;
