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
  /**
   * Hourly bucket only — drops `source_id = 'synthetic'` rows from the
   * per-dam input before bucketing, and skips per-dam source preference so
   * every remaining real source surfaces. The watershed aggregate then
   * reflects only dams whose values are actually measured.
   */
  excludeSynthetic?: boolean;
}

/**
 * How far before `from` the hourly aggregate scans. `locf()` can only carry a
 * value forward from a row it has seen, so without a run-up the first buckets
 * omit every dam whose last report predates the window — the same cohort dip
 * the carry-forward exists to remove. 48 h covers the hourly and daily feed
 * cadences; a dam silent for longer than that stays out of the series, which
 * is the honest outcome.
 */
const HOURLY_LOOKBACK_MS = 48 * 60 * 60 * 1000;

// Aggregate the watershed's storage by summing per-dam bucket volumes. Dams in
// one watershed don't share a reporting cadence, so summing only the dams that
// posted inside each hour made the total jump by whole dams — 信濃川 alternated
// between 13.5M and 4.3M m³, and every watershed's last bucket (the in-progress
// hour) collapsed to whichever dams had already posted. Gapfill + locf carry
// each dam's last known value forward so every bucket sums the same cohort.
async function findWatershedSeriesHourly(opts: FindWatershedSeriesOptions): Promise<SeriesPoint[]> {
  const excludeSynthetic = opts.excludeSynthetic === true;
  const scanFrom = new Date(opts.from.valueOf() - HOURLY_LOOKBACK_MS);
  return sql<SeriesPoint[]>`
    WITH ds AS (SELECT id FROM dams WHERE watershed_id = ${opts.watershedId}),
    -- One source per dam. A watershed's dams routinely report under different
    -- feeds (MLIT, prefecture 防災, JWA), so the single global pick this used
    -- to apply filtered out every dam not on the top-priority source — which
    -- emptied the 1-week chart for most watersheds. Same fix as
    -- preferredSourceForDam() at the dam level, just resolved per dam in SQL.
    --
    -- Best first: real data over synthetic seed rows, then sources that carry
    -- a volume in this window (high-priority feeds can have their volumes
    -- NULLed as phantoms), then source_priorities rank. Unranked sources are
    -- kept as a last resort so a dam on an unlisted feed still counts.
    pref AS (
      SELECT DISTINCT ON (o.dam_id) o.dam_id, o.source_id
      FROM observations o
      JOIN ds ON ds.id = o.dam_id
      LEFT JOIN source_priorities sp ON sp.source_id = o.source_id AND sp.active
      WHERE o.observed_at >= ${scanFrom}
        AND o.observed_at <  ${opts.to}
      ORDER BY o.dam_id,
               (o.source_id = 'synthetic'),
               (o.storage_volume_m3 IS NULL),
               (sp.priority IS NULL),
               sp.priority DESC NULLS LAST
    ),
    bucketed AS (
      SELECT
        time_bucket_gapfill('1 hour', o.observed_at,
                            start => ${scanFrom}, finish => ${opts.to}) AS bucket,
        o.dam_id,
        locf(last(o.storage_volume_m3, o.observed_at)) AS volume,
        locf(last(o.storage_rate, o.observed_at))      AS rate
      FROM observations o
      JOIN ds ON ds.id = o.dam_id
      LEFT JOIN pref ON pref.dam_id = o.dam_id
      WHERE o.observed_at >= ${scanFrom}
        AND o.observed_at <  ${opts.to}
        AND (${excludeSynthetic}::boolean OR o.source_id = pref.source_id)
        AND (NOT ${excludeSynthetic}::boolean OR o.source_id <> 'synthetic')
      GROUP BY bucket, o.dam_id
    )
    SELECT bucket AS "observedAt",
           SUM(volume)::NUMERIC AS "storageVolumeM3",
           AVG(rate)::NUMERIC   AS "storageRate",
           0::SMALLINT          AS "qualityFlag",
           'aggregate'          AS "sourceId"
    FROM bucketed
    -- Drop the run-up buckets. Snapped to the hour so a mid-hour "from"
    -- still keeps its own (now carry-forward-complete) bucket.
    WHERE bucket >= time_bucket('1 hour', ${opts.from}::timestamptz)
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
