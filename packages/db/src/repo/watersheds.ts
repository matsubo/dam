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
  /** Sum of 利水容量 over the rate-able subset (informational; NOT the rate denominator). */
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
  /** Sum of 利水容量 over the observed cohort only — the rate denominator. */
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
export async function watershedStorageChange(watershedId: bigint): Promise<WatershedStorageChange> {
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
  // Original query did 9 LATERAL DISTINCT-ON scans across the whole observations
  // hypertable (~9 s on 6.7 M synth rows). Rewrite:
  //   • sub-day buckets (current, h1, h6, h12) — raw observations restricted to
  //     the last 48 h, then DISTINCT ON per dam picks the latest obs at-or-
  //     before each lookback. Cheap because the scan window is bounded.
  //   • day+ buckets (d1, d7, d30, d365, d1825) — obs_daily continuous
  //     aggregate. last_storage_volume_m3 per (dam_id, day) is the materialised
  //     answer to "what was each dam's last storage on day X". Pin the day to
  //     `anchor::date - lookback_days`.
  const rows = await sql<{ bucket: string; total: string | null; pickedAt: Date | null }[]>`
    WITH ds AS (
      SELECT id FROM dams WHERE active_capacity_m3 IS NOT NULL
    ),
    -- Anchor day from obs_daily (one row per dam per day → cheap MAX). The
    -- anchor timestamp itself comes from the small obs window covering that
    -- day plus the day before, so all sub-day-bucket scans stay bounded.
    anchor_day AS (
      SELECT MAX(od.day) AS d
      FROM obs_daily od
      JOIN ds ON ds.id = od.dam_id
    ),
    recent_obs AS (
      SELECT o.dam_id, o.storage_volume_m3, o.observed_at
      FROM observations o
      JOIN ds ON ds.id = o.dam_id
      WHERE o.storage_volume_m3 IS NOT NULL
        AND o.observed_at >= ((SELECT d FROM anchor_day) - INTERVAL '1 day')
        AND o.observed_at <  ((SELECT d FROM anchor_day) + INTERVAL '2 days')
    ),
    anchor AS (SELECT MAX(observed_at) AS t FROM recent_obs),
    -- Sub-day buckets: snap each dam's latest obs at-or-before (anchor - lookback).
    sub_day AS (
      SELECT b.bucket, b.lookback, picks.dam_id, picks.storage_volume_m3, picks.observed_at
      FROM (VALUES
        ('current', INTERVAL '0 second'),
        ('h1',      INTERVAL '1 hour'),
        ('h6',      INTERVAL '6 hours'),
        ('h12',     INTERVAL '12 hours')
      ) AS b(bucket, lookback)
      LEFT JOIN LATERAL (
        SELECT DISTINCT ON (o.dam_id) o.dam_id, o.storage_volume_m3, o.observed_at
        FROM recent_obs o
        WHERE o.observed_at <= (SELECT t FROM anchor) - b.lookback
        ORDER BY o.dam_id, o.observed_at DESC
      ) picks ON TRUE
    ),
    sub_day_totals AS (
      SELECT bucket,
             SUM(storage_volume_m3)::TEXT AS total,
             MIN(observed_at) AS picked_at
      FROM sub_day
      GROUP BY bucket
    ),
    -- Day+ buckets: obs_daily pinned to anchor_day - N. last_storage_volume_m3
    -- is the materialised "last value of the bucket day".
    day_plus AS (
      SELECT b.bucket, picks.day::TIMESTAMPTZ AS picked_at, picks.last_storage_volume_m3
      FROM (VALUES
        ('d1',     1),
        ('d7',     7),
        ('d30',   30),
        ('d365', 365),
        ('d1825', 1825)
      ) AS b(bucket, lookback_days)
      LEFT JOIN LATERAL (
        SELECT od.dam_id, od.day, od.last_storage_volume_m3
        FROM obs_daily od
        JOIN ds ON ds.id = od.dam_id
        WHERE od.day = (SELECT d FROM anchor_day) - (b.lookback_days * INTERVAL '1 day')
          AND od.last_storage_volume_m3 IS NOT NULL
      ) picks ON TRUE
    ),
    day_plus_totals AS (
      SELECT bucket,
             SUM(last_storage_volume_m3)::TEXT AS total,
             MIN(picked_at) AS picked_at
      FROM day_plus
      GROUP BY bucket
    )
    SELECT bucket, total, picked_at AS "pickedAt" FROM sub_day_totals
    UNION ALL
    SELECT bucket, total, picked_at AS "pickedAt" FROM day_plus_totals
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
    latest AS (
      SELECT DISTINCT ON (o.dam_id)
             o.dam_id, o.observed_at, o.storage_volume_m3,
             ds_rateable.active_capacity_m3
      FROM observations o
      JOIN ds_rateable ON ds_rateable.id = o.dam_id
      WHERE o.storage_volume_m3 IS NOT NULL
        AND o.observed_at > NOW() - make_interval(days => ${RATE_FRESHNESS_DAYS})
      ORDER BY o.dam_id, o.observed_at DESC
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
      (SELECT COUNT(DISTINCT o.dam_id)::INT
         FROM observations o JOIN ds ON ds.id = o.dam_id
         WHERE o.source_id <> 'synthetic'
           AND o.observed_at > NOW() - INTERVAL '30 days')        AS "realDamCount"
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
    WITH ds AS (
      SELECT d.id, d.watershed_id, d.active_capacity_m3
      FROM dams d
      WHERE d.watershed_id::TEXT = ANY(${ids}::TEXT[])
        AND d.active_capacity_m3 IS NOT NULL
    ),
    latest AS (
      SELECT DISTINCT ON (o.dam_id)
             o.dam_id, o.storage_volume_m3
      FROM observations o
      JOIN ds ON ds.id = o.dam_id
      WHERE o.storage_volume_m3 IS NOT NULL
        AND o.observed_at > NOW() - make_interval(days => ${RATE_FRESHNESS_DAYS})
      ORDER BY o.dam_id, o.observed_at DESC
    )
    SELECT
      ds.watershed_id::TEXT AS "watershedId",
      CASE
        WHEN SUM(ds.active_capacity_m3) FILTER (WHERE latest.dam_id IS NOT NULL) > 0
        THEN LEAST(1.0,
          SUM(latest.storage_volume_m3)::FLOAT8 /
          SUM(ds.active_capacity_m3) FILTER (WHERE latest.dam_id IS NOT NULL)::FLOAT8
        )
        ELSE NULL
      END AS rate
    FROM ds
    LEFT JOIN latest ON latest.dam_id = ds.id
    GROUP BY ds.watershed_id
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
  const rows = await sql<{ watershedId: string; realDamCount: number }[]>`
    SELECT
      d.watershed_id::TEXT  AS "watershedId",
      COUNT(DISTINCT o.dam_id)::INT AS "realDamCount"
    FROM dams d
    JOIN observations o ON o.dam_id = d.id
    WHERE d.watershed_id::TEXT = ANY(${ids}::TEXT[])
      AND o.source_id <> 'synthetic'
      AND o.observed_at > NOW() - INTERVAL '30 days'
    GROUP BY d.watershed_id
  `;
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.watershedId, r.realDamCount);
  return m;
}
