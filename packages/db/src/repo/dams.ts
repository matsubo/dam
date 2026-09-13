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
  /** When set, restrict to dams whose latest non-synthetic observation in
   * the last 30 days came from this source_id. Useful for /api/v1/dams?source=tokyo-waterworks. */
  source?: string | null;
  /** When true, restrict to dams with at least one non-synthetic observation in last 30 days. */
  realDataOnly?: boolean;
}

export interface DamListItem {
  id: bigint;
  slug: string;
  name: string;
  prefCode: string;
  manager: string | null;
  totalCapacityM3: string | null;
  /** 有効貯水容量 — the static 貯水率 denominator. Null when ダム便覧 lists none. */
  activeCapacityM3: string | null;
  watershedSlug: string | null;
  watershedName: string | null;
  lat: number;
  lng: number;
  imageUrl: string | null;
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
        d.active_capacity_m3::TEXT AS "activeCapacityM3",
        w.slug AS "watershedSlug", w.name AS "watershedName",
        ST_Y(d.location::geometry) AS lat, ST_X(d.location::geometry) AS lng,
        d.image_url AS "imageUrl"
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
  const realOnly = f.realDataOnly === true;
  const source = f.source ?? null;
  const rows = await sql<DamListItem[]>`
    SELECT
      d.id, d.slug, d.name, d.pref_code AS "prefCode", d.manager,
      d.total_capacity_m3::TEXT AS "totalCapacityM3",
      d.active_capacity_m3::TEXT AS "activeCapacityM3",
      w.slug AS "watershedSlug", w.name AS "watershedName",
      ST_Y(d.location::geometry) AS lat, ST_X(d.location::geometry) AS lng,
      d.image_url AS "imageUrl"
    FROM dams d
    LEFT JOIN watersheds w ON w.id = d.watershed_id
    WHERE (${f.pref ?? null}::text IS NULL OR d.pref_code = ${f.pref ?? null})
      AND (${f.watershedSlug ?? null}::text IS NULL OR w.slug = ${f.watershedSlug ?? null})
      AND (${f.manager ?? null}::text IS NULL OR d.manager = ${f.manager ?? null})
      AND (${f.search ?? null}::text IS NULL OR d.name ILIKE ('%' || ${f.search ?? null} || '%'))
      AND (${f.cursor ?? null}::bigint IS NULL OR d.id > ${f.cursor ?? null})
      AND (NOT ${realOnly}::boolean OR EXISTS (
        SELECT 1 FROM observations o
        WHERE o.dam_id = d.id
          AND o.source_id <> 'synthetic'
          AND o.observed_at > NOW() - INTERVAL '30 days'
      ))
      AND (${source}::text IS NULL OR EXISTS (
        SELECT 1 FROM observations o
        WHERE o.dam_id = d.id
          AND o.source_id = ${source}
          AND o.observed_at > NOW() - INTERVAL '30 days'
      ))
    ORDER BY d.id
    LIMIT ${limit + 1}
  `;
  const items = rows.slice(0, limit);
  const nextCursor = rows.length > limit ? (items[items.length - 1]?.id ?? null) : null;
  return { items, nextCursor };
}

export interface DamPagedFilters {
  pref?: string | null;
  watershedSlug?: string | null;
  manager?: string | null;
  search?: string | null;
  /**
   * When true, restrict to dams with at least one non-synthetic observation
   * in the last 30 days. Used by the /dams?real=1 view and by the homepage
   * "実測データ" stat link.
   */
  realDataOnly?: boolean;
  /** 1-based. Out-of-range values clamp to [1, totalPages]. */
  page?: number;
  pageSize?: number;
}

/**
 * Page-based variant of listDams used by the /dams browse UI. Cursor mode
 * (listDams) is fine for cheap API access but the human-facing list wants
 * "page 12 of 55"–style navigation, which needs OFFSET + total COUNT.
 */
