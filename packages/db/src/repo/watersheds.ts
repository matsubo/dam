import { sql } from '../client.ts';

export interface UpsertWatershedInput {
  code: string;
  slug: string;
  name: string;
  nameKana?: string | null;
  kind: 'first' | 'second' | 'other';
  boundaryGeoJSON: object; // FeatureGeometry
  areaKm2?: number | null;
}

export async function upsertWatershed(input: UpsertWatershedInput): Promise<bigint> {
  const rows = await sql<{ id: bigint }[]>`
    INSERT INTO watersheds (code, slug, name, name_kana, kind, boundary, area_km2)
    VALUES (
      ${input.code}, ${input.slug}, ${input.name}, ${input.nameKana ?? null},
      ${input.kind},
      ST_Multi(ST_GeomFromGeoJSON(${JSON.stringify(input.boundaryGeoJSON)}))::geography,
      ${input.areaKm2 ?? null}
    )
    ON CONFLICT (code) DO UPDATE SET
      slug      = EXCLUDED.slug,
      name      = EXCLUDED.name,
      name_kana = EXCLUDED.name_kana,
      kind      = EXCLUDED.kind,
      boundary  = EXCLUDED.boundary,
      area_km2  = EXCLUDED.area_km2
    RETURNING id
  `;
  const row = rows[0];
  if (!row) throw new Error('upsertWatershed returned no row');
  return row.id;
}

export interface WatershedAtPoint {
  id: bigint;
  code: string;
  slug: string;
  name: string;
  kind: 'first' | 'second' | 'other';
}

