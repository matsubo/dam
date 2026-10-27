import { type Db, sql } from '../client.ts';

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
    -- name and location are set on insert only. On an existing row they may
    -- have been corrected since (0186: NDI 1368 is 栗柄 at ダム便覧's point,
    -- W01 still says 西紀 at a point 675 m off the dam); W01 is a 2014
    -- snapshot, so re-importing it must not roll that back. The boot seed
    -- follows the same prod-wins rule (#54).
    ON CONFLICT ((external_ids ->> 'ndi')) WHERE external_ids ? 'ndi'
    DO UPDATE SET
      pref_code         = EXCLUDED.pref_code,
      watershed_id      = COALESCE(EXCLUDED.watershed_id, dams.watershed_id),
      external_ids      = dams.external_ids || EXCLUDED.external_ids
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

/**
 * Record that `source`'s station `key` feeds `damId`, and take the same key off
 * any other row. Ingest tasks used to only add the stamp, so a station that
 * moved to a better row stayed stamped on the old one as well (#57).
 */
export async function bindExternalId(
  damId: bigint,
  source: string,
  key: string,
  db?: Db,
): Promise<void> {
  const run = async (tx: Db): Promise<void> => {
    await tx`
      UPDATE dams SET external_ids = external_ids - ${source}::text
      WHERE external_ids->>${source} = ${key} AND id <> ${damId}
    `;
    await tx`
      UPDATE dams
      SET external_ids = COALESCE(external_ids, '{}'::jsonb) || jsonb_build_object(${source}::text, ${key}::text)
      WHERE id = ${damId} AND COALESCE(external_ids->>${source}, '') <> ${key}
    `;
  };
  if (db) await run(db);
  else await sql.begin(run);
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
  /** When true, restrict to dams with a non-synthetic observation carrying a value in the last 30 days. */
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
          AND observation_has_value(o)
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
   * carrying a value in the last 30 days. Used by the /dams?real=1 view and
   * by the homepage "実測データ" stat link.
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
          AND observation_has_value(o)
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
          AND observation_has_value(o)
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
  /**
   * Whose figure the displayed 貯水率 (storageVolumeM3 ÷
   * effectiveActiveCapacityM3) is. 'published' only when a trusted_rate_basis
   * source supplied the rate itself; any other source, or a rate the trigger
   * derived (quality_flag bit 32), is our volume ÷ 有効貯水容量 — 'computed'.
   * NULL when there is no volume, so no rate is shown (issue #60).
   */
  storageRateOrigin: 'published' | 'computed' | null;
}

export async function latestObservation(damId: bigint): Promise<LatestObservation | null> {
  // The dam's reading (dam_reading(), docs/adr/0002). FALSE: this path shows
  // 水位/流入量/放流量 too, and dams fed only by level-carrying sources have no
  // volume at all (issue #32 review).
  const rows = await sql<LatestObservation[]>`
    SELECT
      r.observed_at AS "observedAt",
      r.storage_volume_m3::TEXT AS "storageVolumeM3",
      r.storage_rate::TEXT AS "storageRate",
      r.inflow_m3s::TEXT AS "inflowM3s",
      r.outflow_m3s::TEXT AS "outflowM3s",
      r.water_level_m::TEXT AS "waterLevelM",
      r.rainfall_mm::TEXT AS "rainfallMm",
      r.quality_flag AS "qualityFlag",
      r.source_id AS "sourceId",
      r.effective_capacity_m3::TEXT AS "effectiveActiveCapacityM3",
      CASE
        WHEN r.storage_volume_m3 IS NULL THEN NULL
        WHEN r.rate_published THEN 'published'
        ELSE 'computed'
      END AS "storageRateOrigin"
    FROM dam_reading(${damId}, FALSE) r
  `;
  return rows[0] ?? null;
}

/**
 * When the dam's displayable history starts — `latestObservation`'s
 * counterpart: every source but 'synthetic', as for the reading. Null when
 * there is none.
 */
export async function earliestObservationAt(damId: bigint): Promise<Date | null> {
  const rows = await sql<{ observedAt: Date }[]>`
    SELECT observed_at AS "observedAt"
    FROM observations
    WHERE dam_id = ${damId} AND source_id <> 'synthetic'
    ORDER BY observed_at ASC
    LIMIT 1
  `;
  return rows[0]?.observedAt ?? null;
}

/**
 * The master carries a rebuilt dam and the structure it replaced as two rows
 * — 佐久間（再） and 佐久間（元）, same pref_code — and the upstreams publish
 * readings under only one of them. Scalar SQL over the outer alias `d`: the
 * slug of the twin (same base name, the other suffix, same pref_code) that
 * `d`'s page should declare canonical. That is the case only when `d` has no
 * reading (dam_reading(…, FALSE), what the detail page shows) and exactly one
 * twin has one; NULL otherwise.
 */
function canonicalTwinSlug() {
  return sql`(
    SELECT CASE WHEN COUNT(*) = 1 THEN MIN(t.slug) END
    FROM dams t
    WHERE RIGHT(d.name, 3) IN ('（元）', '（再）')
      AND t.pref_code = d.pref_code
      AND t.name = LEFT(d.name, -3)
                   || CASE RIGHT(d.name, 3) WHEN '（元）' THEN '（再）' ELSE '（元）' END
      AND NOT EXISTS (SELECT 1 FROM dam_reading(d.id, FALSE))
      AND EXISTS (SELECT 1 FROM dam_reading(t.id, FALSE))
  )`;
}

export interface CanonicalTwin {
  slug: string;
  name: string;
}

/** The （元）/（再） twin this dam's page canonicalises to, if any (see canonicalTwinSlug). */
export async function canonicalTwin(damId: bigint): Promise<CanonicalTwin | null> {
  const rows = await sql<CanonicalTwin[]>`
    SELECT t.slug, t.name
    FROM dams d
    JOIN dams t ON t.slug = ${canonicalTwinSlug()}
    WHERE d.id = ${damId}
  `;
  return rows[0] ?? null;
}

export interface SitemapDam {
  slug: string;
  lastModified: Date;
}

/**
 * Dams whose page is its own canonical, with the later of the master row's
 * updated_at and the newest displayable observation as lastModified.
 */
export async function sitemapDams(): Promise<SitemapDam[]> {
  return sql<SitemapDam[]>`
    WITH latest AS (
      SELECT dam_id, MAX(observed_at) AS observed_at
      FROM observations
      WHERE source_id <> 'synthetic'
      GROUP BY dam_id
    )
    SELECT d.slug, GREATEST(d.updated_at, l.observed_at) AS "lastModified"
    FROM dams d
    LEFT JOIN latest l ON l.dam_id = d.id
    WHERE ${canonicalTwinSlug()} IS NULL
    ORDER BY d.id
  `;
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

type StorageChangeWindow = 'h1' | 'h6' | 'h12' | 'd1' | 'd7' | 'd30' | 'd365' | 'd1825';

/**
 * One row per lookback window: the dam's reading (the 貯水量 its page shows,
 * docs/adr/0002) plus its reading as of (that reading − window).
 *
 * A single LATERAL over the windows, so `observations` is planned a fixed
 * number of times however many windows there are. An earlier form — 16
 * scalar subqueries — planned the hypertable 16 times over every chunk
 * (their bound comes from `latest`, so nothing is excluded at plan time): on
 * production (220 chunks) 0.47 s of planning and ~270 MB that glibc then
 * keeps in the backend, so every pooled web connection ended up holding it.
 */
export function storageChangeQuery(damId: bigint) {
  return sql`
    WITH latest AS (
      SELECT storage_volume_m3, observed_at FROM dam_reading(${damId})
    )
    SELECT
      latest.storage_volume_m3::TEXT AS current,
      latest.observed_at             AS "currentAt",
      w.label                        AS "window",
      o.storage_volume_m3::TEXT      AS volume,
      o.observed_at                  AS "observedAt"
    FROM latest
    CROSS JOIN (VALUES
      ('h1', INTERVAL '1 hour'), ('h6', INTERVAL '6 hours'), ('h12', INTERVAL '12 hours'),
      ('d1', INTERVAL '1 day'), ('d7', INTERVAL '7 days'), ('d30', INTERVAL '30 days'),
      ('d365', INTERVAL '365 days'), ('d1825', INTERVAL '1825 days')
    ) AS w(label, back)
    LEFT JOIN LATERAL dam_reading(${damId}, TRUE, NULL, latest.observed_at - w.back) o ON TRUE
  `;
}

/**
 * Returns the latest storage_volume plus the closest historical observation
 * at the eight lookback windows used by the TradingView-style change %
 * display on the dam page. We pick "the most recent observation at or before
 * NOW() - INTERVAL X" so a sparse observation cadence (e.g. 1/day) still
 * yields a usable comparison.
 */
export async function storageChange(damId: bigint): Promise<StorageChange> {
  // 8 lookback windows. The query picks "the most recent observation at or
  // before NOW() - INTERVAL X" for each, so a 1-hour ingest cadence still
  // resolves the short windows accurately while sparser data degrades
  // gracefully (the StorageChangeStrip flags stale picks visually).
  const rows = (await storageChangeQuery(damId)) as unknown as {
    current: string | null;
    currentAt: Date | null;
    window: StorageChangeWindow;
    volume: string | null;
    observedAt: Date | null;
  }[];
  const change: StorageChange = {
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
  for (const r of rows) {
    change.current = r.current;
    change[r.window] = r.volume;
    change[`${r.window}AgeS`] =
      r.currentAt && r.observedAt
        ? Math.round((r.currentAt.getTime() - r.observedAt.getTime()) / 1000)
        : null;
  }
  return change;
}

export interface NearbyDam extends DamListItem {
  /** Great-circle distance from the source dam, in metres. */
  distanceM: number;
  /** Bearing from the source dam, radians clockwise from north (0=N, π/2=E). */
  bearingRad: number;
  /** 貯水量 of the dam's reading (dam_reading()). NULL when it has none. */
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
  // The nearest `limit` dams first, then one reading each: a LATERAL over
  // the whole radius computed a reading for every dam inside it.
  return sql<NearbyDam[]>`
    WITH near AS (
      SELECT d2.*,
             ST_Distance(d.location, d2.location)::FLOAT8                    AS distance_m,
             ST_Azimuth(d.location::geometry, d2.location::geometry)::FLOAT8 AS bearing_rad
      FROM dams d
      JOIN dams d2 ON d2.id <> d.id AND ST_DWithin(d.location, d2.location, ${radiusM})
      WHERE d.id = ${damId}
      ORDER BY d.location <-> d2.location
      LIMIT ${limit}
    )
    SELECT
      n.id, n.slug, n.name, n.pref_code AS "prefCode", n.manager,
      n.total_capacity_m3::TEXT  AS "totalCapacityM3",
      n.active_capacity_m3::TEXT AS "activeCapacityM3",
      w.slug AS "watershedSlug", w.name AS "watershedName",
      ST_Y(n.location::geometry) AS lat, ST_X(n.location::geometry) AS lng,
      n.distance_m  AS "distanceM",
      n.bearing_rad AS "bearingRad",
      r.storage_volume_m3::TEXT     AS "latestStorageM3",
      r.effective_capacity_m3::TEXT AS "effectiveActiveCapacityM3"
    FROM near n
    LEFT JOIN watersheds w ON w.id = n.watershed_id
    LEFT JOIN LATERAL dam_reading(n.id) r ON TRUE
    ORDER BY n.distance_m
  `;
}

export interface LatestRateAndSource {
  rate: number | null;
  /** source_id of the dam's reading if it is from the last 30 days, else null. */
  realSourceId: string | null;
}

/**
 * 貯水率 of each dam's reading (dam_reading(), docs/adr/0002), clipped to
 * [0, 1], keyed by `id.toString()` so the result is JSON-safe; null without a
 * volume or a denominator.
 */
export async function latestRateByDam(damIds: bigint[]): Promise<Map<string, number | null>> {
  if (damIds.length === 0) return new Map();
  const ids = damIds.map((id) => id.toString());
  const rows = await sql<{ damId: string; rate: number | null }[]>`
    SELECT d.id::TEXT AS "damId", LEAST(1.0, r.rate::FLOAT8) AS rate
    FROM dams d
    LEFT JOIN LATERAL dam_reading(d.id) r ON TRUE
    WHERE d.id::TEXT = ANY(${ids}::TEXT[])
  `;
  return new Map(rows.map((r) => [r.damId, r.rate]));
}

/** latestRateByDam plus the source of the dam's reading when it is from the
 * last 30 days, so the dam list can show a "実測" dot. */
export async function latestRateAndSourceByDam(
  damIds: bigint[],
): Promise<Map<string, LatestRateAndSource>> {
  if (damIds.length === 0) return new Map();
  const ids = damIds.map((id) => id.toString());
  const rows = await sql<{ damId: string; rate: number | null; realSourceId: string | null }[]>`
    SELECT
      d.id::TEXT                AS "damId",
      LEAST(1.0, r.rate::FLOAT8) AS rate,
      recent.source_id          AS "realSourceId"
    FROM dams d
    LEFT JOIN LATERAL dam_reading(d.id) r ON TRUE
    LEFT JOIN LATERAL dam_reading(d.id, FALSE, INTERVAL '30 days') recent ON TRUE
    WHERE d.id::TEXT = ANY(${ids}::TEXT[])
  `;
  return new Map(rows.map((r) => [r.damId, { rate: r.rate, realSourceId: r.realSourceId }]));
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
 * Dams whose reading (dam_reading(), within 30 days) has a 貯水率 below
 * `thresholdPct`, over the reading's effective capacity like every other
 * view — dividing by the static `active_capacity_m3` here once put dams on
 * the drought list at 11 % while their own page, which honours the source's
 * season-aware rate, showed 100 % (issue #38 §2-2).
 *
 * Returns at most `limit` rows ordered by rate ascending (worst first).
 */
export async function lowStorageDams(
  thresholdPct: number,
  limit: number,
): Promise<LowStorageDam[]> {
  return sql<LowStorageDam[]>`
    SELECT
      d.id::TEXT                    AS id,
      d.name,
      d.slug,
      d.pref_code                   AS "prefCode",
      w.slug                        AS "watershedSlug",
      w.name                        AS "watershedName",
      LEAST(1.0, r.rate::FLOAT8)    AS rate,
      r.storage_volume_m3::TEXT     AS "storageVolumeM3",
      r.observed_at::TEXT           AS "observedAt",
      r.source_id                   AS "sourceId"
    FROM dams d
    LEFT JOIN watersheds w ON w.id = d.watershed_id
    -- The 30-day window goes *into* the reading: this runs once per dam
    -- across the whole master, and filtered afterwards TimescaleDB loses
    -- chunk exclusion and reads every dam's full history (1455 ms vs 19 ms
    -- on the dev copy). A dam whose reading is older drops off the list.
    JOIN LATERAL dam_reading(d.id, TRUE, INTERVAL '30 days') r ON TRUE
    WHERE r.rate < ${thresholdPct / 100.0}
    ORDER BY rate ASC
    LIMIT ${limit}
  `;
}
