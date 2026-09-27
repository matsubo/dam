-- 0101: retire niigata-bousai and shizuoka-bousai — their robots.txt disallows us.
--
-- User decision (2026-09-28): stop crawling any upstream whose robots.txt
-- disallows it. Both files, fetched with `curl -s` on 2026-09-28:
--
--   http://doboku-bousai.pref.niigata.jp/robots.txt (新潟県河川防災情報システム)
--     User-agent: *
--     Disallow: /
--
--   https://sipos.pref.shizuoka.jp/robots.txt (静岡県 SIPOS)
--     User-agent *
--     Disallow:/
--     Allow:/index.html
--
-- Niigata's disallows everything. Shizuoka's line lacks the colon after
-- `User-agent`, but its intent is the same: only /index.html is allowed, and
-- the adapter read Map/json/… and etc/dam_master.json.
--
-- The tasks, their cron lines and registrations are deleted in the same
-- change. This row flip is what the read paths see: an inactive source is
-- out of the /coverage gate (it will never scan again), its source_universe
-- rows no longer count as published or as unmatched backlog, and
-- quality:freshness stops alerting on it.
--
-- Kept on purpose: the historical observations (still charted, still
-- attributed via /sources/<id>), trusted_rate_basis (0040 / 0048 — those rows
-- were published against the 利水 pool, and effective_active_capacity_m3()
-- still reads them), and the dams.external_ids stamps.
--
-- Live data lost (prod, 2026-09-28, last 3 days excluding mudam): only
-- 新保川（再） (NDI 1081) had niigata-bousai as its sole live source; the dam in
-- service, 新保川（元） (NDI 1082), stays live through kasenbosai, and 0071
-- moves the niigata-bousai stamp there. Every other niigata-bousai (19) and
-- shizuoka-bousai (5) dam has live kasenbosai data.
--
-- Prod dry-run 2026-09-28: 2 rows, both active = true. On a fresh database
-- 0040 / 0048 seed both rows, so they are retired there too; where the rows
-- are absent this updates nothing. Idempotent: a second run matches 0 rows.

UPDATE source_priorities
SET active = FALSE
WHERE source_id IN ('niigata-bousai', 'shizuoka-bousai')
  AND active;
