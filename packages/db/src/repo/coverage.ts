import { sql } from '../client.ts';

/**
 * The site quotes two different coverage numbers and they answer two
 * different questions:
 *
 * - `realtimeDamCount` — dams with ANY non-synthetic value in the window. A
 *   source that only publishes 水位 or 雨量 still counts here; a row with
 *   every quantity NULL (a blank mudam day, an all-欠測 hour) does not.
 * - `storageRateRiverDamCount` / `riverDamCount` — dams we can actually show
 *   a 貯水率 for, over the dams the ダム法 calls a dam (堤高 15 m 以上).
 *
 * Both are honest; they are simply not the same metric. This module is their
 * single definition so the home page and /coverage cannot drift apart.
 */
export interface CoverageHeadline {
  /** Every master row, including 堤高 15 m 未満 のため池など. */
  damTotal: number;
  /** Dams with a non-synthetic, non-empty observation inside the window. */
  realtimeDamCount: number;
  /** Dams with a non-synthetic, non-empty observation at any time (mudam history counts). */
  historicalDamCount: number;
  /** 河川管理ダム: 堤高 15 m 以上 — the 貯水率 coverage denominator. */
  riverDamCount: number;
  /** River dams with a 貯水率 inside the window — the numerator. */
  storageRateRiverDamCount: number;
}

export const DEFAULT_WINDOW_DAYS = 30;
/** ダム法の定義: 堤高 15 m 以上. */
export const RIVER_DAM_MIN_HEIGHT_M = 15;

export async function coverageHeadline(
  windowDays: number = DEFAULT_WINDOW_DAYS,
): Promise<CoverageHeadline> {
  const rows = await sql<CoverageHeadline[]>`
    SELECT
      (SELECT COUNT(*)::INT FROM dams)                                   AS "damTotal",
      (SELECT COUNT(DISTINCT dam_id)::INT
         FROM observations
         WHERE observed_at > NOW() - MAKE_INTERVAL(days => ${windowDays})
           AND source_id <> 'synthetic'
           AND num_nonnulls(storage_volume_m3, storage_rate, inflow_m3s,
                            outflow_m3s, water_level_m, rainfall_mm) > 0) AS "realtimeDamCount",
      (SELECT COUNT(DISTINCT dam_id)::INT
         FROM observations
         WHERE source_id <> 'synthetic'
           AND num_nonnulls(storage_volume_m3, storage_rate, inflow_m3s,
                            outflow_m3s, water_level_m, rainfall_mm) > 0) AS "historicalDamCount",
      (SELECT COUNT(*)::INT
         FROM dams
         WHERE height_m >= ${RIVER_DAM_MIN_HEIGHT_M})                    AS "riverDamCount",
      (SELECT COUNT(DISTINCT o.dam_id)::INT
         FROM observations o
         JOIN dams d ON d.id = o.dam_id
         WHERE d.height_m >= ${RIVER_DAM_MIN_HEIGHT_M}
           AND o.observed_at > NOW() - MAKE_INTERVAL(days => ${windowDays})
           AND o.source_id <> 'synthetic'
           AND o.storage_rate IS NOT NULL)                               AS "storageRateRiverDamCount"
  `;
  const row = rows[0];
  if (!row) throw new Error('coverageHeadline returned no row');
  return row;
}

/** 貯水率が取れているダムの割合 [0..100]. Null-safe on an empty master. */
export function storageRateCoveragePct(c: CoverageHeadline): number | null {
  if (c.riverDamCount <= 0) return null;
  return (c.storageRateRiverDamCount / c.riverDamCount) * 100;
}

/** 何らかの実測がある割合 [0..100]. */
export function realtimeCoveragePct(c: CoverageHeadline): number | null {
  if (c.damTotal <= 0) return null;
  return (c.realtimeDamCount / c.damTotal) * 100;
}
