-- 0071: move 新保川, 松川 and 長柄 stamps from the unfinished （再） to the （元） (#79).
--
-- 0064, 0065, 0067 and 0068 left these stations on the rows they were bound
-- to "until the operator's current structure is confirmed". The operators
-- confirm it now: none of these redevelopments is finished, so the dam in
-- service is the （元）. That is also what preferMaster picks for a （再）
-- with no completion year, so once moved, stamp and tie-break agree. No
-- （再） year is set: no primary source gives one (ダム便覧 has none either).
-- Evidence fetched 2026-09-27:
--
--   新保川 (新潟)  （再） 1081 → （元） 1082
--     https://www.pref.niigata.lg.jp/sec/sado_seibi/1356849122617.html
--     "【2度目のかさ上げが計画されているダム】… 再開発事業を進めており …
--     現在各種調査を行っている段階です", and it links the 県河川防災情報
--     readings as those of this dam. Its 諸元 page (…/1356855541226.html)
--     gives the （元） body: 堤高 29.0 m, 総貯水容量 50万 m³, 常時満水位
--     EL 160.20 m. Prod's niigata-bousai levels (160.35–161.64 m) are the
--     same band as mudam's 2020–2024 series on the （元） (160.24–161.98 m).
--     ダム便覧 3115 dropped even the （再）'s start year (着手 1991→ blank).
--     kasenbosai (0384100700018) and mudam (279) are already on the （元）.
--   松川 (長野)  （再） 799 → （元） 800
--     https://www.pref.nagano.lg.jp/matsukawadamu/index.html: "平成2年度より
--     松川ダム再開発事業を進め堆積土砂の除去やバイパス放流の運用を行って
--     おります", "堆積土砂の除去工事を進めています". …/jigyo/matsukawadam/
--     saikaihatsu-01.html (updated 2025-02-26): "現在、松川ダムでの洪水調節
--     は…予備放流…再開発では予備放流分の容量を新たに確保し" — the （再）'s
--     added capacity (ダム便覧 3082: 有効 6,400 vs 1024's 5,400 千m³) is
--     not in service yet. Same body (84.3 m), so levels cannot tell the rows
--     apart; no source here publishes a volume. nagano-kasen (2001_7_1),
--     kasenbosai (2183100700010) and mudam (296) move.
--   長柄 (香川)  （再） 2155 → （元） 2156
--     https://www.pref.kagawa.lg.jp/kasensabo/dam/kagawa_dam/kfvn.html lists
--     「長柄ダム」 and 「長柄ダム再開発（建設中）」 (likewise 「五名ダム再開発
--     （建設中）」). …/kasensabo/dam/nagara_saikaihatsu.html: "現在、ダム本体
--     工事の着手に必要な付替道路の整備を進めております". …/kagawa_dam/chusan/
--     12nagara.html gives the dam in service: 堤高 30.0 m, 有効 4,110,000 m³,
--     不特定容量 2,170,000 m³ — the （元）. kagawa-bousai's own volume/rate
--     gives a basis of 2,167.7–2,171.2 千m³ (701 readings from 2026-08-11
--     JST) and 3,795.6–3,802.8 千m³ (1,563 before); the （再） would hold
--     7,740 千m³. Its levels peak at 123.46 m, mudam's 2020–2024 series on
--     the （元） at 123.51 m. kagawa-bousai (長柄ダム) and kasenbosai
--     (0947300700013) move; mudam (456) is already on the （元）.
--
-- Kept:
--   五名: kagawa-bousai, kasenbosai and mudam are already on 五名（元） (2130),
--     the dam in service (…/kagawa_dam/tousan/02gomyou.html: 堤高 27.5 m,
--     有効 536,000 m³; the （再） is a new dam 700 m downstream, 建設中).
--   狭山池: 狭山池（再） (1427, completed 2001, ダム便覧 1440) is the dam in
--     service (https://www.pref.osaka.lg.jp/o130100/damusabo/dam/sayama.html:
--     完成した狭山池ダム, 堤高 18.5 m, 総貯水容量 280万 m³). osaka-bousai's
--     volume/rate gives 2,795–2,805 千m³ over 2,826 readings.
--
-- The value is copied, not restated. Keyed by NDI id. A row is only changed
-- where the （再） has the key and the （元） has none (or already has the same
-- value), so this is idempotent and a no-op on a fresh database. Past
-- observations move with the `observations:rebind` task, not here.

CREATE TEMP TABLE station_move (source text, from_ndi text, to_ndi text);

INSERT INTO station_move VALUES
  ('niigata-bousai', '1081', '1082'),
  ('nagano-kasen',   '799',  '800'),
  ('kasenbosai',     '799',  '800'),
  ('mudam',          '799',  '800'),
  ('kagawa-bousai',  '2155', '2156'),
  ('kasenbosai',     '2155', '2156');

-- UPDATE … FROM applies one joined row per target, and 松川 and 長柄 move
-- several sources each, so the keys are gathered per row first.
UPDATE dams t
SET external_ids = t.external_ids || c.stamps
FROM (
  SELECT m.to_ndi, jsonb_object_agg(m.source, src.external_ids->>m.source) AS stamps
  FROM station_move m
  JOIN dams src ON src.external_ids->>'ndi' = m.from_ndi
  JOIN dams dst ON dst.external_ids->>'ndi' = m.to_ndi
  WHERE src.external_ids ? m.source
    AND NOT dst.external_ids ? m.source
  GROUP BY m.to_ndi
) c
WHERE t.external_ids->>'ndi' = c.to_ndi;

UPDATE dams f
SET external_ids = f.external_ids - c.sources
FROM (
  SELECT m.from_ndi, array_agg(m.source) AS sources
  FROM station_move m
  JOIN dams src ON src.external_ids->>'ndi' = m.from_ndi
  JOIN dams dst ON dst.external_ids->>'ndi' = m.to_ndi
  WHERE dst.external_ids->>m.source = src.external_ids->>m.source
  GROUP BY m.from_ndi
) c
WHERE f.external_ids->>'ndi' = c.from_ndi;

DROP TABLE station_move;
