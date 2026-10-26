import { sql } from '../client.ts';

export interface UpsertWatershedInput {
  code: string;
  slug: string;
  name: string;
  nameKana?: string | null;
  kind: 'first' | 'second' | 'other';
  /** 国土数値情報 水系域コード (6 桁), when the source carries one. */
  ndiCode?: string | null;
  boundaryGeoJSON: object; // FeatureGeometry
  areaKm2?: number | null;
}

export async function upsertWatershed(input: UpsertWatershedInput): Promise<bigint> {
  const rows = await sql<{ id: bigint }[]>`
    INSERT INTO watersheds (code, slug, name, name_kana, kind, ndi_code, boundary, area_km2)
    VALUES (
      ${input.code}, ${input.slug}, ${input.name}, ${input.nameKana ?? null},
      ${input.kind}, ${input.ndiCode ?? null},
      ST_Multi(ST_GeomFromGeoJSON(${JSON.stringify(input.boundaryGeoJSON)}))::geography,
      ${input.areaKm2 ?? null}
    )
    ON CONFLICT (code) DO UPDATE SET
      slug      = EXCLUDED.slug,
      name      = EXCLUDED.name,
      name_kana = EXCLUDED.name_kana,
      kind      = EXCLUDED.kind,
      ndi_code  = EXCLUDED.ndi_code,
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
  ndiCode: string | null;
}

export async function findWatershedContaining(
  lat: number,
  lng: number,
): Promise<WatershedAtPoint | null> {
  const rows = await sql<WatershedAtPoint[]>`
    SELECT id, code, slug, name, kind, ndi_code AS "ndiCode"
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
    SELECT id, code, slug, name, kind, ndi_code AS "ndiCode",
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
  ndiCode: string | null;
  damCount: number;
}

