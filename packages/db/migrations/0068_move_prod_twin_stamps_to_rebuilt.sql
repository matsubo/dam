-- 0068: move stamps that pin live stations to a （元） onto the completed （再） (#79).
--
-- fukuoka-bodik, qsr-toukan-dam and match_kasenbosai now keep a twin that
-- alone holds a station's stamp. The stamps prod already has on these （元）
-- rows would therefore keep the station on the old structure for good. Each
-- （再） below was completed before 2026-05-19, where every one of these
-- stations' prod history starts. The value is copied, not restated. Keyed by
-- NDI id. A row is only changed where the （元） has the key and the （再） has
-- none (or already has the same value), so this is idempotent and a no-op on
-- a fresh database.
--
-- Evidence (prod read 2026-09-27; kawabou = river.go.jp/kawabou/file/files/
-- {tmlist,master/obs}/dam/<obs_fcd>.json; ダム便覧 =
-- dambinran.damnet.or.jp/dams/japan/<no>):
--
--   fukuoka-bodik 南畑ダム  2453 → 2454 南畑（再, 1985）
--     /sources/fukuoka-bodik shows 南畑（元）. Its volume equals kawabou
--     1024100700002's (2,808 vs 2,807 千m³ at 17:00/17:40). That station's
--     own 有効 rate gives an 有効 capacity of 5,558–5,561 千m³ over 99
--     readings: （再） 5,560, not （元） 4,560.
--   qsr-toukan-dam 松原ダム  2467 → 2468 松原（再, 1984）
--     /sources/qsr-toukan-dam shows 松原（元）. It is the same dam body:
--     ダム便覧 2798 describes the 1984 （再） as a change to the reservoir's
--     operating plan plus selective-intake and small-hydro plant. The task's
--     other page, 下筌ダム, and jwa-chikugo's 松原ダム are on the （再）
--     already.
--   kasenbosai, each station alone on the （元）:
--     0230500700001 中禅寺  633 → 634 （再, 1998）  Tochigi pref: the dam
--       managed since 1960 was redeveloped and completed 1999-10
--       (pref.tochigi.lg.jp/h07/tyuuzennjidam.html). Rows 1 m apart.
--       0066 moves tochigi-bodik the same way.
--     2790500700035 山須原  2352 → 2346 （再, 2022）  Kyuden cut down the
--     2790500700036 西郷    2353 → 2347 （再, 2018）  existing dams in place
--       (「既設ダムの切り下げ工事」, https://www.kyuden.co.jp/company/
--       history/energy/hydropower/hydropower-1.html; ダム便覧 3672 / 3671).
--     2790500700029 西畑    2340 → 2339 （再, 2016）  ダム便覧 3673: the
--       existing gates were removed and the crest raised and lengthened.
--     1100900700002 氷川    2668 → 2669 （再, 2010）  Kumamoto pref: the
--       body was raised 2 m and back in service 2010-06
--       (pref.kumamoto.jp/soshiki/107/463.html).
--     0819300700013 笹倉    1693 → 1694 （再, 2006）  Shimane manages one
--       笹倉ダム, 「平成18年度再開発」 (https://www1.pref.shimane.lg.jp/
--       infra/river/kikan/masuda_kendo/ijikanribu/masudakawadam.html).
--       Rows 2 m apart.
--     1075300700035 本河内低部 2603 → 2604 （再, 2012）  Its 有効 rate gives
--       575–584 千m³ over 99 readings: （再） 577, not （元） 608. The
--       station has a surcharge level and a flood-control start flow; only
--       the （再） has flood control (FNW vs W).
--     1075300700034 本河内高部 2605 → 2606 （再, 2006）  The （再） is a new
--       body just upstream (ダム便覧 2570), with the old one kept. The
--       station's 有効 rate gives 385.6–386.8 千m³: （再） 386, not （元）
--       335.
--
-- Not moved here:
--   長安口 kasenbosai (（再） due 2028). 佐久間, 木屋川, 新保川 and 五名: the
--   （再） has no completion year.
--   16 kasenbosai stations stamped on both twins (千五沢, 南畑, 天ヶ瀬, 山王海,
--   帝釈川, 松原, 横山, 浜田, 牧尾, 狭山池, 美和, 美田, 花山, 萱瀬, 藤井川,
--   野洲川). Replaying match_kasenbosai's scoring on prod's rows against the
--   full 2026-09-27 catalogue puts every one on its completed （再） with an
--   exact name. bindStation then takes the key off the （元）.
--   mudam. backfill:mudam matches by name and distance every month and never
--   reads its stamp. It only adds stamps, so a move here would be written
--   back on the 20th, and its rows would still land on whichever twin is
--   nearer. Its 2019–2024 rows postdate most of these （再） completions, but
--   fixing that needs the task to bind like the others, followed by an
--   observations:rebind.
--
-- Past observations move with the `observations:rebind` task, not here.

CREATE TEMP TABLE station_move (source text, from_ndi text, to_ndi text);

INSERT INTO station_move VALUES
  ('fukuoka-bodik',  '2453', '2454'),
  ('qsr-toukan-dam', '2467', '2468'),
  ('kasenbosai',     '633',  '634'),
  ('kasenbosai',     '2352', '2346'),
  ('kasenbosai',     '2353', '2347'),
  ('kasenbosai',     '2340', '2339'),
  ('kasenbosai',     '2668', '2669'),
  ('kasenbosai',     '1693', '1694'),
  ('kasenbosai',     '2603', '2604'),
  ('kasenbosai',     '2605', '2606');

UPDATE dams t
SET external_ids = t.external_ids || jsonb_build_object(m.source, f.external_ids->>m.source)
FROM station_move m
JOIN dams f ON f.external_ids->>'ndi' = m.from_ndi
WHERE t.external_ids->>'ndi' = m.to_ndi
  AND f.external_ids ? m.source
  AND NOT t.external_ids ? m.source;

UPDATE dams f
SET external_ids = f.external_ids - m.source
FROM station_move m
JOIN dams t ON t.external_ids->>'ndi' = m.to_ndi
WHERE f.external_ids->>'ndi' = m.from_ndi
  AND t.external_ids->>m.source = f.external_ids->>m.source;

DROP TABLE station_move;