export async function listDamsPaged(f: DamPagedFilters): Promise<{
  items: DamListItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}> {
  const pageSize = Math.max(1, Math.min(200, f.pageSize ?? 50));
  const requestedPage = Math.max(1, Math.floor(f.page ?? 1));
  const realOnly = f.realDataOnly === true;
  const totalRows = await sql<{ total: bigint }[]>`
    SELECT COUNT(*)::BIGINT AS total
    FROM dams d
    LEFT JOIN watersheds w ON w.id = d.watershed_id
    WHERE (${f.pref ?? null}::text IS NULL OR d.pref_code = ${f.pref ?? null})
      AND (${f.watershedSlug ?? null}::text IS NULL OR w.slug = ${f.watershedSlug ?? null})
      AND (${f.manager ?? null}::text IS NULL OR d.manager = ${f.manager ?? null})
      AND (${f.search ?? null}::text IS NULL OR d.name ILIKE ('%' || ${f.search ?? null} || '%'))
      AND (NOT ${realOnly}::boolean OR EXISTS (
        SELECT 1 FROM observations o
        WHERE o.dam_id = d.id
          AND o.source_id <> 'synthetic'
          AND o.observed_at > NOW() - INTERVAL '30 days'
      ))
  `;
  const total = Number(totalRows[0]?.total ?? 0n);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(totalPages, requestedPage);
  const offset = (page - 1) * pageSize;
  const items = await sql<DamListItem[]>`
    SELECT
      d.id, d.slug, d.name, d.pref_code AS "prefCode", d.manager,
      d.total_capacity_m3::TEXT AS "totalCapacityM3",
      d.active_capacity_m3::TEXT AS "activeCapacityM3",
      w.slug AS "watershedSlug", w.name AS "watershedName",
      ST_Y(d.location::geometry) AS lat, ST_X(d.location::geometry) AS lng,
      d.image_url AS "imageUrl"
    FROM dams d
    LEFT JOIN watersheds w ON w.id = d.watershed_id
    WHERE (${f.pref ?? null}::text IS NULL OR d.pref_code = ${f.pref ?? null})
      AND (${f.watershedSlug ?? null}::text IS NULL OR w.slug = ${f.watershedSlug ?? null})
      AND (${f.manager ?? null}::text IS NULL OR d.manager = ${f.manager ?? null})
      AND (${f.search ?? null}::text IS NULL OR d.name ILIKE ('%' || ${f.search ?? null} || '%'))
      AND (NOT ${realOnly}::boolean OR EXISTS (
        SELECT 1 FROM observations o
        WHERE o.dam_id = d.id
          AND o.source_id <> 'synthetic'
          AND o.observed_at > NOW() - INTERVAL '30 days'
      ))
    ORDER BY d.id
    LIMIT ${pageSize} OFFSET ${offset}
  `;
  return { items, total, page, pageSize, totalPages };
}

export interface DamDetail extends DamListItem {
  nameKana: string | null;
  type: string | null;
  heightM: string | null;
  effectiveCapacityM3: string | null;
  floodCapacityM3: string | null;
  /** Additional master attributes from Damnet ダム便覧. All nullable. */
  constructionStartYear: number | null;
  purposes: string | null;
  crestLengthM: string | null;
  embankmentVolumeM3: string | null;
  watershedAreaKm2: string | null;
  reservoirAreaKm2: string | null;
  leftBankLocation: string | null;
  mainContractor: string | null;
  redevelopmentStatus: string | null;
  completedYear: number | null;
  externalIds: Record<string, string>;
  /** Sea-level elevation (m) backfilled from GSI's DEM API. May be null. */
  elevationM: number | null;
}

/**
 * Partial-match search across dam name + kana. Case-insensitive.
 * Limits to `limit` rows; ranks by total_capacity_m3 (largest first) so the
 * most-significant matches surface first.
 */
export async function searchDams(query: string, limit = 30): Promise<DamListItem[]> {
  const q = query.trim();
  if (q.length === 0) return [];
  const like = `%${q}%`;
  return sql<DamListItem[]>`
    SELECT
      d.id, d.slug, d.name, d.pref_code AS "prefCode", d.manager,
      d.total_capacity_m3::TEXT AS "totalCapacityM3",
      d.active_capacity_m3::TEXT AS "activeCapacityM3",
      w.slug AS "watershedSlug", w.name AS "watershedName",
      ST_Y(d.location::geometry) AS lat, ST_X(d.location::geometry) AS lng,
      d.image_url AS "imageUrl"
    FROM dams d
    LEFT JOIN watersheds w ON w.id = d.watershed_id
    WHERE d.name      ILIKE ${like}
       OR d.name_kana ILIKE ${like}
       OR d.slug      ILIKE ${like}
    ORDER BY
      -- exact-name match first, then prefix, then anything else, then by size
      (d.name = ${q}) DESC,
      (d.name ILIKE ${`${q}%`}) DESC,
      d.total_capacity_m3 DESC NULLS LAST,
      d.id
    LIMIT ${limit}
  `;
}

