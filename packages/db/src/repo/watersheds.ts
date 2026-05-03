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
  damCount: number;
  totalCapacityM3: string | null;
  latestStorageVolumeM3: string | null;
  observedAt: Date | null;
}

export async function aggregateWatershed(watershedId: bigint): Promise<WatershedAggregate> {
  const rows = await sql<WatershedAggregate[]>`
    WITH ds AS (
      SELECT id, total_capacity_m3 FROM dams WHERE watershed_id = ${watershedId}
    ),
    latest AS (
      SELECT DISTINCT ON (o.dam_id) o.dam_id, o.observed_at, o.storage_volume_m3
      FROM observations o
      JOIN ds ON ds.id = o.dam_id
      ORDER BY o.dam_id, o.observed_at DESC
    )
    SELECT
      COUNT(*)::INT                                    AS "damCount",
      SUM(ds.total_capacity_m3)::TEXT                  AS "totalCapacityM3",
      SUM(latest.storage_volume_m3)::TEXT              AS "latestStorageVolumeM3",
      MAX(latest.observed_at)                          AS "observedAt"
    FROM ds
    LEFT JOIN latest ON latest.dam_id = ds.id
  `;
  return (
    rows[0] ?? {
      damCount: 0,
      totalCapacityM3: null,
      latestStorageVolumeM3: null,
      observedAt: null,
    }
  );
}
