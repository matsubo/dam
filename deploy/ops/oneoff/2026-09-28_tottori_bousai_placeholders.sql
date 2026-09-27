-- Drop tottori-bousai rows that are not the dam's own telemetry.
--
-- 鳥取県防災Web sometimes serves dam items that belong to another dam or are
-- a placeholder, all with flag "0" (normal):
--
--   /data/dam/list/2026-09-27-12-20.json  total 2 (of 6): 朝鍋 0 m / 0 千m³
--   /data/dam/list/2026-09-23-14-20.json  total 2: 朝鍋 and 菅沢 both
--                                          0 m / 0 千m³ / 24 % / 0.08 / 0.07
--   /data/dam/list/2026-09-27-05-20.json  total 6: 菅沢 102.89 m / 280 千m³ /
--                                          24 % — 朝鍋's real values verbatim
--
-- Each item prints its own 最低水位 (朝鍋 97.0 m, 菅沢 353.1 m), and these
-- levels sit 97–353 m below it. tottori-bousai (312) outranks tottori-dam and
-- cgr-mlit-dam, so every such row was a plunge on the dam's chart.
-- ingest_tottori_bousai.ts now skips any item more than 20 m below its own
-- 最低水位; this deletes the stored ones by the same rule, per station stamp
-- (external_ids->>'tottori-bousai') with the 最低水位 the feed prints. Every
-- real prod reading is above 最低水位 (closest: 百谷 62.37 vs 60.4 m; 菅沢's
-- lowest real reading 356.04 m). Whole rows go: a copied item's rate and
-- flows are another dam's too.
--
-- Prod dry-run (2026-09-28), same predicate as the DELETE below:
--   朝鍋 (71005, NDI 1631)  256 rows — all level 0
--   菅沢 (71006, NDI 1624)  167 rows — 17 level 0 + 150 copies (102.74–106.70 m,
--                            each equal to 朝鍋's level at the same observed_at)
--   百谷/佐治川/東郷/賀祥     0 rows
--   423 rows total; 307 in compressed chunks, 116 uncompressed.
--
-- Idempotent; a no-op on a fresh database.
--
-- After it: obs_daily's refresh policy only reaches back 60 days, so refresh
-- the older buckets by hand (outside a transaction):
--   CALL refresh_continuous_aggregate('obs_daily', '2026-06-01', now() - interval '59 days');
--   CALL refresh_continuous_aggregate('obs_monthly', '2026-06-01', '2026-08-01');

DELETE FROM observations o
USING dams d,
      (VALUES ('71001', 60.4), ('71002', 379.7), ('71003', 88.0),
              ('71004', 101.3), ('71005', 97.0), ('71006', 353.1))
        AS m (station, min_level_m)
WHERE o.source_id = 'tottori-bousai'
  AND d.id = o.dam_id
  AND d.external_ids ->> 'tottori-bousai' = m.station
  AND o.water_level_m < m.min_level_m - 20;
