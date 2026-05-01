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
    SET external_ids = external_ids || jsonb_build_object(${source}, ${externalId})
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
