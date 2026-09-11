import { sql } from '../client.ts';

/**
 * 全国貯水率 (and its per-prefecture / per-watershed cuts) is computed over the
 * *observed cohort*: dams that have a 有効貯水容量 in the master AND a storage
 * volume observed within the freshness window. Both the numerator (storage)
 * and the denominator (capacity) sum over that same cohort — a dam with no
 * fresh reading must not contribute capacity only, which would silently
 * deflate the rate in proportion to our coverage gap rather than report how
 * full the reservoirs are.
 *
 * This module is the single definition of that cohort; the home page and
 * /stats both consume it so the two can no longer drift apart.
 */
export interface StorageTotals {
  /** Dams contributing to both sums. */
  observedDamCount: number;
  /** SUM of the latest fresh 貯水量, NULL when the cohort is empty. */
  storageM3: string | null;
  /** SUM of 有効貯水容量 over the same cohort, NULL when the cohort is empty. */
  activeCapacityM3: string | null;
}

/** Matches the home page's 7-day window for "current" storage. */
export const DEFAULT_FRESH_DAYS = 7;

const EMPTY: StorageTotals = { observedDamCount: 0, storageM3: null, activeCapacityM3: null };

interface TotalsRow {
  observedDamCount: number;
  storageM3: string | null;
  activeCapacityM3: string | null;
}

/**
 * The cohort itself: one row per dam, carrying the latest volume-bearing
 * observation. Filtering on `storage_volume_m3 IS NOT NULL` *before*
 * DISTINCT ON matters — a newer level-only row would otherwise win and null
 * out a dam that does have a usable reading.
 */
function cohort(freshDays: number) {
  return sql`
    SELECT DISTINCT ON (o.dam_id)
      o.dam_id,
      o.storage_volume_m3,
      d.active_capacity_m3,
      d.pref_code,
      d.watershed_id
    FROM observations o
    JOIN dams d ON d.id = o.dam_id
    WHERE o.observed_at > NOW() - MAKE_INTERVAL(days => ${freshDays})
      AND o.storage_volume_m3 IS NOT NULL
      AND d.active_capacity_m3 IS NOT NULL
    ORDER BY o.dam_id, o.observed_at DESC
  `;
}

export async function nationalStorageTotals(
  freshDays: number = DEFAULT_FRESH_DAYS,
): Promise<StorageTotals> {
  const rows = await sql<TotalsRow[]>`
    WITH fresh AS (${cohort(freshDays)})
    SELECT
      COUNT(*)::INT                  AS "observedDamCount",
      SUM(storage_volume_m3)::TEXT   AS "storageM3",
      SUM(active_capacity_m3)::TEXT  AS "activeCapacityM3"
    FROM fresh
  `;
  return rows[0] ?? EMPTY;
}

export async function storageTotalsByPref(
  freshDays: number = DEFAULT_FRESH_DAYS,
): Promise<Map<string, StorageTotals>> {
  const rows = await sql<(TotalsRow & { prefCode: string })[]>`
    WITH fresh AS (${cohort(freshDays)})
    SELECT
      pref_code                      AS "prefCode",
      COUNT(*)::INT                  AS "observedDamCount",
      SUM(storage_volume_m3)::TEXT   AS "storageM3",
      SUM(active_capacity_m3)::TEXT  AS "activeCapacityM3"
    FROM fresh
    WHERE pref_code IS NOT NULL
    GROUP BY pref_code
  `;
  return new Map(rows.map((r) => [r.prefCode, toTotals(r)]));
}

export async function storageTotalsByWatershed(
  freshDays: number = DEFAULT_FRESH_DAYS,
): Promise<Map<string, StorageTotals>> {
  const rows = await sql<(TotalsRow & { slug: string })[]>`
    WITH fresh AS (${cohort(freshDays)})
    SELECT
      w.slug                                AS "slug",
      COUNT(*)::INT                         AS "observedDamCount",
      SUM(f.storage_volume_m3)::TEXT        AS "storageM3",
      SUM(f.active_capacity_m3)::TEXT       AS "activeCapacityM3"
    FROM fresh f
    JOIN watersheds w ON w.id = f.watershed_id
    GROUP BY w.slug
  `;
  return new Map(rows.map((r) => [r.slug, toTotals(r)]));
}

function toTotals(r: TotalsRow): StorageTotals {
  return {
    observedDamCount: r.observedDamCount,
    storageM3: r.storageM3,
    activeCapacityM3: r.activeCapacityM3,
  };
}

/** 貯水率 [0..1], or null when the cohort is empty. */
export function storageRate(t: StorageTotals | undefined): number | null {
  if (!t?.storageM3 || !t.activeCapacityM3) return null;
  const storage = Number(t.storageM3);
  const capacity = Number(t.activeCapacityM3);
  if (!Number.isFinite(storage) || !Number.isFinite(capacity) || capacity <= 0) return null;
  return storage / capacity;
}
