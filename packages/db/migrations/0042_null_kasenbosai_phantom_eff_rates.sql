-- 合角ダム and 有間ダム flag 利水容量貯水率 invalid (storPcntIrrCcd=160) and then
-- publish 有効容量貯水率 = 100 with Ccd=0 while sitting under half full: on
-- 2026-09-10 合角 held 4,135 千m³ against a 9,250 千m³ 有効貯水容量, a real 44.7 %.
-- The quality code says the value is good, so the ingester stored it and every
-- 貯水率 for those dams read 100 % — including the 荒川 water-system gauge, which
-- showed 99.3 %. Both dams have carried a flat 1.0000 since at least 2026-07-12.
--
-- ingest_kasenbosai_v2.ts now cross-checks an 'eff'-basis rate against the dam's
-- own 有効貯水容量 (rateIfConsistent), so no new phantom rows arrive. This cleans
-- up the existing ones. Same family as the Ccd=160 phantom zeros in migrations
-- 0038/0039, but in the rate field rather than the volume field.
--
-- Targeting mirrors 0038's "series has no variance" test, because a stored rate
-- does not record which denominator it was published against (that per-row
-- basis is the open follow-up). Three conditions together isolate the phantom:
--
--   1. the dam's kasenbosai rate never moves off exactly 1.0, while
--   2. its volume does vary — a real reading tracks its reservoir, and
--   3. even at its fullest the dam stayed well under its 有効貯水容量, so a
--      constant 100 % is arithmetically impossible.
--
-- 浦山ダム is the case this must not touch: it genuinely sits at 100 % of its
-- seasonal 利水容量 while holding 61.7 % of 有効貯水容量. Condition 1 excludes it
-- because its series moved from 0.5840 to 1.0000 when the feed's 利水 rate came
-- back — see #17/#19 for why a 利水 rate is not comparable to 有効貯水容量.
--
-- Setting the rate to NULL is enough: migration 0036's BEFORE UPDATE trigger
-- refills it from storage_volume_m3 / active_capacity_m3, which for 合角 gives
-- the correct 0.4470 rather than leaving a gap.
UPDATE observations o
SET storage_rate = NULL
WHERE o.source_id = 'kasenbosai'
  AND o.storage_rate IS NOT NULL
  AND o.dam_id IN (
    SELECT o2.dam_id
    FROM observations o2
    JOIN dams d ON d.id = o2.dam_id
    WHERE o2.source_id = 'kasenbosai'
      AND o2.storage_rate IS NOT NULL
      AND o2.storage_volume_m3 IS NOT NULL
      AND d.effective_capacity_m3 IS NOT NULL
      AND d.effective_capacity_m3 > 0
    GROUP BY o2.dam_id, d.effective_capacity_m3
    HAVING MIN(o2.storage_rate) = 1.0
       AND MAX(o2.storage_rate) = 1.0
       AND MIN(o2.storage_volume_m3) < MAX(o2.storage_volume_m3)
       AND MAX(o2.storage_volume_m3) / d.effective_capacity_m3 < 0.85
  );
