-- The ingest run (apps/worker/src/ingest) records every row a provider lists.
-- Rows that are not one master dam are bound `'never'` by their task; without
-- a not_dam_reason they would sit in /coverage's unmatched backlog. Rows that
-- already carry a reason (0135, 0162, 0209, 0220, …) are not touched.
--
-- Upsert rather than UPDATE: most of these rows have never been recorded (the
-- old tasks skipped them), and the reason must be in place before the first
-- scan records them. The scan fills pref_code, has_data and the rest; it
-- never writes not_dam_reason. A row that later resolves to a dam wins over
-- the mark (coverageSummary counts only unresolved rows).

INSERT INTO source_universe (source_id, source_external_id, source_name, not_dam_reason)
VALUES
  ('aitoyo', '豊川用水全体', '豊川用水全体',
   'Combined figure for the whole 豊川用水 system (宇連 + 大島 + 地区内調整池); aitoyo lists only 宇連 on its own row. Not one master dam.'),
  ('akita-kasen', '八郎潟防潮水門', '八郎潟防潮水門',
   'Tide gate (防潮水門) of 八郎潟, listed on 秋田県 ダム一覧表; not a dam, no NDI master row.'),
  ('fukushima-kasen', '1799_7_21', '桧原湖',
   'Natural lake (裏磐梯) observed on 福島県 河川流域総合情報システム; not a dam, no NDI master row.'),
  ('fukushima-kasen', '1799_7_22', '小野川湖',
   'Natural lake (裏磐梯) observed on 福島県 河川流域総合情報システム; not a dam, no NDI master row.'),
  ('fukushima-kasen', '1799_7_23', '秋元湖',
   'Natural lake (裏磐梯) observed on 福島県 河川流域総合情報システム; not a dam, no NDI master row.'),
  ('fukushima-kasen', '1799_7_3', '十六橋水門',
   'Sluice gate (十六橋水門) at the 猪苗代湖 outlet; not a dam, no NDI master row.'),
  ('hyogo-bodik', '分水堰', '分水堰',
   'Weir (分水堰, CSV 局番号 12) in 兵庫県 BODIK ダム諸量; not a dam, no NDI master row.'),
  ('jwa-chubu', '地区内調整池', '地区内調整池',
   'Combined figure for the 豊川用水 地区内調整池, regulating ponds the report does not list on their own rows; not one master dam.'),
  ('jwa-chubu', '調整池(宮川・菰野・加佐登)', '調整池(宮川・菰野・加佐登)',
   'Combined figure for the 三重用水 調整池 宮川 + 菰野 + 加佐登; not one master dam.'),
  ('jwa-chubu', '長良導水', '長良導水',
   'Conduit (導水): the report gives its intake volume and a river level; not a dam.'),
  ('jwa-yoshino', '新井堰(床鍋)', '新井堰(床鍋)',
   'Intake weir on the 吉野川上流総合管理所 ダム情報掲示板; not a dam, no NDI master row.'),
  ('jwa-yoshino', '影井堰', '影井堰',
   'Intake weir on the 吉野川上流総合管理所 ダム情報掲示板; not a dam, no NDI master row.'),
  ('jwa-yoshino', '瀬戸川取水堰', '瀬戸川取水堰',
   'Intake weir on the 吉野川上流総合管理所 ダム情報掲示板; not a dam, no NDI master row.'),
  ('jwa-yoshino', '地蔵寺川取水堰', '地蔵寺川取水堰',
   'Intake weir on the 吉野川上流総合管理所 ダム情報掲示板; not a dam, no NDI master row.'),
  ('jwa-yoshino', '鏡ダム', '鏡ダム',
   'The board''s 鏡ダム row is its 自流量 measuring point, not the dam''s own reading (no level, volume or rate); 鏡ダム''s values come from other sources.'),
  ('kyoto-bousai', '瀬田洗堰1', '瀬田洗堰1',
   'Barrage (瀬田川洗堰) on the 京都府 河川防災情報 dam table; not a dam, no NDI master row.'),
  ('kyoto-bousai', '瀬田洗堰2', '瀬田洗堰2',
   'Barrage (瀬田川洗堰) on the 京都府 河川防災情報 dam table; not a dam, no NDI master row.'),
  ('nagano-kasen', '2001_7_3', '釜口水門',
   'Sluice gate (釜口水門) at the 諏訪湖 outlet; not a dam, no NDI master row.')
ON CONFLICT (source_id, source_external_id) DO UPDATE
  SET not_dam_reason = EXCLUDED.not_dam_reason
  WHERE source_universe.not_dam_reason IS NULL
    AND source_universe.resolved_dam_id IS NULL;

-- iwate-kasen stamped dams with the printed dam name while its universe used
-- the station number. The ingest run keys both on one value, the station
-- number, so move the stamps over; otherwise every dam would be re-decided by
-- name. Mapping from source_universe (resolved_dam_id) on 2026-10-27.
UPDATE dams d
SET external_ids = d.external_ids || jsonb_build_object('iwate-kasen', v.station)
FROM (VALUES
  ('滝ダム', '103007001'),
  ('簗川ダム', '103007002'),
  ('綱取ダム', '103007003'),
  ('日向ダム', '103007004'),
  ('鷹生ダム', '103007005'),
  ('綾里川ダム', '103007006'),
  ('早池峰ダム', '103007008'),
  ('入畑ダム', '103007011'),
  ('遠野ダム', '103007012'),
  ('遠野第二ダム', '103007016')
) AS v(name_stamp, station)
WHERE d.external_ids->>'iwate-kasen' = v.name_stamp;