export async function findDamBySlug(slug: string): Promise<DamDetail | null> {
  const rows = await sql<DamDetail[]>`
    SELECT
      d.id, d.slug, d.name, d.name_kana AS "nameKana",
      d.pref_code AS "prefCode", d.manager, d.type,
      -- height_m carries -9999 sentinels for "unknown" in some NDI rows;
      -- nullify those at the source so the UI can format cleanly.
      NULLIF(d.height_m, -9999)::TEXT AS "heightM",
      d.elevation_m::FLOAT8 AS "elevationM",
      d.total_capacity_m3::TEXT AS "totalCapacityM3",
      d.effective_capacity_m3::TEXT AS "effectiveCapacityM3",
      d.active_capacity_m3::TEXT AS "activeCapacityM3",
      d.construction_start_year AS "constructionStartYear",
      d.purposes AS "purposes",
      d.crest_length_m::TEXT AS "crestLengthM",
      d.embankment_volume_m3::TEXT AS "embankmentVolumeM3",
      d.watershed_area_km2::TEXT AS "watershedAreaKm2",
      d.reservoir_area_km2::TEXT AS "reservoirAreaKm2",
      d.left_bank_location AS "leftBankLocation",
      d.main_contractor AS "mainContractor",
      d.redevelopment_status AS "redevelopmentStatus",
      d.flood_capacity_m3::TEXT AS "floodCapacityM3",
      d.completed_year AS "completedYear",
      d.external_ids AS "externalIds",
      w.slug AS "watershedSlug", w.name AS "watershedName",
      ST_Y(d.location::geometry) AS lat, ST_X(d.location::geometry) AS lng,
      d.image_url AS "imageUrl"
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
  /**
   * Capacity to use as the 貯水率 denominator for THIS observation: the dam's
   * static active_capacity_m3, unless this row's source_id is a
   * trusted_rate_basis source with its own storage_rate, in which case it's
   * back-solved (volume/rate) from that trusted, season-aware rate. See
   * issue #17 — dams like 八田原ダム operate under a much smaller 洪水期
   * capacity than the static Damnet figure.
   */
  effectiveActiveCapacityM3: string | null;
}

export async function latestObservation(damId: bigint): Promise<LatestObservation | null> {
  const rows = await sql<LatestObservation[]>`
    SELECT
      o.observed_at AS "observedAt",
      o.storage_volume_m3::TEXT AS "storageVolumeM3",
      o.storage_rate::TEXT AS "storageRate",
      o.inflow_m3s::TEXT AS "inflowM3s",
      o.outflow_m3s::TEXT AS "outflowM3s",
      o.water_level_m::TEXT AS "waterLevelM",
      o.rainfall_mm::TEXT AS "rainfallMm",
      o.quality_flag AS "qualityFlag",
      o.source_id AS "sourceId",
      effective_active_capacity_m3(
        d.active_capacity_m3, o.storage_volume_m3, o.storage_rate,
        COALESCE(sp.trusted_rate_basis, false)
      )::TEXT AS "effectiveActiveCapacityM3"
    FROM observations o
    JOIN dams d ON d.id = o.dam_id
    LEFT JOIN source_priorities sp ON sp.source_id = o.source_id
    WHERE o.dam_id = ${damId}
      AND o.source_id <> 'synthetic'
    ORDER BY o.observed_at DESC
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export interface StorageChange {
  /** Storage volume at the latest observation (m³, string for bigint safety). */
  current: string | null;
  /** Closest observation at-or-before the lookback timestamp. */
  h1: string | null;
  h6: string | null;
  h12: string | null;
  d1: string | null;
  d7: string | null;
  d30: string | null;
  d365: string | null;
  d1825: string | null;
  /** Actual age in seconds of the chosen reference point (for tooltip). */
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
 * Returns the latest storage_volume plus the closest historical observation
 * at the four lookback windows used by the TradingView-style change %
 * display on the dam page. We pick "the most recent observation at or before
 * NOW() - INTERVAL X" so a sparse observation cadence (e.g. 1/day) still
 * yields a usable comparison.
 */
export async function storageChange(damId: bigint): Promise<StorageChange> {
  // 8 lookback windows. The query picks "the most recent observation at or
  // before NOW() - INTERVAL X" for each, so a 1-hour ingest cadence still
  // resolves the short windows accurately while sparser data degrades
  // gracefully (the StorageChangeStrip flags stale picks visually).
  const rows = await sql<
    {
      current: string | null;
      h1: string | null;
      h6: string | null;
      h12: string | null;
      d1: string | null;
      d7: string | null;
      d30: string | null;
      d365: string | null;
      d1825: string | null;
      currentAt: Date | null;
      h1At: Date | null;
      h6At: Date | null;
      h12At: Date | null;
      d1At: Date | null;
      d7At: Date | null;
      d30At: Date | null;
      d365At: Date | null;
      d1825At: Date | null;
    }[]
  >`
    WITH latest AS (
      SELECT storage_volume_m3, observed_at
      FROM observations
      WHERE dam_id = ${damId} AND storage_volume_m3 IS NOT NULL
      ORDER BY observed_at DESC
      LIMIT 1
    )
    SELECT
      (SELECT storage_volume_m3::TEXT FROM latest) AS current,
      (SELECT observed_at FROM latest)             AS "currentAt",
      (SELECT storage_volume_m3::TEXT FROM observations
        WHERE dam_id = ${damId} AND storage_volume_m3 IS NOT NULL
          AND observed_at <= (SELECT observed_at FROM latest) - INTERVAL '1 hour'
        ORDER BY observed_at DESC LIMIT 1) AS h1,
      (SELECT observed_at FROM observations
        WHERE dam_id = ${damId} AND storage_volume_m3 IS NOT NULL
          AND observed_at <= (SELECT observed_at FROM latest) - INTERVAL '1 hour'
        ORDER BY observed_at DESC LIMIT 1) AS "h1At",
      (SELECT storage_volume_m3::TEXT FROM observations
        WHERE dam_id = ${damId} AND storage_volume_m3 IS NOT NULL
          AND observed_at <= (SELECT observed_at FROM latest) - INTERVAL '6 hours'
        ORDER BY observed_at DESC LIMIT 1) AS h6,
      (SELECT observed_at FROM observations
        WHERE dam_id = ${damId} AND storage_volume_m3 IS NOT NULL
          AND observed_at <= (SELECT observed_at FROM latest) - INTERVAL '6 hours'
        ORDER BY observed_at DESC LIMIT 1) AS "h6At",
      (SELECT storage_volume_m3::TEXT FROM observations
        WHERE dam_id = ${damId} AND storage_volume_m3 IS NOT NULL
          AND observed_at <= (SELECT observed_at FROM latest) - INTERVAL '12 hours'
        ORDER BY observed_at DESC LIMIT 1) AS h12,
      (SELECT observed_at FROM observations
        WHERE dam_id = ${damId} AND storage_volume_m3 IS NOT NULL
          AND observed_at <= (SELECT observed_at FROM latest) - INTERVAL '12 hours'
        ORDER BY observed_at DESC LIMIT 1) AS "h12At",
      (SELECT storage_volume_m3::TEXT FROM observations
        WHERE dam_id = ${damId} AND storage_volume_m3 IS NOT NULL
          AND observed_at <= (SELECT observed_at FROM latest) - INTERVAL '1 day'
        ORDER BY observed_at DESC LIMIT 1) AS d1,
      (SELECT observed_at FROM observations
        WHERE dam_id = ${damId} AND storage_volume_m3 IS NOT NULL
          AND observed_at <= (SELECT observed_at FROM latest) - INTERVAL '1 day'
        ORDER BY observed_at DESC LIMIT 1) AS "d1At",
      (SELECT storage_volume_m3::TEXT FROM observations
        WHERE dam_id = ${damId} AND storage_volume_m3 IS NOT NULL
          AND observed_at <= (SELECT observed_at FROM latest) - INTERVAL '7 days'
        ORDER BY observed_at DESC LIMIT 1) AS d7,
      (SELECT observed_at FROM observations
        WHERE dam_id = ${damId} AND storage_volume_m3 IS NOT NULL
          AND observed_at <= (SELECT observed_at FROM latest) - INTERVAL '7 days'
        ORDER BY observed_at DESC LIMIT 1) AS "d7At",
      (SELECT storage_volume_m3::TEXT FROM observations
        WHERE dam_id = ${damId} AND storage_volume_m3 IS NOT NULL
          AND observed_at <= (SELECT observed_at FROM latest) - INTERVAL '30 days'
        ORDER BY observed_at DESC LIMIT 1) AS d30,
      (SELECT observed_at FROM observations
        WHERE dam_id = ${damId} AND storage_volume_m3 IS NOT NULL
          AND observed_at <= (SELECT observed_at FROM latest) - INTERVAL '30 days'
        ORDER BY observed_at DESC LIMIT 1) AS "d30At",
      (SELECT storage_volume_m3::TEXT FROM observations
        WHERE dam_id = ${damId} AND storage_volume_m3 IS NOT NULL
          AND observed_at <= (SELECT observed_at FROM latest) - INTERVAL '365 days'
        ORDER BY observed_at DESC LIMIT 1) AS d365,
      (SELECT observed_at FROM observations
        WHERE dam_id = ${damId} AND storage_volume_m3 IS NOT NULL
          AND observed_at <= (SELECT observed_at FROM latest) - INTERVAL '365 days'
        ORDER BY observed_at DESC LIMIT 1) AS "d365At",
      (SELECT storage_volume_m3::TEXT FROM observations
        WHERE dam_id = ${damId} AND storage_volume_m3 IS NOT NULL
          AND observed_at <= (SELECT observed_at FROM latest) - INTERVAL '1825 days'
        ORDER BY observed_at DESC LIMIT 1) AS d1825,
      (SELECT observed_at FROM observations
        WHERE dam_id = ${damId} AND storage_volume_m3 IS NOT NULL
          AND observed_at <= (SELECT observed_at FROM latest) - INTERVAL '1825 days'
        ORDER BY observed_at DESC LIMIT 1) AS "d1825At"
  `;
  const r = rows[0];
  if (!r) {
    return {
      current: null,
      h1: null,
      h6: null,
      h12: null,
      d1: null,
      d7: null,
      d30: null,
      d365: null,
      d1825: null,
      h1AgeS: null,
      h6AgeS: null,
      h12AgeS: null,
      d1AgeS: null,
      d7AgeS: null,
      d30AgeS: null,
      d365AgeS: null,
      d1825AgeS: null,
    };
  }
  const ageS = (a: Date | null, b: Date | null): number | null =>
    a && b ? Math.round((a.getTime() - b.getTime()) / 1000) : null;
  return {
    current: r.current,
    h1: r.h1,
    h6: r.h6,
    h12: r.h12,
    d1: r.d1,
    d7: r.d7,
    d30: r.d30,
    d365: r.d365,
    d1825: r.d1825,
    h1AgeS: ageS(r.currentAt, r.h1At),
    h6AgeS: ageS(r.currentAt, r.h6At),
    h12AgeS: ageS(r.currentAt, r.h12At),
    d1AgeS: ageS(r.currentAt, r.d1At),
    d7AgeS: ageS(r.currentAt, r.d7At),
    d30AgeS: ageS(r.currentAt, r.d30At),
    d365AgeS: ageS(r.currentAt, r.d365At),
    d1825AgeS: ageS(r.currentAt, r.d1825At),
  };
}

export interface NearbyDam extends DamListItem {
  /** Great-circle distance from the source dam, in metres. */
  distanceM: number;
  /** Bearing from the source dam, radians clockwise from north (0=N, π/2=E). */
  bearingRad: number;
  /** Latest storage_volume_m3 across any source. NULL when no observations exist. */
  latestStorageM3: string | null;
  /** Same denominator as LatestObservation.effectiveActiveCapacityM3 — prefers
   *  a trusted, season-aware native rate over the static activeCapacityM3. */
  effectiveActiveCapacityM3: string | null;
}

export async function nearbyDams(
  damId: bigint,
  radiusM: number,
  limit: number,
): Promise<NearbyDam[]> {
  return sql<NearbyDam[]>`
    SELECT
      d2.id, d2.slug, d2.name, d2.pref_code AS "prefCode", d2.manager,
      d2.total_capacity_m3::TEXT  AS "totalCapacityM3",
      d2.active_capacity_m3::TEXT AS "activeCapacityM3",
      w.slug AS "watershedSlug", w.name AS "watershedName",
      ST_Y(d2.location::geometry) AS lat, ST_X(d2.location::geometry) AS lng,
      ST_Distance(d.location, d2.location)::FLOAT8                    AS "distanceM",
      ST_Azimuth(d.location::geometry, d2.location::geometry)::FLOAT8 AS "bearingRad",
      latest.storage_volume_m3::TEXT AS "latestStorageM3",
      effective_active_capacity_m3(
        d2.active_capacity_m3, latest.storage_volume_m3, latest.storage_rate,
        COALESCE(sp.trusted_rate_basis, false)
      )::TEXT AS "effectiveActiveCapacityM3"
    FROM dams d
    JOIN dams d2 ON d2.id <> d.id AND ST_DWithin(d.location, d2.location, ${radiusM})
    LEFT JOIN watersheds w ON w.id = d2.watershed_id
    LEFT JOIN LATERAL (
      SELECT o.storage_volume_m3, o.storage_rate, o.source_id
      FROM observations o
      WHERE o.dam_id = d2.id AND o.storage_volume_m3 IS NOT NULL
      ORDER BY o.observed_at DESC
      LIMIT 1
    ) latest ON TRUE
    LEFT JOIN source_priorities sp ON sp.source_id = latest.source_id
    WHERE d.id = ${damId}
    ORDER BY d.location <-> d2.location
    LIMIT ${limit}
  `;
}

/**
 * Latest storage rate per dam id, keyed by `id.toString()` so the result is
 * JSON-safe. rate ∈ [0, 1] when a capacity + 観測値 are both present, null
 * otherwise. LATERAL DISTINCT-ON keeps this cheap even for ~200 ids.
 */
export interface LatestRateAndSource {
  rate: number | null;
  /** source_id of the latest non-synthetic observation in the last 30 days, or null. */
  realSourceId: string | null;
}

/** Variant of latestRateByDam that also returns the latest non-synthetic
 * source_id (within the last 30 days) so the dam list can show a "実測" dot.
 * Same query cost as the plain version + one extra LATERAL join. */
export async function latestRateAndSourceByDam(
  damIds: bigint[],
): Promise<Map<string, LatestRateAndSource>> {
  if (damIds.length === 0) return new Map();
  const ids = damIds.map((id) => id.toString());
  const rows = await sql<{ damId: string; rate: number | null; realSourceId: string | null }[]>`
    SELECT
      d.id::TEXT AS "damId",
      CASE
        WHEN eff_cap.value IS NULL OR eff_cap.value <= 0 THEN NULL
        WHEN latest.storage_volume_m3 IS NULL THEN NULL
        ELSE LEAST(1.0, latest.storage_volume_m3::FLOAT8 / eff_cap.value::FLOAT8)
      END               AS rate,
      real_src.source_id AS "realSourceId"
    FROM dams d
    LEFT JOIN LATERAL (
      SELECT o.storage_volume_m3, o.storage_rate, o.source_id
      FROM observations o
      WHERE o.dam_id = d.id AND o.storage_volume_m3 IS NOT NULL
      ORDER BY o.observed_at DESC
      LIMIT 1
    ) latest ON TRUE
    LEFT JOIN source_priorities sp ON sp.source_id = latest.source_id
    LEFT JOIN LATERAL (
      SELECT effective_active_capacity_m3(
        d.active_capacity_m3, latest.storage_volume_m3, latest.storage_rate,
        COALESCE(sp.trusted_rate_basis, false)
      ) AS value
    ) eff_cap ON TRUE
    LEFT JOIN LATERAL (
      SELECT o.source_id
      FROM observations o
      WHERE o.dam_id = d.id
        AND o.source_id <> 'synthetic'
        AND o.observed_at > NOW() - INTERVAL '30 days'
      ORDER BY o.observed_at DESC
      LIMIT 1
    ) real_src ON TRUE
    WHERE d.id::TEXT = ANY(${ids}::TEXT[])
  `;
  const m = new Map<string, LatestRateAndSource>();
  for (const r of rows) m.set(r.damId, { rate: r.rate, realSourceId: r.realSourceId });
  return m;
}

export async function latestRateByDam(damIds: bigint[]): Promise<Map<string, number | null>> {
  if (damIds.length === 0) return new Map();
  const ids = damIds.map((id) => id.toString());
  const rows = await sql<{ damId: string; rate: number | null }[]>`
    SELECT
      d.id::TEXT AS "damId",
      CASE
        WHEN eff_cap.value IS NULL OR eff_cap.value <= 0 THEN NULL
        WHEN latest.storage_volume_m3 IS NULL THEN NULL
        ELSE LEAST(1.0, latest.storage_volume_m3::FLOAT8 / eff_cap.value::FLOAT8)
      END AS rate
    FROM dams d
    LEFT JOIN LATERAL (
      SELECT o.storage_volume_m3, o.storage_rate, o.source_id
      FROM observations o
      WHERE o.dam_id = d.id AND o.storage_volume_m3 IS NOT NULL
      ORDER BY o.observed_at DESC
      LIMIT 1
    ) latest ON TRUE
    LEFT JOIN source_priorities sp ON sp.source_id = latest.source_id
    LEFT JOIN LATERAL (
      SELECT effective_active_capacity_m3(
        d.active_capacity_m3, latest.storage_volume_m3, latest.storage_rate,
        COALESCE(sp.trusted_rate_basis, false)
      ) AS value
    ) eff_cap ON TRUE
    WHERE d.id::TEXT = ANY(${ids}::TEXT[])
  `;
  const m = new Map<string, number | null>();
  for (const r of rows) m.set(r.damId, r.rate);
  return m;
}

export interface LowStorageDam {
  id: string;
  name: string;
  slug: string;
  prefCode: string;
  watershedSlug: string | null;
  watershedName: string | null;
  rate: number;
  storageVolumeM3: string;
  observedAt: string;
  sourceId: string;
}

/**
 * Dams whose latest real (non-synthetic) observation has 貯水率 below
 * `thresholdPct`. Uses the same trust-aware denominator as
 * `latestRateByDam` — dividing by the static `active_capacity_m3` here put
 * dams on the drought list at 11 % while their own page, which honours the
 * source's season-aware rate, showed 100 % (issue #38 §2-2). Synthetic seeds
 * are excluded — we only want to alert on genuinely measured low storage,
 * not on the placeholder data.
 *
 * Returns at most `limit` rows ordered by rate ascending (worst first).
 */
export async function lowStorageDams(
  thresholdPct: number,
  limit: number,
): Promise<LowStorageDam[]> {
  return sql<LowStorageDam[]>`
    SELECT
      d.id::TEXT                                     AS id,
      d.name,
      d.slug,
      d.pref_code                                    AS "prefCode",
      w.slug                                         AS "watershedSlug",
      w.name                                         AS "watershedName",
      LEAST(1.0, latest.storage_volume_m3::FLOAT8 / eff_cap.value::FLOAT8) AS rate,
      latest.storage_volume_m3::TEXT                 AS "storageVolumeM3",
      latest.observed_at::TEXT                       AS "observedAt",
      latest.source_id                               AS "sourceId"
    FROM dams d
    LEFT JOIN watersheds w ON w.id = d.watershed_id
    JOIN LATERAL (
      SELECT o.storage_volume_m3, o.storage_rate, o.observed_at, o.source_id
      FROM observations o
      WHERE o.dam_id = d.id
        AND o.storage_volume_m3 IS NOT NULL
        AND o.source_id <> 'synthetic'
        AND o.observed_at > NOW() - INTERVAL '30 days'
      ORDER BY o.observed_at DESC
      LIMIT 1
    ) latest ON TRUE
    LEFT JOIN source_priorities sp ON sp.source_id = latest.source_id
    LEFT JOIN LATERAL (
      SELECT effective_active_capacity_m3(
        d.active_capacity_m3, latest.storage_volume_m3, latest.storage_rate,
        COALESCE(sp.trusted_rate_basis, false)
      ) AS value
    ) eff_cap ON TRUE
    WHERE eff_cap.value IS NOT NULL
      AND eff_cap.value > 0
      AND (latest.storage_volume_m3::FLOAT8 / eff_cap.value::FLOAT8)
          < ${thresholdPct / 100.0}
    ORDER BY rate ASC
    LIMIT ${limit}
  `;
}
