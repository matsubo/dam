import { sql } from '../client.ts';

export interface UpsertDamInput {
  slug: string;
  name: string;
  nameKana?: string | null;
  prefCode: string;
  watershedId?: bigint | null;
  riverId?: bigint | null;
  manager?: string | null;
  type?: string | null;
  heightM?: number | null;
  totalCapacityM3?: number | null;
  effectiveCapacityM3?: number | null;
  floodCapacityM3?: number | null;
  completedYear?: number | null;
  lat: number;
  lng: number;
  externalIds: Record<string, string>; // e.g. { ndi: 'W01-12345' }
}

export async function upsertDamByExternalId(
  source: 'ndi' | 'damnet',
  input: UpsertDamInput,
): Promise<bigint> {
  // Two near-identical statements differing only in the conflict target.
  if (source === 'ndi') {
    return upsertDamByNdi(input);
  }
  return upsertDamByDamnet(input);
}

async function upsertDamByNdi(input: UpsertDamInput): Promise<bigint> {
  const rows = await sql<{ id: bigint }[]>`
    INSERT INTO dams (
      slug, name, name_kana, pref_code, watershed_id, river_id, manager, type,
      height_m, total_capacity_m3, effective_capacity_m3, flood_capacity_m3,
      completed_year, location, external_ids
    )
    VALUES (
      ${input.slug}, ${input.name}, ${input.nameKana ?? null}, ${input.prefCode},
      ${input.watershedId ?? null}, ${input.riverId ?? null},
      ${input.manager ?? null}, ${input.type ?? null},
      ${input.heightM ?? null}, ${input.totalCapacityM3 ?? null},
      ${input.effectiveCapacityM3 ?? null}, ${input.floodCapacityM3 ?? null},
      ${input.completedYear ?? null},
      ST_SetSRID(ST_MakePoint(${input.lng}, ${input.lat}), 4326)::geography,
      ${sql.json(input.externalIds)}::jsonb
    )
    ON CONFLICT ((external_ids ->> 'ndi')) WHERE external_ids ? 'ndi'
    DO UPDATE SET
      name              = EXCLUDED.name,
      pref_code         = EXCLUDED.pref_code,
      watershed_id      = COALESCE(EXCLUDED.watershed_id, dams.watershed_id),
      external_ids      = dams.external_ids || EXCLUDED.external_ids,
      location          = EXCLUDED.location
    RETURNING id
  `;
  const row = rows[0];
  if (!row) throw new Error('upsertDamByNdi returned no row');
  return row.id;
}

async function upsertDamByDamnet(input: UpsertDamInput): Promise<bigint> {
  const rows = await sql<{ id: bigint }[]>`
    INSERT INTO dams (
      slug, name, name_kana, pref_code, watershed_id, river_id, manager, type,
      height_m, total_capacity_m3, effective_capacity_m3, flood_capacity_m3,
      completed_year, location, external_ids
    )
    VALUES (
      ${input.slug}, ${input.name}, ${input.nameKana ?? null}, ${input.prefCode},
      ${input.watershedId ?? null}, ${input.riverId ?? null},
      ${input.manager ?? null}, ${input.type ?? null},
      ${input.heightM ?? null}, ${input.totalCapacityM3 ?? null},
      ${input.effectiveCapacityM3 ?? null}, ${input.floodCapacityM3 ?? null},
      ${input.completedYear ?? null},
      ST_SetSRID(ST_MakePoint(${input.lng}, ${input.lat}), 4326)::geography,
      ${sql.json(input.externalIds)}::jsonb
    )
    ON CONFLICT ((external_ids ->> 'damnet')) WHERE external_ids ? 'damnet'
    DO UPDATE SET
      name              = EXCLUDED.name,
      external_ids      = dams.external_ids || EXCLUDED.external_ids
    RETURNING id
  `;
  const row = rows[0];
  if (!row) throw new Error('upsertDamByDamnet returned no row');
  return row.id;
}

export async function takenSlugs(prefix: string): Promise<Set<string>> {
  const rows = await sql<{ slug: string }[]>`
    SELECT slug FROM dams WHERE slug LIKE ${`${prefix}%`}
  `;
  return new Set(rows.map((r) => r.slug));
}

export interface DamRow {
  id: bigint;
  slug: string;
  name: string;
  prefCode: string;
  manager: string | null;
  watershedId: bigint | null;
  externalIds: Record<string, string>;
  lat: number;
  lng: number;
}