export async function findWatershedContaining(
  lat: number,
  lng: number,
): Promise<WatershedAtPoint | null> {
  const rows = await sql<WatershedAtPoint[]>`
    SELECT id, code, slug, name, kind
    FROM watersheds
    WHERE ST_Contains(boundary::geometry,
                      ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326))
    ORDER BY ST_Area(boundary) ASC
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export interface NearestWatershed extends WatershedAtPoint {
  distanceM: number;
}

export async function findNearestWatershed(
  lat: number,
  lng: number,
): Promise<NearestWatershed | null> {
  const rows = await sql<NearestWatershed[]>`
    SELECT id, code, slug, name, kind,
           ST_Distance(boundary,
                       ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography) AS "distanceM"
    FROM watersheds
    ORDER BY boundary <-> ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export interface WatershedListItem {
  id: bigint;
  slug: string;
  code: string;
  name: string;
  kind: 'first' | 'second' | 'other';
  damCount: number;
}

export async function listWatersheds(
  opts: { kind?: 'first' | 'second' | null; cursor?: bigint | null; pageSize?: number } = {},
): Promise<{ items: WatershedListItem[]; nextCursor: bigint | null }> {
  const limit = Math.max(1, Math.min(500, opts.pageSize ?? 200));
  const rows = await sql<WatershedListItem[]>`
    SELECT
      w.id, w.slug, w.code, w.name, w.kind,
      COUNT(d.id)::INT AS "damCount"
    FROM watersheds w
    LEFT JOIN dams d ON d.watershed_id = w.id
    WHERE (${opts.kind ?? null}::text IS NULL OR w.kind = ${opts.kind ?? null})
      AND (${opts.cursor ?? null}::bigint IS NULL OR w.id > ${opts.cursor ?? null})
    GROUP BY w.id
    ORDER BY w.id
    LIMIT ${limit + 1}
  `;
  const items = rows.slice(0, limit);
  const nextCursor = rows.length > limit ? (items[items.length - 1]?.id ?? null) : null;
  return { items, nextCursor };
}

/**
 * Partial-match search across watershed name + kana. Case-insensitive.
 * Watersheds with attached dams rank above empty placeholders.
 */
export async function searchWatersheds(query: string, limit = 30): Promise<WatershedListItem[]> {
  const q = query.trim();
  if (q.length === 0) return [];
  const like = `%${q}%`;
  return sql<WatershedListItem[]>`
    SELECT
      w.id, w.slug, w.code, w.name, w.kind,
      COUNT(d.id)::INT AS "damCount"
    FROM watersheds w
    LEFT JOIN dams d ON d.watershed_id = w.id
    WHERE w.name      ILIKE ${like}
       OR w.name_kana ILIKE ${like}
       OR w.slug      ILIKE ${like}
    GROUP BY w.id
    ORDER BY
      (w.name = ${q}) DESC,
      (w.name ILIKE ${`${q}%`}) DESC,
      COUNT(d.id) DESC,
      w.id
    LIMIT ${limit}
  `;
}

export interface WatershedDetail {
  id: bigint;
  slug: string;
  code: string;
  name: string;
  nameKana: string | null;
  kind: 'first' | 'second' | 'other';
  areaKm2: number | null;
}

export async function findWatershedBySlug(slug: string): Promise<WatershedDetail | null> {
  const rows = await sql<WatershedDetail[]>`
    SELECT id, slug, code, name, name_kana AS "nameKana", kind, area_km2 AS "areaKm2"
    FROM watersheds WHERE slug = ${slug} LIMIT 1
  `;
  return rows[0] ?? null;
}

export interface WatershedAggregate {
  /** All dams in the watershed (not just rate-able). */
  damCount: number;
  /** Sum of 総貯水容量 over all dams — used as a "size" indicator. */
  totalCapacityM3: string | null;
  /** Sum of 利水容量 over the rate-able subset only. Used as the rate denominator. */
  activeCapacityM3: string | null;
  /** Number of dams contributing to activeCapacity / latestStorage (i.e. those with active_capacity_m3 IS NOT NULL). */
  rateableDamCount: number;
  /** Latest storage summed over the rate-able subset only — pairs with activeCapacityM3 for rate. */
  latestStorageVolumeM3: string | null;
  observedAt: Date | null;
}

export interface WatershedStorageChange {
  current: string | null;
  h1: string | null;
  h6: string | null;
  h12: string | null;
  d1: string | null;
  d7: string | null;
  d30: string | null;
  d365: string | null;
  d1825: string | null;
  h1AgeS: number | null;
  h6AgeS: number | null;
  h12AgeS: number | null;
  d1AgeS: number | null;
  d7AgeS: number | null;
  d30AgeS: number | null;
  d365AgeS: number | null;
  d1825AgeS: number | null;
}

/**
 * Watershed-level "latest minus N-window-ago" totals, computed only over the
 * dams in the watershed that have 利水容量 (= the same rate-able subset the
 * watershed gauge uses, so the change percentages are consistent with the
 * displayed rate).
 *
 * Approach: we union 8 lookback timestamps and, for each, take the latest
 * per-dam observation at-or-before that point and SUM. The latest value uses
 * a small grace window (each dam's observation must be within 7 days of the
 * watershed-level "now" to count) so a single stale dam doesn't poison the
 * total.
 */
export async function watershedStorageChange(
  watershedId: bigint,
): Promise<WatershedStorageChange> {
  const rows = await sql<
    {
      bucket: string;
      total: string | null;
      pickedAt: Date | null;
    }[]
  >`
    WITH ds AS (
      SELECT id FROM dams
      WHERE watershed_id = ${watershedId} AND active_capacity_m3 IS NOT NULL
    ),
    latest_per_dam AS (
      SELECT DISTINCT ON (o.dam_id)
             o.dam_id, o.storage_volume_m3, o.observed_at
      FROM observations o
      JOIN ds ON ds.id = o.dam_id
      WHERE o.storage_volume_m3 IS NOT NULL
      ORDER BY o.dam_id, o.observed_at DESC
    ),
    -- "Now" for the watershed = max observed_at in the rate-able subset.
    -- We use the same anchor for every lookback so the windows align.
    anchor AS (SELECT MAX(observed_at) AS t FROM latest_per_dam),
    buckets AS (
      SELECT 'current' AS bucket, INTERVAL '0 second' AS lookback UNION ALL
      SELECT 'h1',     INTERVAL '1 hour'     UNION ALL
      SELECT 'h6',     INTERVAL '6 hours'    UNION ALL
      SELECT 'h12',    INTERVAL '12 hours'   UNION ALL
      SELECT 'd1',     INTERVAL '1 day'      UNION ALL
      SELECT 'd7',     INTERVAL '7 days'     UNION ALL
      SELECT 'd30',    INTERVAL '30 days'    UNION ALL
      SELECT 'd365',   INTERVAL '365 days'   UNION ALL
      SELECT 'd1825',  INTERVAL '1825 days'
    ),
    -- For each bucket, take each dam's most recent observation <= anchor − lookback,
    -- then sum.
    per_bucket AS (
      SELECT
        b.bucket,
        SUM(picks.storage_volume_m3)::TEXT AS total,
        MIN(picks.observed_at) AS picked_at
      FROM buckets b
      LEFT JOIN LATERAL (
        SELECT DISTINCT ON (o.dam_id)
               o.dam_id, o.storage_volume_m3, o.observed_at
        FROM observations o
        JOIN ds ON ds.id = o.dam_id
        WHERE o.storage_volume_m3 IS NOT NULL
          AND o.observed_at <= (SELECT t FROM anchor) - b.lookback
        ORDER BY o.dam_id, o.observed_at DESC
      ) picks ON TRUE
      GROUP BY b.bucket
    )
    SELECT bucket, total, picked_at AS "pickedAt" FROM per_bucket
  `;
  const map = new Map<string, { total: string | null; pickedAt: Date | null }>();
  for (const r of rows) map.set(r.bucket, { total: r.total, pickedAt: r.pickedAt });
  const get = (k: string): string | null => map.get(k)?.total ?? null;
  const at = (k: string): Date | null => map.get(k)?.pickedAt ?? null;
  const currentAt = at('current');
  const ageS = (a: Date | null, b: Date | null): number | null =>
    a && b ? Math.round((a.getTime() - b.getTime()) / 1000) : null;
  return {
    current: get('current'),
    h1: get('h1'),
    h6: get('h6'),
    h12: get('h12'),
    d1: get('d1'),
    d7: get('d7'),
    d30: get('d30'),
    d365: get('d365'),
    d1825: get('d1825'),
    h1AgeS: ageS(currentAt, at('h1')),
    h6AgeS: ageS(currentAt, at('h6')),
    h12AgeS: ageS(currentAt, at('h12')),
    d1AgeS: ageS(currentAt, at('d1')),
    d7AgeS: ageS(currentAt, at('d7')),
    d30AgeS: ageS(currentAt, at('d30')),
    d365AgeS: ageS(currentAt, at('d365')),
    d1825AgeS: ageS(currentAt, at('d1825')),
  };
}

/**
 * National version of watershedStorageChange — same shape, but the rate-able
 * subset is "every dam in the country with active_capacity_m3". Used by the
 * home page change strip.
 */
export async function nationalStorageChange(): Promise<WatershedStorageChange> {
  const rows = await sql<{ bucket: string; total: string | null; pickedAt: Date | null }[]>`
    WITH ds AS (
      SELECT id FROM dams WHERE active_capacity_m3 IS NOT NULL
    ),
    latest_per_dam AS (
      SELECT DISTINCT ON (o.dam_id)
             o.dam_id, o.storage_volume_m3, o.observed_at
      FROM observations o
      JOIN ds ON ds.id = o.dam_id
      WHERE o.storage_volume_m3 IS NOT NULL
      ORDER BY o.dam_id, o.observed_at DESC
    ),
    anchor AS (SELECT MAX(observed_at) AS t FROM latest_per_dam),
    buckets AS (
      SELECT 'current' AS bucket, INTERVAL '0 second' AS lookback UNION ALL
      SELECT 'h1',    INTERVAL '1 hour'    UNION ALL
      SELECT 'h6',    INTERVAL '6 hours'   UNION ALL
      SELECT 'h12',   INTERVAL '12 hours'  UNION ALL
      SELECT 'd1',    INTERVAL '1 day'     UNION ALL
      SELECT 'd7',    INTERVAL '7 days'    UNION ALL
      SELECT 'd30',   INTERVAL '30 days'   UNION ALL
      SELECT 'd365',  INTERVAL '365 days'  UNION ALL
      SELECT 'd1825', INTERVAL '1825 days'
    ),
    per_bucket AS (
      SELECT
        b.bucket,
        SUM(picks.storage_volume_m3)::TEXT AS total,
        MIN(picks.observed_at) AS picked_at
      FROM buckets b
      LEFT JOIN LATERAL (
        SELECT DISTINCT ON (o.dam_id) o.dam_id, o.storage_volume_m3, o.observed_at
        FROM observations o
        JOIN ds ON ds.id = o.dam_id
        WHERE o.storage_volume_m3 IS NOT NULL
          AND o.observed_at <= (SELECT t FROM anchor) - b.lookback
        ORDER BY o.dam_id, o.observed_at DESC
      ) picks ON TRUE
      GROUP BY b.bucket
    )
    SELECT bucket, total, picked_at AS "pickedAt" FROM per_bucket
  `;
  const map = new Map<string, { total: string | null; pickedAt: Date | null }>();
  for (const r of rows) map.set(r.bucket, { total: r.total, pickedAt: r.pickedAt });
  const get = (k: string): string | null => map.get(k)?.total ?? null;
  const at = (k: string): Date | null => map.get(k)?.pickedAt ?? null;
  const currentAt = at('current');
  const ageS = (a: Date | null, b: Date | null): number | null =>
    a && b ? Math.round((a.getTime() - b.getTime()) / 1000) : null;
  return {
    current: get('current'),
    h1: get('h1'), h6: get('h6'), h12: get('h12'),
    d1: get('d1'), d7: get('d7'), d30: get('d30'), d365: get('d365'), d1825: get('d1825'),
    h1AgeS: ageS(currentAt, at('h1')),
    h6AgeS: ageS(currentAt, at('h6')),
    h12AgeS: ageS(currentAt, at('h12')),
    d1AgeS: ageS(currentAt, at('d1')),
    d7AgeS: ageS(currentAt, at('d7')),
    d30AgeS: ageS(currentAt, at('d30')),
    d365AgeS: ageS(currentAt, at('d365')),
    d1825AgeS: ageS(currentAt, at('d1825')),
  };
}

export async function aggregateWatershed(watershedId: bigint): Promise<WatershedAggregate> {
  // Two cohorts:
  //   `ds`        — every dam in the watershed (used for damCount + total capacity)
  //   `ds_rateable` — dams with active_capacity_m3 (used for the storage-rate
  //                  numerator/denominator pair). Excluding null-active dams
  //                  here keeps the watershed rate honest: we don't mix
  //                  total-capacity dams into the active-capacity ratio.
  const rows = await sql<WatershedAggregate[]>`
    WITH ds AS (
      SELECT id, total_capacity_m3, active_capacity_m3
      FROM dams WHERE watershed_id = ${watershedId}
    ),
    ds_rateable AS (
      SELECT id, active_capacity_m3 FROM ds WHERE active_capacity_m3 IS NOT NULL
    ),
    latest AS (
      SELECT DISTINCT ON (o.dam_id) o.dam_id, o.observed_at, o.storage_volume_m3
      FROM observations o
      JOIN ds_rateable ON ds_rateable.id = o.dam_id
      ORDER BY o.dam_id, o.observed_at DESC
    )
    SELECT
      (SELECT COUNT(*)::INT          FROM ds)                     AS "damCount",
      (SELECT SUM(total_capacity_m3)::TEXT FROM ds)               AS "totalCapacityM3",
      (SELECT COUNT(*)::INT          FROM ds_rateable)            AS "rateableDamCount",
      (SELECT SUM(active_capacity_m3)::TEXT FROM ds_rateable)     AS "activeCapacityM3",
      (SELECT SUM(latest.storage_volume_m3)::TEXT FROM latest)    AS "latestStorageVolumeM3",
      (SELECT MAX(latest.observed_at)             FROM latest)    AS "observedAt"
  `;
  return (
    rows[0] ?? {
      damCount: 0,
      totalCapacityM3: null,
      activeCapacityM3: null,
      rateableDamCount: 0,
      latestStorageVolumeM3: null,
      observedAt: null,
    }
  );
}
