import { sql } from '../client.ts';
import { RATE_FRESHNESS_DAYS } from './watersheds.ts';

// 平年比 (comparison against the seasonal norm): for "is this year unusually
// dry?", the absolute storage rate matters less than how today's volume
// compares with the same season in past years. The norm is the average of
// obs_daily buckets whose day-of-year falls within ±NORM_DOY_WINDOW of
// today, excluding the current season, over however many years of history
// exist (mudam backfill reaches ~27 years for ~600 dams).

/** ± days around today's day-of-year that count as "same season". */
export const NORM_DOY_WINDOW = 7;
/** Days recent enough to be "this season" — excluded from the norm. */
const NORM_EXCLUDE_RECENT_DAYS = 60;
/** Minimum obs_daily buckets before a norm is considered meaningful. */
const MIN_NORM_BUCKETS = 5;

export interface SeasonalNorm {
  /** Latest fresh storage (m³) summed over the contributing dams. */
  currentVolumeM3: string;
  /** Seasonal-norm storage (m³) summed over the same dams. */
  normVolumeM3: string;
  /** Dams contributing — those with BOTH a fresh observation and history. */
  damCount: number;
  /** Distinct calendar years backing the norm. */
  years: number;
}

/**
 * Same-season historical norm vs the latest fresh observation for one dam.
 * Null when the dam lacks a fresh observation or enough history.
 */
export async function damSeasonalNorm(damId: bigint): Promise<SeasonalNorm | null> {
  const rows = await sql<SeasonalNorm[]>`
    WITH current AS (
      SELECT o.storage_volume_m3
      FROM observations o
      WHERE o.dam_id = ${damId}
        AND o.storage_volume_m3 IS NOT NULL
        AND o.observed_at > NOW() - make_interval(days => ${RATE_FRESHNESS_DAYS})
      ORDER BY o.observed_at DESC
      LIMIT 1
    ),
    norm AS (
      SELECT AVG(od.last_storage_volume_m3) AS norm_volume,
             COUNT(*)                       AS buckets,
             COUNT(DISTINCT EXTRACT(YEAR FROM od.day)) AS years
      FROM obs_daily od
      WHERE od.dam_id = ${damId}
        AND od.last_storage_volume_m3 IS NOT NULL
        AND od.day < NOW() - make_interval(days => ${NORM_EXCLUDE_RECENT_DAYS})
        AND LEAST(
              ABS(EXTRACT(DOY FROM od.day) - EXTRACT(DOY FROM NOW())),
              366 - ABS(EXTRACT(DOY FROM od.day) - EXTRACT(DOY FROM NOW()))
            ) <= ${NORM_DOY_WINDOW}
    )
    SELECT
      current.storage_volume_m3::TEXT AS "currentVolumeM3",
      norm.norm_volume::TEXT          AS "normVolumeM3",
      1::INT                          AS "damCount",
      norm.years::INT                 AS "years"
    FROM current, norm
    WHERE norm.buckets >= ${MIN_NORM_BUCKETS}
      AND norm.norm_volume > 0
  `;
  return rows[0] ?? null;
}

/**
 * Watershed-level 平年比: per-dam norms and the latest fresh volumes summed
 * over the SAME cohort — dams contribute only when they have both sides, so
 * the ratio compares like with like. Null when no dam qualifies.
 */
export async function watershedSeasonalNorm(watershedId: bigint): Promise<SeasonalNorm | null> {
  const rows = await sql<SeasonalNorm[]>`
    WITH cohort AS (
      SELECT DISTINCT ON (o.dam_id) o.dam_id, o.storage_volume_m3 AS current_volume
      FROM observations o
      JOIN dams d ON d.id = o.dam_id
      WHERE d.watershed_id = ${watershedId}
        AND o.storage_volume_m3 IS NOT NULL
        AND o.observed_at > NOW() - make_interval(days => ${RATE_FRESHNESS_DAYS})
      ORDER BY o.dam_id, o.observed_at DESC
    ),
    norm AS (
      SELECT od.dam_id,
             AVG(od.last_storage_volume_m3) AS norm_volume,
             COUNT(DISTINCT EXTRACT(YEAR FROM od.day)) AS years
      FROM obs_daily od
      JOIN cohort c ON c.dam_id = od.dam_id
      WHERE od.last_storage_volume_m3 IS NOT NULL
        AND od.day < NOW() - make_interval(days => ${NORM_EXCLUDE_RECENT_DAYS})
        AND LEAST(
              ABS(EXTRACT(DOY FROM od.day) - EXTRACT(DOY FROM NOW())),
              366 - ABS(EXTRACT(DOY FROM od.day) - EXTRACT(DOY FROM NOW()))
            ) <= ${NORM_DOY_WINDOW}
      GROUP BY od.dam_id
      HAVING COUNT(*) >= ${MIN_NORM_BUCKETS} AND AVG(od.last_storage_volume_m3) > 0
    )
    SELECT
      SUM(c.current_volume)::TEXT AS "currentVolumeM3",
      SUM(n.norm_volume)::TEXT    AS "normVolumeM3",
      COUNT(*)::INT               AS "damCount",
      MAX(n.years)::INT           AS "years"
    FROM cohort c
    JOIN norm n ON n.dam_id = c.dam_id
    HAVING COUNT(*) > 0
  `;
  return rows[0] ?? null;
}
