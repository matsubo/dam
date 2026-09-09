import { sql } from '../client.ts';

export interface ObservationInput {
  observedAt: Date;
  damId: bigint;
  sourceId: string;
  storageVolumeM3?: number | null;
  storageRate?: number | null;
  inflowM3s?: number | null;
  outflowM3s?: number | null;
  waterLevelM?: number | null;
  rainfallMm?: number | null;
  rawSnapshotId?: bigint | null;
  qualityFlag?: number;
}

export async function upsertObservations(rows: ObservationInput[]): Promise<number> {
  if (rows.length === 0) return 0;
  // Build a single multi-row INSERT for performance
  const values = rows.map((r) => ({
    observed_at: r.observedAt,
    dam_id: r.damId,
    source_id: r.sourceId,
    storage_volume_m3: r.storageVolumeM3 ?? null,
    storage_rate: r.storageRate ?? null,
    inflow_m3s: r.inflowM3s ?? null,
    outflow_m3s: r.outflowM3s ?? null,
    water_level_m: r.waterLevelM ?? null,
    rainfall_mm: r.rainfallMm ?? null,
    raw_snapshot_id: r.rawSnapshotId ?? null,
    quality_flag: r.qualityFlag ?? 0,
  }));
  const result = await sql`
    INSERT INTO observations ${sql(values)}
    ON CONFLICT (dam_id, observed_at, source_id) DO UPDATE SET
      storage_volume_m3 = EXCLUDED.storage_volume_m3,
      storage_rate      = EXCLUDED.storage_rate,
      inflow_m3s        = EXCLUDED.inflow_m3s,
      outflow_m3s       = EXCLUDED.outflow_m3s,
      water_level_m     = EXCLUDED.water_level_m,
      rainfall_mm       = EXCLUDED.rainfall_mm,
      raw_snapshot_id   = COALESCE(EXCLUDED.raw_snapshot_id, observations.raw_snapshot_id),
      quality_flag      = EXCLUDED.quality_flag
  `;
  return result.count;
}

export interface SeriesPoint {
  observedAt: Date;
  storageVolumeM3: number | null;
  storageRate: number | null;
  /** Hourly grain only — the continuous aggregates omit flow columns. */
  inflowM3s: number | null;
  outflowM3s: number | null;
  qualityFlag: number;
  sourceId: string;
}

export interface FindSeriesOptions {
  damId: bigint;
  from: Date;
  to: Date;
  bucket: 'hourly' | 'daily' | 'monthly';
  preferredSource?: string | null;
  /**
   * Exclude rows with `source_id = 'synthetic'` (the placeholder seed used
   * for dams without an upstream feed). Useful for API consumers who only
   * want measured data. Hourly bucket only — the daily/monthly continuous
   * aggregates collapse all sources and can't be filtered after the fact
   * without re-aggregating raw observations.
   */
  excludeSynthetic?: boolean;
}

async function findSeriesHourly(opts: FindSeriesOptions): Promise<SeriesPoint[]> {
  const preferred = opts.preferredSource ?? null;
  const excludeSynthetic = opts.excludeSynthetic === true;
  return sql<SeriesPoint[]>`
    SELECT observed_at AS "observedAt",
           storage_volume_m3 AS "storageVolumeM3",
           storage_rate AS "storageRate",
           inflow_m3s AS "inflowM3s",
           outflow_m3s AS "outflowM3s",
           quality_flag AS "qualityFlag",
           source_id AS "sourceId"
    FROM observations
    WHERE dam_id = ${opts.damId}
      AND observed_at >= ${opts.from}
      AND observed_at <  ${opts.to}
      AND (${preferred}::text IS NULL OR source_id = ${preferred})
      AND (NOT ${excludeSynthetic}::boolean OR source_id <> 'synthetic')
    ORDER BY observed_at
  `;
}

async function findSeriesDaily(opts: FindSeriesOptions): Promise<SeriesPoint[]> {
  // The daily continuous aggregate carries last_storage_volume only; flow
  // columns aren't aggregated yet, so we surface NULL for inflow/outflow at
  // this bucket and let the UI hide the lines.
  return sql<SeriesPoint[]>`
    SELECT day AS "observedAt",
           last_storage_volume_m3 AS "storageVolumeM3",
           NULL::NUMERIC AS "storageRate",
           NULL::NUMERIC AS "inflowM3s",
           NULL::NUMERIC AS "outflowM3s",
           0::SMALLINT AS "qualityFlag",
           'aggregate' AS "sourceId"
    FROM obs_daily
    WHERE dam_id = ${opts.damId}
      AND day >= ${opts.from}
      AND day <  ${opts.to}
    ORDER BY day
  `;
}