export async function findDamsForReconciliation(opts: {
  pref?: string;
  centerLat?: number;
  centerLng?: number;
  radiusM?: number;
  limit?: number;
}): Promise<DamRow[]> {
  const limit = opts.limit ?? 50;
  if (opts.centerLat !== undefined && opts.centerLng !== undefined && opts.radiusM) {
    return sql<DamRow[]>`
      SELECT id, slug, name, pref_code AS "prefCode", manager,
             watershed_id AS "watershedId", external_ids AS "externalIds",
             ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng
      FROM dams
      WHERE ST_DWithin(
              location,
              ST_SetSRID(ST_MakePoint(${opts.centerLng}, ${opts.centerLat}), 4326)::geography,
              ${opts.radiusM})
        AND (${opts.pref ?? null}::text IS NULL OR pref_code = ${opts.pref ?? null})
      LIMIT ${limit}
    `;
  }
  return sql<DamRow[]>`
    SELECT id, slug, name, pref_code AS "prefCode", manager,
           watershed_id AS "watershedId", external_ids AS "externalIds",
           ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng
    FROM dams
    WHERE (${opts.pref ?? null}::text IS NULL OR pref_code = ${opts.pref ?? null})
    LIMIT ${limit}
  `;
}

export async function appendExternalId(
  damId: bigint,
  source: string,
  externalId: string,
): Promise<void> {
  await sql`
    UPDATE dams
    SET external_ids = external_ids || jsonb_build_object(${source}::text, ${externalId}::text)
    WHERE id = ${damId}
  `;
}

export async function applyDamnetAttributes(
  damId: bigint,
  attrs: {
    nameKana?: string | null;
    type?: string | null;
    heightM?: number | null;
    totalCapacityM3?: number | null;
    effectiveCapacityM3?: number | null;
    floodCapacityM3?: number | null;
    completedYear?: number | null;
    manager?: string | null;
  },
): Promise<void> {
  await sql`
    UPDATE dams SET
      name_kana             = COALESCE(${attrs.nameKana ?? null}, name_kana),
      type                  = COALESCE(${attrs.type ?? null}, type),
      height_m              = COALESCE(${attrs.heightM ?? null}, height_m),
      total_capacity_m3     = COALESCE(${attrs.totalCapacityM3 ?? null}, total_capacity_m3),
      effective_capacity_m3 = COALESCE(${attrs.effectiveCapacityM3 ?? null}, effective_capacity_m3),
      flood_capacity_m3     = COALESCE(${attrs.floodCapacityM3 ?? null}, flood_capacity_m3),
      completed_year        = COALESCE(${attrs.completedYear ?? null}, completed_year),
      manager               = COALESCE(${attrs.manager ?? null}, manager)
    WHERE id = ${damId}
  `;
}

export interface DamListFilters {
  pref?: string | null;
  watershedSlug?: string | null;
  manager?: string | null;
  search?: string | null;
  cursor?: bigint | null;
  pageSize?: number;
  /** Default: 'id'. Use 'capacity' for "largest first" ordering on the home page. */
  orderBy?: 'id' | 'capacity';
}

export interface DamListItem {
  id: bigint;
  slug: string;
  name: string;
  prefCode: string;
  manager: string | null;
  totalCapacityM3: string | null;
  watershedSlug: string | null;
  watershedName: string | null;
  lat: number;
  lng: number;
}

