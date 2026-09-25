-- 0055: give five same-name ため池 their own specs back.
--
-- Issue #59, follow-up to #54. The old Damnet matcher copied the
-- last-processed ダム便覧 record onto every row sharing a (prefecture, name)
-- key. 0052 moved each ダム便覧 number to the right row, which left these
-- five without one: ダム便覧 has no record for them. Their spec columns still
-- hold a different dam's values — e.g. nishitaniike-33 (矢掛町, 和田川) shows
-- the 16.8 m height of 西谷池 3494 in 久米南町 — and master:refresh:damnet
-- never touches a row it does not assign.
--
-- Reset them to NDI W01, the only source that describes these structures:
-- 堤高 W01_007, 堤頂長 W01_008, 流域面積 W01_009 (-9999 = unknown), 総貯水容量
-- W01_010 (千m³), 完成年 W01_012, 所在地 W01_013. Columns only ダム便覧 fills
-- (manager, capacities other than total, purposes, …) are cleared rather
-- than left pointing at the neighbour. `type` and `name_kana` are kept: all
-- five are アースフィル ため池 and share the neighbour's name.
--
-- None of the five has a source relying on active_capacity_m3 (their only
-- observations were the retired synthetic seed). Keyed by NDI id; the
-- `NOT external_ids ? 'damnet'` guard skips a row a later refresh has bound.

UPDATE dams d SET
  height_m                = v.height_m,
  crest_length_m          = v.crest_length_m,
  watershed_area_km2      = v.watershed_area_km2,
  total_capacity_m3       = v.total_capacity_m3,
  completed_year          = v.completed_year,
  left_bank_location      = v.left_bank_location,
  manager                 = NULL,
  effective_capacity_m3   = NULL,
  active_capacity_m3      = NULL,
  flood_capacity_m3       = NULL,
  construction_start_year = NULL,
  purposes                = NULL,
  embankment_volume_m3    = NULL,
  reservoir_area_km2      = NULL,
  main_contractor         = NULL,
  redevelopment_status    = NULL
FROM (VALUES
  -- ndi,  height, crest, catchment, total m³, completed, 所在地
  ('2217', 15.0, 50.0, NULL::numeric, 10000,  1866, '松山市儀式坂本'),      -- shinike-38 新池 (儀式川)
  ('1762', 18.0, 70.0, 23,            80000,  1800, '津山市'),              -- taishouike-33-2 大正池 (美田川)
  ('1767', 15.0, 71.0, 32,            40000,  1750, '備前市吉永町岩崎'),    -- takidaniike-33 滝谷池 (八塔寺川)
  ('1783', 21.0, 89.0, 21,            158000, NULL, '和気郡和気町日笠下'),  -- shinike-33 新池 (稗田谷川)
  ('1853', 15.2, 50.0, 48,            53000,  NULL, '小田郡矢掛町')         -- nishitaniike-33 西谷池 (和田川)
) AS v(ndi, height_m, crest_length_m, watershed_area_km2, total_capacity_m3, completed_year, left_bank_location)
WHERE d.external_ids->>'ndi' = v.ndi
  AND NOT d.external_ids ? 'damnet';