async function findSeriesMonthly(opts: FindSeriesOptions): Promise<SeriesPoint[]> {
  // obs_monthly aggregates obs_daily and exposes avg/max/min only — there is
  // no `last` column at the monthly bucket. Use the monthly average as the
  // chart series. Flow columns are NULL here too (see daily).
  return sql<SeriesPoint[]>`
    SELECT month AS "observedAt",
           avg_storage_volume_m3 AS "storageVolumeM3",
           NULL::NUMERIC AS "storageRate",
           NULL::NUMERIC AS "inflowM3s",
           NULL::NUMERIC AS "outflowM3s",
           0::SMALLINT AS "qualityFlag",
           'aggregate' AS "sourceId"
    FROM obs_monthly
    WHERE dam_id = ${opts.damId}
      AND month >= ${opts.from}
      AND month <  ${opts.to}
    ORDER BY month
  `;
}

export async function findSeries(opts: FindSeriesOptions): Promise<SeriesPoint[]> {
  if (opts.bucket === 'hourly') return findSeriesHourly(opts);
  if (opts.bucket === 'daily') return findSeriesDaily(opts);
  return findSeriesMonthly(opts);
}

export interface FindWatershedSeriesOptions {
  watershedId: bigint;
  from: Date;
  to: Date;
  bucket: 'hourly' | 'daily' | 'monthly';
  preferredSource?: string | null;
  /**
   * Hourly bucket only — drops `source_id = 'synthetic'` rows from the
   * per-dam input before bucketing. The watershed aggregate then reflects
   * only dams whose values are actually measured.
   */
  excludeSynthetic?: boolean;
}

// Aggregate the watershed's storage by summing latest-bucket volumes across
// all dams that have observations in that bucket. Per-dam volumes can have
// gaps so we use last() at the bucket level rather than avg() to avoid
// double-counting partial observations.
async function findWatershedSeriesHourly(opts: FindWatershedSeriesOptions): Promise<SeriesPoint[]> {
  const preferred = opts.preferredSource ?? null;
  const excludeSynthetic = opts.excludeSynthetic === true;
  return sql<SeriesPoint[]>`
    WITH ds AS (SELECT id FROM dams WHERE watershed_id = ${opts.watershedId}),
    bucketed AS (
      SELECT
        time_bucket('1 hour', o.observed_at) AS bucket,
        o.dam_id,
        last(o.storage_volume_m3, o.observed_at) AS volume,
        last(o.storage_rate, o.observed_at)      AS rate
      FROM observations o
      JOIN ds ON ds.id = o.dam_id
      WHERE o.observed_at >= ${opts.from}
        AND o.observed_at <  ${opts.to}
        AND (${preferred}::text IS NULL OR o.source_id = ${preferred})
        AND (NOT ${excludeSynthetic}::boolean OR o.source_id <> 'synthetic')
      GROUP BY bucket, o.dam_id
    )
    SELECT bucket AS "observedAt",
           SUM(volume)::NUMERIC AS "storageVolumeM3",
           AVG(rate)::NUMERIC   AS "storageRate",
           0::SMALLINT          AS "qualityFlag",
           'aggregate'          AS "sourceId"
    FROM bucketed
    GROUP BY bucket
    ORDER BY bucket
  `;
}

async function findWatershedSeriesDaily(opts: FindWatershedSeriesOptions): Promise<SeriesPoint[]> {
  return sql<SeriesPoint[]>`
    WITH ds AS (SELECT id FROM dams WHERE watershed_id = ${opts.watershedId})
    SELECT day AS "observedAt",
           SUM(last_storage_volume_m3)::NUMERIC AS "storageVolumeM3",
           AVG(avg_storage_rate)::NUMERIC       AS "storageRate",
           0::SMALLINT                          AS "qualityFlag",
           'aggregate'                          AS "sourceId"
    FROM obs_daily
    JOIN ds ON ds.id = obs_daily.dam_id
    WHERE day >= ${opts.from} AND day < ${opts.to}
    GROUP BY day
    ORDER BY day
  `;
}

async function findWatershedSeriesMonthly(
  opts: FindWatershedSeriesOptions,
): Promise<SeriesPoint[]> {
  return sql<SeriesPoint[]>`
    WITH ds AS (SELECT id FROM dams WHERE watershed_id = ${opts.watershedId})
    SELECT month AS "observedAt",
           SUM(avg_storage_volume_m3)::NUMERIC AS "storageVolumeM3",
           NULL::NUMERIC                       AS "storageRate",
           0::SMALLINT                         AS "qualityFlag",
           'aggregate'                         AS "sourceId"
    FROM obs_monthly
    JOIN ds ON ds.id = obs_monthly.dam_id
    WHERE month >= ${opts.from} AND month < ${opts.to}
    GROUP BY month
    ORDER BY month
  `;
}