export async function listDams(
  f: DamListFilters,
): Promise<{ items: DamListItem[]; nextCursor: bigint | null }> {
  const limit = Math.max(1, Math.min(200, f.pageSize ?? 50));
  // 'capacity' orders by largest first; cursor pagination is disabled in
  // that mode (the home page only ever asks for the top N).
  if (f.orderBy === 'capacity') {
    const rows = await sql<DamListItem[]>`
      SELECT
        d.id, d.slug, d.name, d.pref_code AS "prefCode", d.manager,
        d.total_capacity_m3::TEXT AS "totalCapacityM3",
        w.slug AS "watershedSlug", w.name AS "watershedName",
        ST_Y(d.location::geometry) AS lat, ST_X(d.location::geometry) AS lng
      FROM dams d
      LEFT JOIN watersheds w ON w.id = d.watershed_id
      WHERE (${f.pref ?? null}::text IS NULL OR d.pref_code = ${f.pref ?? null})
        AND (${f.watershedSlug ?? null}::text IS NULL OR w.slug = ${f.watershedSlug ?? null})
        AND (${f.manager ?? null}::text IS NULL OR d.manager = ${f.manager ?? null})
        AND (${f.search ?? null}::text IS NULL OR d.name ILIKE ('%' || ${f.search ?? null} || '%'))
        AND d.total_capacity_m3 IS NOT NULL
      ORDER BY d.total_capacity_m3 DESC NULLS LAST, d.id
      LIMIT ${limit}
    `;
    return { items: rows, nextCursor: null };
  }
  const rows = await sql<DamListItem[]>`
    SELECT
      d.id, d.slug, d.name, d.pref_code AS "prefCode", d.manager,
      d.total_capacity_m3::TEXT AS "totalCapacityM3",
      w.slug AS "watershedSlug", w.name AS "watershedName",
      ST_Y(d.location::geometry) AS lat, ST_X(d.location::geometry) AS lng
    FROM dams d
    LEFT JOIN watersheds w ON w.id = d.watershed_id
    WHERE (${f.pref ?? null}::text IS NULL OR d.pref_code = ${f.pref ?? null})
      AND (${f.watershedSlug ?? null}::text IS NULL OR w.slug = ${f.watershedSlug ?? null})
      AND (${f.manager ?? null}::text IS NULL OR d.manager = ${f.manager ?? null})
      AND (${f.search ?? null}::text IS NULL OR d.name ILIKE ('%' || ${f.search ?? null} || '%'))
      AND (${f.cursor ?? null}::bigint IS NULL OR d.id > ${f.cursor ?? null})
    ORDER BY d.id
    LIMIT ${limit + 1}
  `;
  const items = rows.slice(0, limit);
  const nextCursor = rows.length > limit ? (items[items.length - 1]?.id ?? null) : null;
  return { items, nextCursor };
}

export interface DamDetail extends DamListItem {
  nameKana: string | null;
  type: string | null;
  heightM: string | null;
  effectiveCapacityM3: string | null;
  floodCapacityM3: string | null;
  completedYear: number | null;
  externalIds: Record<string, string>;
}

export async function findDamBySlug(slug: string): Promise<DamDetail | null> {
  const rows = await sql<DamDetail[]>`
    SELECT
      d.id, d.slug, d.name, d.name_kana AS "nameKana",
      d.pref_code AS "prefCode", d.manager, d.type,
      d.height_m::TEXT AS "heightM",
      d.total_capacity_m3::TEXT AS "totalCapacityM3",
      d.effective_capacity_m3::TEXT AS "effectiveCapacityM3",
      d.flood_capacity_m3::TEXT AS "floodCapacityM3",
      d.completed_year AS "completedYear",
      d.external_ids AS "externalIds",
      w.slug AS "watershedSlug", w.name AS "watershedName",
      ST_Y(d.location::geometry) AS lat, ST_X(d.location::geometry) AS lng
    FROM dams d
    LEFT JOIN watersheds w ON w.id = d.watershed_id
    WHERE d.slug = ${slug}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export interface LatestObservation {
  observedAt: Date;
  storageVolumeM3: string | null;
  storageRate: string | null;
  inflowM3s: string | null;
  outflowM3s: string | null;
  waterLevelM: string | null;
  rainfallMm: string | null;
  qualityFlag: number;
  sourceId: string;
}

export async function latestObservation(damId: bigint): Promise<LatestObservation | null> {
  const rows = await sql<LatestObservation[]>`
    SELECT
      observed_at AS "observedAt",
      storage_volume_m3::TEXT AS "storageVolumeM3",
      storage_rate::TEXT AS "storageRate",
      inflow_m3s::TEXT AS "inflowM3s",
      outflow_m3s::TEXT AS "outflowM3s",
      water_level_m::TEXT AS "waterLevelM",
      rainfall_mm::TEXT AS "rainfallMm",
      quality_flag AS "qualityFlag",
      source_id AS "sourceId"
    FROM observations
    WHERE dam_id = ${damId}
    ORDER BY observed_at DESC
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function nearbyDams(
  damId: bigint,
  radiusM: number,
  limit: number,
): Promise<DamListItem[]> {
  return sql<DamListItem[]>`
    SELECT
      d2.id, d2.slug, d2.name, d2.pref_code AS "prefCode", d2.manager,
      d2.total_capacity_m3::TEXT AS "totalCapacityM3",
      w.slug AS "watershedSlug", w.name AS "watershedName",
      ST_Y(d2.location::geometry) AS lat, ST_X(d2.location::geometry) AS lng
    FROM dams d
    JOIN dams d2 ON d2.id <> d.id AND ST_DWithin(d.location, d2.location, ${radiusM})
    LEFT JOIN watersheds w ON w.id = d2.watershed_id
    WHERE d.id = ${damId}
    ORDER BY d.location <-> d2.location
    LIMIT ${limit}
  `;
}
