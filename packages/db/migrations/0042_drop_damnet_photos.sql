-- Stop using ダム便覧 (日本ダム協会) photographs.
--
-- dambinran.damnet.or.jp/media-policy/ grants no blanket right of reuse:
-- every photo in the フォト・アーカイブス carries its own 使用条件, and where a
-- photo states none the policy directs you to ask the association. Photo
-- contest entries, top photos and videos are "使用可否については、ダム協会まで
-- お問い合わせください" outright. The site footer likewise reserves everything:
-- 「ダム便覧」内の文章、画像、データなどすべての内容の無断転載を禁じます。
--
-- Copyright also rests with the individual contributors — /about/ thanks users
-- for 写真の提供 — so the association could not grant a blanket licence even if
-- it wanted to, and naming the source is not a substitute for permission.
--
-- We were hotlinking these straight from their WordPress uploads. Alongside
-- this migration: the images:refresh:damnet cron and its task are deleted, the
-- host is out of next.config.ts remotePatterns, and imageCredit() no longer
-- credits damnet URLs. Wikimedia photos (CC-BY-SA, credited per file) stay.
--
-- Nulling rather than dropping the column: image_url still serves Wikimedia,
-- and refresh_dam_images_wikipedia backfills WHERE image_url IS NULL, so these
-- dams simply become eligible for a properly licensed photo instead.

UPDATE dams
SET image_url = NULL,
    updated_at = NOW()
WHERE image_url LIKE '%damnet.or.jp%';
