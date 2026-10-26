import { sql } from '../client.ts';

/**
 * 全国貯水率 (and its per-prefecture / per-watershed cuts) is computed over the
 * *observed cohort*: dams that have a 有効貯水容量 in the master AND whose
 * reading (dam_reading(), docs/adr/0002) carries a volume within the
 * freshness window. Both sums run over that same cohort — a dam with no fresh
 * reading must not contribute capacity only, which would silently deflate the
 * rate in proportion to our coverage gap rather than report how full the
 * reservoirs are. The denominator is each reading's effective capacity, as on
 * the dam page and in 水系.
 *
 * This module is the single definition of that cohort; the home page and
 * /stats both consume it so the two can no longer drift apart.
 */
export interface StorageTotals {
  /** Dams contributing to both sums. */
  observedDamCount: number;
  /** SUM of the readings' 貯水量, NULL when the cohort is empty. */
  storageM3: string | null;
  /** SUM of the readings' effective capacity over the same cohort, NULL when empty. */
  effectiveCapacityM3: string | null;
}

/** Matches the home page's 7-day window for "current" storage. */
export const DEFAULT_FRESH_DAYS = 7;

const EMPTY: StorageTotals = { observedDamCount: 0, storageM3: null, effectiveCapacityM3: null };

/** The cohort itself: one row per dam, carrying its reading's volume and denominator. */
function cohort(freshDays: number) {
  return sql`
    SELECT
      d.id AS dam_id,
      r.storage_volume_m3,
      r.effective_capacity_m3,
      d.pref_code,
      d.watershed_id
    FROM dams d
    CROSS JOIN LATERAL dam_reading(d.id, TRUE, MAKE_INTERVAL(days => ${freshDays})) r
    WHERE d.active_capacity_m3 IS NOT NULL
  `;
}

export async function nationalStorageTotals(
  freshDays: number = DEFAULT_FRESH_DAYS,
): Promise<StorageTotals> {
  const rows = await sql<StorageTotals[]>`
    WITH fresh AS (${cohort(freshDays)})
    SELECT
      COUNT(*)::INT                    AS "observedDamCount",
      SUM(storage_volume_m3)::TEXT     AS "storageM3",
      SUM(effective_capacity_m3)::TEXT AS "effectiveCapacityM3"
    FROM fresh
  `;
  return rows[0] ?? EMPTY;
}

export async function storageTotalsByPref(
  freshDays: number = DEFAULT_FRESH_DAYS,
): Promise<Map<string, StorageTotals>> {
  const rows = await sql<(StorageTotals & { prefCode: string })[]>`
    WITH fresh AS (${cohort(freshDays)})
    SELECT
      pref_code                        AS "prefCode",
      COUNT(*)::INT                    AS "observedDamCount",
      SUM(storage_volume_m3)::TEXT     AS "storageM3",
      SUM(effective_capacity_m3)::TEXT AS "effectiveCapacityM3"
    FROM fresh
    WHERE pref_code IS NOT NULL
    GROUP BY pref_code
  `;
  return new Map(rows.map(({ prefCode, ...t }) => [prefCode, t]));
}

export async function storageTotalsByWatershed(
  freshDays: number = DEFAULT_FRESH_DAYS,
): Promise<Map<string, StorageTotals>> {
  const rows = await sql<(StorageTotals & { slug: string })[]>`
    WITH fresh AS (${cohort(freshDays)})
    SELECT
      w.slug                             AS "slug",
      COUNT(*)::INT                      AS "observedDamCount",
      SUM(f.storage_volume_m3)::TEXT     AS "storageM3",
      SUM(f.effective_capacity_m3)::TEXT AS "effectiveCapacityM3"
    FROM fresh f
    JOIN watersheds w ON w.id = f.watershed_id
    GROUP BY w.slug
  `;
  return new Map(rows.map(({ slug, ...t }) => [slug, t]));
}

/** 貯水率 [0..1], or null when the cohort is empty. */
export function storageRate(t: StorageTotals | undefined): number | null {
  if (!t?.storageM3 || !t.effectiveCapacityM3) return null;
  const storage = Number(t.storageM3);
  const capacity = Number(t.effectiveCapacityM3);
  if (!Number.isFinite(storage) || !Number.isFinite(capacity) || capacity <= 0) return null;
  return storage / capacity;
}