export async function listWatersheds(
  opts: { kind?: 'first' | 'second' | null; cursor?: bigint | null; pageSize?: number } = {},
): Promise<{ items: WatershedListItem[]; nextCursor: bigint | null }> {
  // 1000 > the 644-row master, so the web pages can fetch it in one call.
  const limit = Math.max(1, Math.min(1000, opts.pageSize ?? 200));
  const rows = await sql<WatershedListItem[]>`
    SELECT
      w.id, w.slug, w.code, w.name, w.kind, w.ndi_code AS "ndiCode",
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
      w.id, w.slug, w.code, w.name, w.kind, w.ndi_code AS "ndiCode",
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
  ndiCode: string | null;
  areaKm2: number | null;
}

export async function findWatershedBySlug(slug: string): Promise<WatershedDetail | null> {
  const rows = await sql<WatershedDetail[]>`
    SELECT id, slug, code, name, name_kana AS "nameKana", kind,
           ndi_code AS "ndiCode", area_km2 AS "areaKm2"
    FROM watersheds WHERE slug = ${slug} LIMIT 1
  `;
  return rows[0] ?? null;
}

export interface WatershedAggregate {
  /** All dams in the watershed (not just rate-able). */
  damCount: number;
  /** Sum of 総貯水容量 over all dams — used as a "size" indicator. */
  totalCapacityM3: string | null;
  /** Sum of 有効貯水容量 over the rate-able subset (informational; NOT the rate denominator). */
  activeCapacityM3: string | null;
  /** Dams with active_capacity_m3 IS NOT NULL. */
  rateableDamCount: number;
  /** Latest storage summed over the observed cohort — pairs with observedActiveCapacityM3 for rate. */
  latestStorageVolumeM3: string | null;
  /**
   * Rate-able dams with an observation inside the freshness window. The rate
   * numerator and denominator are both restricted to this cohort so dams
   * without (fresh) data can't deflate the rate.
   */
  observedDamCount: number;
  /**
   * Sum of each observed dam's effective capacity (its reading's denominator,
   * GLOSSARY) — the rate denominator. Per dam this is the static
   * active_capacity_m3 unless the reading came from a trusted_rate_basis
   * source with its own storage_rate; then it is back-solved (volume/rate)
   * from that season-aware rate instead. See issue #17.
   */
  observedActiveCapacityM3: string | null;
  observedAt: Date | null;
  /** How many of the watershed's dams have at least one non-synthetic observation in the last 30 days. */
  realDamCount: number;
}

/**
 * An observation only participates in watershed/national rate aggregation if
 * it is at most this old. Anything staler drops the dam out of both the
 * numerator AND the denominator, keeping the two cohorts identical.
 */
export const RATE_FRESHNESS_DAYS = 7;

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

type ChangeBucket = 'current' | 'h1' | 'h6' | 'h12' | 'd1' | 'd7' | 'd30' | 'd365' | 'd1825';
type BucketTotal = { total: string | null; pickedAt: Date | null };

const SUB_DAY: [ChangeBucket, string][] = [
  ['current', '0 seconds'],
  ['h1', '1 hour'],
  ['h6', '6 hours'],
  ['h12', '12 hours'],
];
const DAY_PLUS: [ChangeBucket, number][] = [
  ['d1', 1],
  ['d7', 7],
  ['d30', 30],
  ['d365', 365],
  ['d1825', 1825],
];

/**
 * Per bucket, the SUM of the dams' readings (dam_reading()) as of
 * `anchor − lookback`, and the oldest reading picked. The anchor is a bound
 * parameter and each bucket its own LATERAL with a constant offset, so every
 * reading prunes chunks at executor startup: one LATERAL over a VALUES list
 * of offsets re-ran exclusion per row, and an anchor computed in the same
 * query (or passed as a sub-select, which also stops the function from being
 * inlined) did the same — 0.8 s → 0.08 s for the national strip.
 */
async function readingTotalsAt(
  damIds: bigint[],
  anchor: Date,
  buckets: [ChangeBucket, string][],
  window: string | null,
): Promise<Map<ChangeBucket, BucketTotal>> {
  const win = window === null ? sql`NULL::INTERVAL` : sql`${window}::INTERVAL`;
  const join = (parts: ReturnType<typeof sql>[], sep: ReturnType<typeof sql>) =>
    parts.reduce((acc, p) => sql`${acc}${sep}${p}`);
  const cols = join(
    buckets.map(
      ([b]) =>
        sql`SUM(${sql(b)}.storage_volume_m3)::TEXT AS ${sql(`${b}_total`)}, MIN(${sql(b)}.observed_at) AS ${sql(`${b}_at`)}`,
    ),
    sql`, `,
  );
  const laterals = join(
    buckets.map(
      ([b, back]) =>
        sql`LEFT JOIN LATERAL dam_reading(d.id, TRUE, ${win}, ${anchor}::TIMESTAMPTZ - ${back}::INTERVAL) ${sql(b)} ON TRUE`,
    ),
    sql` `,
  );
  const ids = damIds.map(String);
  const [row] = await sql<Record<string, string | Date | null>[]>`
    SELECT ${cols} FROM dams d ${laterals} WHERE d.id = ANY(${ids}::BIGINT[])
  `;
  return new Map(
    buckets.map(([b]) => [
      b,
      {
        total: (row?.[`${b}_total`] as string | null) ?? null,
        pickedAt: (row?.[`${b}_at`] as Date | null) ?? null,
      },
    ]),
  );
}

function toChange(m: Map<ChangeBucket, BucketTotal>): WatershedStorageChange {
  const get = (k: ChangeBucket): string | null => m.get(k)?.total ?? null;
  const at = (k: ChangeBucket): Date | null => m.get(k)?.pickedAt ?? null;
  const currentAt = at('current');
  const ageS = (k: ChangeBucket): number | null => {
    const b = at(k);
    return currentAt && b ? Math.round((currentAt.getTime() - b.getTime()) / 1000) : null;
  };
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
    h1AgeS: ageS('h1'),
    h6AgeS: ageS('h6'),
    h12AgeS: ageS('h12'),
    d1AgeS: ageS('d1'),
    d7AgeS: ageS('d7'),
    d30AgeS: ageS('d30'),
    d365AgeS: ageS('d365'),
    d1825AgeS: ageS('d1825'),
  };
}

/**
 * Watershed-level "now minus N" totals over the dams that have a capacity
 * (the rate-able subset the watershed gauge uses). "Now" is the watershed's
 * newest volume; each bucket sums every dam's reading as of now − N.
 */
export async function watershedStorageChange(watershedId: bigint): Promise<WatershedStorageChange> {
  // Each dam's newest volume, one index probe per dam. A dam without any
  // volume drops out here, so the readings below skip it instead of
  // searching every chunk for it.
  const latest = await sql<{ damId: bigint; t: Date }[]>`
    SELECT d.id AS "damId", x.observed_at AS t
    FROM dams d
    CROSS JOIN LATERAL (
      SELECT o.observed_at FROM observations o
      WHERE o.dam_id = d.id AND o.storage_volume_m3 IS NOT NULL AND o.source_id <> 'synthetic'
      ORDER BY o.observed_at DESC
      LIMIT 1
    ) x
    WHERE d.watershed_id = ${watershedId} AND d.active_capacity_m3 IS NOT NULL
  `;
  if (latest.length === 0) return toChange(new Map());
  const anchor = new Date(Math.max(...latest.map((r) => r.t.getTime())));
  const buckets: [ChangeBucket, string][] = [
    ...SUB_DAY,
    ...DAY_PLUS.map(([b, days]): [ChangeBucket, string] => [b, `${days} days`]),
  ];
  return toChange(
    await readingTotalsAt(
      latest.map((r) => r.damId),
      anchor,
      buckets,
      null,
    ),
  );
}

/**
 * National version of watershedStorageChange — same shape, over every dam in
 * the country with active_capacity_m3. Used by the home page change strip.
 *   • sub-day buckets (current, h1, h6, h12) — readings as of the anchor
 *     minus the lookback, within 2 days of it.
 *   • day+ buckets (d1 … d1825) — obs_daily's daily value on anchor day − N:
 *     a reading per dam at five-year depth would cost a probe per dam each.
 */
export async function nationalStorageChange(): Promise<WatershedStorageChange> {
  // Anchor day from obs_daily (one row per dam per day → cheap MAX); the
  // anchor moment is the newest volume in a bounded window around it.
  const [a] = await sql<{ day: Date | null; t: Date | null }[]>`
    WITH anchor_day AS (
      SELECT MAX(od.day) AS d
      FROM obs_daily od
      JOIN dams ds ON ds.id = od.dam_id
      WHERE ds.active_capacity_m3 IS NOT NULL
    )
    SELECT (SELECT d FROM anchor_day) AS day, MAX(o.observed_at) AS t
    FROM observations o
    JOIN dams ds ON ds.id = o.dam_id
    WHERE ds.active_capacity_m3 IS NOT NULL
      AND o.storage_volume_m3 IS NOT NULL
      AND o.source_id <> 'synthetic'
      AND o.observed_at >= (SELECT d FROM anchor_day) - INTERVAL '1 day'
      AND o.observed_at <  (SELECT d FROM anchor_day) + INTERVAL '2 days'
  `;
  if (!a?.day || !a.t) return toChange(new Map());
  const rateable = await sql<{ id: bigint }[]>`
    SELECT id FROM dams WHERE active_capacity_m3 IS NOT NULL
  `;
  const [subDay, dayPlus] = await Promise.all([
    readingTotalsAt(
      rateable.map((r) => r.id),
      a.t,
      SUB_DAY,
      '2 days',
    ),
    sql<{ bucket: ChangeBucket; total: string | null; pickedAt: Date | null }[]>`
      SELECT b.bucket,
             SUM(od.last_storage_volume_m3)::TEXT AS total,
             MIN(od.day)::TIMESTAMPTZ             AS "pickedAt"
      FROM (VALUES ${sql(DAY_PLUS)}) AS b(bucket, lookback_days)
      JOIN obs_daily od ON od.day = ${a.day}::TIMESTAMPTZ - (b.lookback_days::INT * INTERVAL '1 day')
      JOIN dams ds ON ds.id = od.dam_id AND ds.active_capacity_m3 IS NOT NULL
      WHERE od.last_storage_volume_m3 IS NOT NULL
      GROUP BY b.bucket
    `,
  ]);
  for (const r of dayPlus) subDay.set(r.bucket, { total: r.total, pickedAt: r.pickedAt });
  return toChange(subDay);
}

export async function aggregateWatershed(watershedId: bigint): Promise<WatershedAggregate> {
  // Three cohorts:
  //   `ds`          — every dam in the watershed (damCount + total capacity)
  //   `ds_rateable` — dams with active_capacity_m3 (informational capacity sum)
  //   `latest`      — rate-able dams with a fresh observation. The rate
  //                   numerator (storage) and denominator (observed active
  //                   capacity) both come from this cohort; a dam with no
  //                   fresh data influences neither side.
  const rows = await sql<WatershedAggregate[]>`
    WITH ds AS (
      SELECT id, total_capacity_m3, active_capacity_m3
      FROM dams WHERE watershed_id = ${watershedId}
    ),
    ds_rateable AS (
      SELECT id, active_capacity_m3 FROM ds WHERE active_capacity_m3 IS NOT NULL
    ),
    -- Each rate-able dam's reading (dam_reading(), docs/adr/0002) when it is
    -- fresh; its effective capacity is the denominator. The window is passed
    -- in, not filtered afterwards, or chunk exclusion is lost — see 0049.
    latest AS (
      SELECT ds_rateable.id AS dam_id, x.observed_at, x.storage_volume_m3,
             x.effective_capacity_m3 AS active_capacity_m3
      FROM ds_rateable
      JOIN LATERAL dam_reading(
        ds_rateable.id, TRUE, make_interval(days => ${RATE_FRESHNESS_DAYS})
      ) x ON TRUE
    )
    SELECT
      (SELECT COUNT(*)::INT          FROM ds)                     AS "damCount",
      (SELECT SUM(total_capacity_m3)::TEXT FROM ds)               AS "totalCapacityM3",
      (SELECT COUNT(*)::INT          FROM ds_rateable)            AS "rateableDamCount",
      (SELECT SUM(active_capacity_m3)::TEXT FROM ds_rateable)     AS "activeCapacityM3",
      (SELECT SUM(latest.storage_volume_m3)::TEXT FROM latest)    AS "latestStorageVolumeM3",
      (SELECT COUNT(*)::INT          FROM latest)                 AS "observedDamCount",
      (SELECT SUM(latest.active_capacity_m3)::TEXT FROM latest)   AS "observedActiveCapacityM3",
      (SELECT MAX(latest.observed_at)             FROM latest)    AS "observedAt",
      -- One index probe per dam rather than COUNT(DISTINCT) over every
      -- reading of the last 30 days (#108).
      (SELECT COUNT(*)::INT FROM ds
         WHERE EXISTS (
           SELECT 1 FROM observations o
           WHERE o.dam_id = ds.id
             AND o.source_id <> 'synthetic'
             AND o.observed_at > NOW() - INTERVAL '30 days'
             AND observation_has_value(o)))                    AS "realDamCount"
  `;
  return (
    rows[0] ?? {
      damCount: 0,
      totalCapacityM3: null,
      activeCapacityM3: null,
      rateableDamCount: 0,
      latestStorageVolumeM3: null,
      observedDamCount: 0,
      observedActiveCapacityM3: null,
      observedAt: null,
      realDamCount: 0,
    }
  );
}

/**
 * Batch per-watershed 貯水率: SUM(latest storage_volume_m3) /
 * SUM(active_capacity_m3) over the OBSERVED cohort — rate-able dams with an
 * observation inside the freshness window. Dams without fresh data are
 * excluded from numerator and denominator alike.
 * Result keyed by `watershed_id::TEXT` so callers can join on string ids
 * without dragging bigint through JSON. rate ∈ [0, 1] when the observed
 * cohort is non-empty; null otherwise.
 *
 * Used by /watersheds list to render a 貯水率 progress bar per row in
 * one round-trip rather than 644 separate aggregateWatershed() calls.
 */
export async function ratesForWatersheds(
  watershedIds: bigint[],
): Promise<Map<string, number | null>> {
  if (watershedIds.length === 0) return new Map();
  const ids = watershedIds.map((id) => id.toString());
  const rows = await sql<{ watershedId: string; rate: number | null }[]>`
    -- Each rate-able dam's fresh reading (dam_reading(), docs/adr/0002) over
    -- its effective capacity; a dam without one adds to neither sum. The
    -- window is passed in, or chunk exclusion is lost — see 0049.
    WITH per_dam AS (
      SELECT d.watershed_id, x.storage_volume_m3, x.effective_capacity_m3
      FROM dams d
      LEFT JOIN LATERAL dam_reading(
        d.id, TRUE, make_interval(days => ${RATE_FRESHNESS_DAYS})
      ) x ON TRUE
      WHERE d.watershed_id::TEXT = ANY(${ids}::TEXT[])
        AND d.active_capacity_m3 IS NOT NULL
    )
    SELECT
      watershed_id::TEXT AS "watershedId",
      CASE
        WHEN SUM(effective_capacity_m3) > 0
        THEN LEAST(1.0, SUM(storage_volume_m3)::FLOAT8 / SUM(effective_capacity_m3)::FLOAT8)
      END AS rate
    FROM per_dam
    GROUP BY watershed_id
  `;
  const m = new Map<string, number | null>();
  for (const r of rows) m.set(r.watershedId, r.rate);
  return m;
}

/**
 * Per-watershed count of dams with at least one non-synthetic observation in
 * the last 30 days. One round-trip across the visible list so the watershed
 * index page can show "実測 N 基" annotations alongside dam counts.
 */
export async function realDamCountsForWatersheds(
  watershedIds: bigint[],
): Promise<Map<string, number>> {
  if (watershedIds.length === 0) return new Map();
  const ids = watershedIds.map((id) => id.toString());
  // One index probe per dam (dam_id, observed_at) instead of COUNT(DISTINCT)
  // over every reading of the last 30 days, which sorted ~1 M rows to disk
  // on each /watersheds render (#108).
  const rows = await sql<{ watershedId: string; realDamCount: number }[]>`
    SELECT
      d.watershed_id::TEXT  AS "watershedId",
      COUNT(*)::INT         AS "realDamCount"
    FROM dams d
    WHERE d.watershed_id::TEXT = ANY(${ids}::TEXT[])
      AND EXISTS (
        SELECT 1 FROM observations o
        WHERE o.dam_id = d.id
          AND o.source_id <> 'synthetic'
          AND o.observed_at > NOW() - INTERVAL '30 days'
          AND observation_has_value(o)
      )
    GROUP BY d.watershed_id
  `;
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.watershedId, r.realDamCount);
  return m;
}

export interface DriestWatershed {
  slug: string;
  name: string;
  kind: 'first' | 'second' | 'other';
  rate: number;
  /** Rate-able dams that actually back this rate (fresh obs + capacity). */
  observedDamCount: number;
}

/**
 * The lowest-貯水率 watersheds — for a "where is water scarce" spotlight.
 * Rate uses the same observed-cohort formula as ratesForWatersheds (fresh
 * storage ÷ fresh active capacity). Only systems whose rate is backed by at
 * least `minObserved` rate-able dams qualify — a watershed rate derived from
 * one low dam isn't representative and mustn't headline as "危機的".
 * Ascending by rate.
 */
export async function driestWatersheds(
  limit: number,
  minObserved: number,
): Promise<DriestWatershed[]> {
  return sql<DriestWatershed[]>`
    -- Same cohort as ratesForWatersheds: fresh readings over effective capacity.
    WITH per_dam AS (
      SELECT d.watershed_id, x.storage_volume_m3, x.effective_capacity_m3
      FROM dams d
      LEFT JOIN LATERAL dam_reading(
        d.id, TRUE, make_interval(days => ${RATE_FRESHNESS_DAYS})
      ) x ON TRUE
      WHERE d.watershed_id IS NOT NULL
        AND d.active_capacity_m3 IS NOT NULL
    ),
    rated AS (
      SELECT
        watershed_id,
        COUNT(storage_volume_m3)::INT AS observed_count,
        LEAST(1.0,
          SUM(storage_volume_m3)::FLOAT8 / NULLIF(SUM(effective_capacity_m3), 0)::FLOAT8
        ) AS rate
      FROM per_dam
      GROUP BY watershed_id
    )
    SELECT
      w.slug, w.name, w.kind,
      rated.rate            AS rate,
      rated.observed_count  AS "observedDamCount"
    FROM rated
    JOIN watersheds w ON w.id = rated.watershed_id
    WHERE rated.rate IS NOT NULL
      AND rated.observed_count >= ${minObserved}
    ORDER BY rated.rate ASC
    LIMIT ${limit}
  `;
}
