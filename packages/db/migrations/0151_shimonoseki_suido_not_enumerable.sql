-- 0151: shimonoseki-suido publishes its list only during a 渇水 notice.
--
-- The source reads 下関市上下水道局's 水源状況 page (/site/water/5617.html),
-- a notice posted for a 渇水 and taken down when it ends. On 2026-09-28 the
-- page returned HTTP 404 and its category page read 「現在、掲載されている
-- 情報はありません」, so the task has never recorded a universe run on prod.
-- Because of that, the #51 gate stayed open, and /coverage showed
-- 「公開一覧が未記録の提供元」 and 提供元なし 0 for every dam in the country.
--
-- This is the same class as kagoshima-bousai (0044): a list that exists only
-- during an event cannot be enumerated on an ordinary day. Say so, so the
-- gate can close; the coverage summary already counts such providers.
--
-- Upsert: on a fresh database the task's ensureSourcePriority() has not run
-- yet, and it never touches universe_enumerable.
INSERT INTO source_priorities (source_id, priority, description, active, universe_enumerable)
VALUES ('shimonoseki-suido', 293,
        '下関市上下水道局 水源状況 — 湯の原ダム (貯水量+貯水率, 当日0時, 週数回更新)',
        TRUE, FALSE)
ON CONFLICT (source_id) DO UPDATE
  SET universe_enumerable = FALSE;