export async function findWatershedSeries(
  opts: FindWatershedSeriesOptions,
): Promise<SeriesPoint[]> {
  if (opts.bucket === 'hourly') return findWatershedSeriesHourly(opts);
  if (opts.bucket === 'daily') return findWatershedSeriesDaily(opts);
  return findWatershedSeriesMonthly(opts);
}

/**
 * Keyset position in the cross-dam feed. The observations PK is
 * `(dam_id, observed_at, source_id)`, so a single scalar cursor cannot
 * address a row — the feed pages on the full tuple instead.
 */
export interface ObservationCursor {
  observedAt: Date;
  damId: bigint;
  sourceId: string;
}

/**
 * One raw observation with its dam attached. NUMERIC columns are cast to
 * TEXT in the query, so the values are decimal strings — never rounded
 * through a JS float on the way out.
 */
export interface ObservationRow {
  observedAt: Date;
  damId: bigint;
  damSlug: string;
  damName: string;
  sourceId: string;
  storageVolumeM3: string | null;
  storageRate: string | null;
  inflowM3s: string | null;
  outflowM3s: string | null;
  waterLevelM: string | null;
  rainfallMm: string | null;
  qualityFlag: number;
}

export interface FindObservationsPageOptions {
  from: Date;
  /** Exclusive, matching findSeries(). */
  to: Date;
  pageSize: number;
  /** Position from the previous page; null starts at `from`. */
  after?: ObservationCursor | null;
  /**
   * Synthetic seed rows are excluded by default — the feed is a measured-value
   * feed, and `source_priorities` pins `synthetic` to the top for dams that
   * have no upstream yet, so including it silently would hand callers
   * placeholder numbers as if they were measurements.
   */
  includeSynthetic?: boolean;
}

export interface ObservationsPage {
  items: ObservationRow[];
  nextCursor: ObservationCursor | null;
}

/**
 * Cross-dam raw observation feed, ordered by `(observed_at, dam_id, source_id)`
 * and paged on that same tuple.
 */
export async function findObservationsPage(
  opts: FindObservationsPageOptions,
): Promise<ObservationsPage> {
  const limit = Math.max(1, Math.min(1000, opts.pageSize));
  const after = opts.after ?? null;
  const includeSynthetic = opts.includeSynthetic === true;
  // Advancing the lower bound to the cursor's timestamp keeps TimescaleDB's
  // chunk exclusion in play: a row-constructor comparison alone doesn't prune
  // the 14-day chunks already behind us.
  const from = after !== null && after.observedAt > opts.from ? after.observedAt : opts.from;
  const afterAt = after?.observedAt ?? null;
  const afterDamId = after?.damId ?? null;
  const afterSourceId = after?.sourceId ?? null;

  const rows = await sql<ObservationRow[]>`
    SELECT o.observed_at            AS "observedAt",
           o.dam_id                 AS "damId",
           d.slug                   AS "damSlug",
           d.name                   AS "damName",
           o.source_id              AS "sourceId",
           o.storage_volume_m3::TEXT AS "storageVolumeM3",
           o.storage_rate::TEXT      AS "storageRate",
           o.inflow_m3s::TEXT        AS "inflowM3s",
           o.outflow_m3s::TEXT       AS "outflowM3s",
           o.water_level_m::TEXT     AS "waterLevelM",
           o.rainfall_mm::TEXT       AS "rainfallMm",
           o.quality_flag           AS "qualityFlag"
    FROM observations o
    JOIN dams d ON d.id = o.dam_id
    WHERE o.observed_at >= ${from}
      AND o.observed_at <  ${opts.to}
      AND (${includeSynthetic}::boolean OR o.source_id <> 'synthetic')
      AND (${afterAt}::timestamptz IS NULL
           OR (o.observed_at, o.dam_id, o.source_id)
              > (${afterAt}::timestamptz, ${afterDamId}::bigint, ${afterSourceId}::text))
    ORDER BY o.observed_at, o.dam_id, o.source_id
    LIMIT ${limit + 1}
  `;

  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  const nextCursor =
    rows.length > limit && last
      ? { observedAt: last.observedAt, damId: last.damId, sourceId: last.sourceId }
      : null;
  return { items, nextCursor };
}
