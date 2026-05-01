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
  qualityFlag: number;
  sourceId: string;
}

export interface FindSeriesOptions {
  damId: bigint;
  from: Date;
  to: Date;
  bucket: 'hourly' | 'daily' | 'monthly';
  preferredSource?: string | null;
}

async function findSeriesHourly(opts: FindSeriesOptions): Promise<SeriesPoint[]> {
  const preferred = opts.preferredSource ?? null;
  return sql<SeriesPoint[]>`
    SELECT observed_at AS "observedAt",
           storage_volume_m3 AS "storageVolumeM3",
           storage_rate AS "storageRate",
           quality_flag AS "qualityFlag",
           source_id AS "sourceId"
    FROM observations
    WHERE dam_id = ${opts.damId}
      AND observed_at >= ${opts.from}
      AND observed_at <  ${opts.to}
      AND (${preferred}::text IS NULL OR source_id = ${preferred})
    ORDER BY observed_at
  `;
}

async function findSeriesDaily(opts: FindSeriesOptions): Promise<SeriesPoint[]> {
  return sql<SeriesPoint[]>`
    SELECT day AS "observedAt",
           last_storage_volume_m3 AS "storageVolumeM3",
           NULL::NUMERIC AS "storageRate",
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
  return sql<SeriesPoint[]>`
    SELECT month AS "observedAt",
           last_storage_volume_m3 AS "storageVolumeM3",
           NULL::NUMERIC AS "storageRate",
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
