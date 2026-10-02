import { sql } from '../client.ts';
import { classifyDamCoverage, isUnobtainable } from './source_universe.ts';

/**
 * The site quotes two different coverage numbers and they answer two
 * different questions:
 *
 * - `realtimeDamCount` — dams `classifyDamCoverage` calls `covered`: ANY
 *   non-synthetic value in the last 30 days, or the newest value a dated
 *   provider (a monthly survey) publishes. A source that only publishes 水位
 *   or 雨量 still counts; a row with every quantity NULL (a blank mudam day,
 *   an all-欠測 hour) does not.
 * - `storageRateRiverDamCount` / `riverDamCount` — dams we can actually show
 *   a 貯水率 for in the last 30 days, over the dams the ダム法 calls a dam
 *   (堤高 15 m 以上).
 *
 * Both are honest; they are simply not the same metric. This module is their
 * single definition so the home page and /coverage cannot drift apart.
 *
 * Dams there is nothing to obtain for are in no denominator: 提供元なし
 * (`not_published`: every provider's list has been recorded and none carries
 * it) and 提供元に値なし (`published_no_data`: every provider listing it marks
 * it empty). They are also out of the 歴史データ numerator, so that metric
 * shares the same population. While the gate is open no dam is 提供元なし.
 */
export interface CoverageHeadline {
  /** Every master row, including 堤高 15 m 未満 のため池など. */
  damTotal: number;
  /** Dams classified `covered`. */
  realtimeDamCount: number;
  /**
   * Dams with a non-synthetic, non-empty observation at any time (mudam
   * history counts), 提供元なし / 提供元に値なし dams excluded.
   */
  historicalDamCount: number;
  /** 河川管理ダム: 堤高 15 m 以上. */
  riverDamCount: number;
  /** River dams with a 貯水率 in the last 30 days — the numerator. */
  storageRateRiverDamCount: number;
  /** 提供元なし dams, out of the 実測 and 歴史 denominators. */
  notPublishedDamCount: number;
  /** 提供元に値なし dams, out of the 実測 and 歴史 denominators. */
  publishedNoDataDamCount: number;
  /** River dams of either kind, out of the 貯水率 denominator. */
  unobtainableRiverDamCount: number;
}

/** ダム法の定義: 堤高 15 m 以上. */
export const RIVER_DAM_MIN_HEIGHT_M = 15;

export async function coverageHeadline(): Promise<CoverageHeadline> {
  const triage = await classifyDamCoverage();
  const excluded = triage.filter((r) => isUnobtainable(r.status)).map((r) => r.damId.toString());
  const rows = await sql<
    Omit<
      CoverageHeadline,
      'realtimeDamCount' | 'notPublishedDamCount' | 'publishedNoDataDamCount'
    >[]
  >`
    WITH excluded AS (SELECT UNNEST(${excluded}::BIGINT[]) AS id)
    SELECT
      (SELECT COUNT(*)::INT FROM dams)                                   AS "damTotal",
      (SELECT COUNT(DISTINCT dam_id)::INT
         FROM observations
         WHERE source_id <> 'synthetic'
           AND dam_id NOT IN (SELECT id FROM excluded)
           AND num_nonnulls(storage_volume_m3, storage_rate, inflow_m3s,
                            outflow_m3s, water_level_m, rainfall_mm) > 0) AS "historicalDamCount",
      (SELECT COUNT(*)::INT
         FROM dams
         WHERE height_m >= ${RIVER_DAM_MIN_HEIGHT_M})                    AS "riverDamCount",
      (SELECT COUNT(DISTINCT o.dam_id)::INT
         FROM observations o
         JOIN dams d ON d.id = o.dam_id
         WHERE d.height_m >= ${RIVER_DAM_MIN_HEIGHT_M}
           AND o.observed_at > NOW() - INTERVAL '30 days'
           AND o.source_id <> 'synthetic'
           AND o.storage_rate IS NOT NULL)                               AS "storageRateRiverDamCount",
      (SELECT COUNT(*)::INT
         FROM dams
         WHERE height_m >= ${RIVER_DAM_MIN_HEIGHT_M}
           AND id IN (SELECT id FROM excluded))                         AS "unobtainableRiverDamCount"
  `;
  const row = rows[0];
  if (!row) throw new Error('coverageHeadline returned no row');
  return {
    ...row,
    realtimeDamCount: triage.filter((r) => r.status === 'covered').length,
    notPublishedDamCount: triage.filter((r) => r.status === 'not_published').length,
    publishedNoDataDamCount: triage.filter((r) => r.status === 'published_no_data').length,
  };
}

function share(numerator: number, denominator: number): number | null {
  return denominator > 0 ? (numerator / denominator) * 100 : null;
}

/** Dams there is something to obtain for: the 実測 and 歴史 denominator. */
export function coverageDamTotal(c: CoverageHeadline): number {
  return c.damTotal - c.notPublishedDamCount - c.publishedNoDataDamCount;
}

/** River dams there is something to obtain for: the 貯水率 denominator. */
export function coverageRiverDamCount(c: CoverageHeadline): number {
  return c.riverDamCount - c.unobtainableRiverDamCount;
}

/** 貯水率が取れているダムの割合 [0..100]. Null when the denominator is empty. */
export function storageRateCoveragePct(c: CoverageHeadline): number | null {
  return share(c.storageRateRiverDamCount, coverageRiverDamCount(c));
}

/** 取得できるダムのうち、何らかの実測を取得済みの割合 [0..100]. */
export function realtimeCoveragePct(c: CoverageHeadline): number | null {
  return share(c.realtimeDamCount, coverageDamTotal(c));
}

/** 過去に一度でも実測があった割合 [0..100]. */
export function historicalCoveragePct(c: CoverageHeadline): number | null {
  return share(c.historicalDamCount, coverageDamTotal(c));
}
