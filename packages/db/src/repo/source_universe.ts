import { sql } from '../client.ts';

/**
 * One station as published by an upstream source, whether or not we managed
 * to tie it to a master dam.
 */
export interface UniverseRow {
  /**
   * The upstream's own stable id. Sources that publish none pass the
   * normalised dam name — and must then also pass `prefCode`, so two
   * identically-named dams in different prefectures stay distinct.
   */
  externalId: string;
  name: string;
  prefCode?: string | null;
  lat?: number | null;
  lng?: number | null;
  /** null = upstream publishes it but we can't match it to a master dam. */
  resolvedDamId?: bigint | null;
}

/**
 * Record the full list a source publishes, replacing nothing: rows are
 * upserted so `first_seen_at` survives and `last_seen_at` advances on every
 * scan. Stamping the run is what later lets `classifyDamCoverage` say
 * "nobody publishes this dam" instead of "we haven't looked yet".
 *
 * Call it with the WHOLE list the source returned, matched and unmatched
 * alike — a partial call would silently shrink the known universe.
 */
export async function recordUniverse(sourceId: string, rows: UniverseRow[]): Promise<number> {
  if (rows.length > 0) {
    const values = rows.map((r) => ({
      source_id: sourceId,
      source_external_id: r.externalId,
      source_name: r.name,
      pref_code: r.prefCode ?? null,
      lat: r.lat ?? null,
      lng: r.lng ?? null,
      resolved_dam_id: r.resolvedDamId ?? null,
    }));
    await sql`
      INSERT INTO source_universe ${sql(values)}
      ON CONFLICT (source_id, source_external_id) DO UPDATE SET
        source_name     = EXCLUDED.source_name,
        pref_code       = COALESCE(EXCLUDED.pref_code, source_universe.pref_code),
        lat             = COALESCE(EXCLUDED.lat, source_universe.lat),
        lng             = COALESCE(EXCLUDED.lng, source_universe.lng),
        resolved_dam_id = EXCLUDED.resolved_dam_id,
        last_seen_at    = NOW()
    `;
  }
  // Stamped even for an empty list: a source that genuinely publishes nothing
  // has still been looked at, and that is what the gate below cares about.
  await sql`
    INSERT INTO source_universe_runs (source_id, last_full_scan_at, row_count)
    VALUES (${sourceId}, NOW(), ${rows.length})
    ON CONFLICT (source_id) DO UPDATE SET
      last_full_scan_at = EXCLUDED.last_full_scan_at,
      row_count         = EXCLUDED.row_count
  `;
  return rows.length;
}

export type DamCoverageStatus =
  /** An observation landed in the last 30 days. */
  | 'covered'
  /** An upstream publishes this dam and we matched it, but nothing arrives. */
  | 'published_not_ingested'
  /** No upstream we have scanned publishes it — but some source is unscanned. */
  | 'unknown'
  /** Every observation-producing source has been scanned; none publishes it. */
  | 'no_upstream';

export interface DamCoverageRow {
  damId: bigint;
  slug: string;
  name: string;
  prefCode: string | null;
  status: DamCoverageStatus;
  /** Sources whose published list contains this dam. */
  publishedBy: string[];
}

/**
 * Per-dam answer to "is this dam's data published and we're failing to get
 * it, or does nobody publish it?".
 *
 * The `unknown` rung is the point of the whole design. A dam absent from
 * `source_universe` only means "nobody publishes it" once every
 * observation-producing source has recorded a scan; while any source is
 * still uninstrumented, absence proves nothing and the dam reports
 * `unknown`. Collapsing those two would quietly declare hundreds of dams
 * hopeless just because we never looked.
 */
export async function classifyDamCoverage(): Promise<DamCoverageRow[]> {
  return sql<DamCoverageRow[]>`
    WITH pending AS (
      SELECT COUNT(*)::INT AS n
      FROM source_priorities sp
      WHERE sp.active
        AND sp.provides_observations
        AND NOT EXISTS (
          SELECT 1 FROM source_universe_runs r WHERE r.source_id = sp.source_id
        )
    ),
    fresh AS (
      SELECT DISTINCT dam_id
      FROM observations
      WHERE observed_at > NOW() - INTERVAL '30 days'
    ),
    published AS (
      SELECT resolved_dam_id AS dam_id,
             ARRAY_AGG(DISTINCT source_id ORDER BY source_id) AS sources
      FROM source_universe
      WHERE resolved_dam_id IS NOT NULL
      GROUP BY resolved_dam_id
    )
    SELECT d.id                        AS "damId",
           d.slug                      AS "slug",
           d.name                      AS "name",
           d.pref_code                 AS "prefCode",
           CASE
             WHEN f.dam_id IS NOT NULL          THEN 'covered'
             WHEN p.dam_id IS NOT NULL          THEN 'published_not_ingested'
             WHEN (SELECT n FROM pending) > 0   THEN 'unknown'
             ELSE 'no_upstream'
           END                         AS "status",
           COALESCE(p.sources, ARRAY[]::TEXT[]) AS "publishedBy"
    FROM dams d
    LEFT JOIN fresh     f ON f.dam_id = d.id
    LEFT JOIN published p ON p.dam_id = d.id
    ORDER BY d.id
  `;
}

export interface CoverageSummary {
  covered: number;
  publishedNotIngested: number;
  unknown: number;
  noUpstream: number;
  /** Upstream stations we cannot tie to any master dam — the backlog. */
  unresolvedUpstreamRows: number;
  /** Observation sources still to be instrumented. While > 0, `unknown` is not `no_upstream`. */
  sourcesPendingScan: number;
}

export async function coverageSummary(): Promise<CoverageSummary> {
  const rows = await classifyDamCoverage();
  const count = (s: DamCoverageStatus): number => rows.filter((r) => r.status === s).length;
  const [extra] = await sql<{ unresolved: bigint; pending: bigint }[]>`
    SELECT
      (SELECT COUNT(*) FROM source_universe WHERE resolved_dam_id IS NULL)::BIGINT AS unresolved,
      (SELECT COUNT(*) FROM source_priorities sp
        WHERE sp.active AND sp.provides_observations
          AND NOT EXISTS (SELECT 1 FROM source_universe_runs r WHERE r.source_id = sp.source_id)
      )::BIGINT AS pending
  `;
  return {
    covered: count('covered'),
    publishedNotIngested: count('published_not_ingested'),
    unknown: count('unknown'),
    noUpstream: count('no_upstream'),
    unresolvedUpstreamRows: Number(extra?.unresolved ?? 0),
    sourcesPendingScan: Number(extra?.pending ?? 0),
  };
}

/** Same triage as `classifyDamCoverage`, for one dam. */
export async function classifyOneDam(damId: bigint): Promise<DamCoverageRow | null> {
  const rows = await sql<DamCoverageRow[]>`
    WITH pending AS (
      SELECT COUNT(*)::INT AS n
      FROM source_priorities sp
      WHERE sp.active
        AND sp.provides_observations
        AND NOT EXISTS (
          SELECT 1 FROM source_universe_runs r WHERE r.source_id = sp.source_id
        )
    ),
    published AS (
      SELECT ARRAY_AGG(DISTINCT source_id ORDER BY source_id) AS sources
      FROM source_universe
      WHERE resolved_dam_id = ${damId}
    )
    SELECT d.id       AS "damId",
           d.slug     AS "slug",
           d.name     AS "name",
           d.pref_code AS "prefCode",
           CASE
             WHEN EXISTS (
               SELECT 1 FROM observations o
               WHERE o.dam_id = d.id AND o.observed_at > NOW() - INTERVAL '30 days'
             )                                            THEN 'covered'
             WHEN (SELECT sources FROM published) IS NOT NULL THEN 'published_not_ingested'
             WHEN (SELECT n FROM pending) > 0             THEN 'unknown'
             ELSE 'no_upstream'
           END        AS "status",
           COALESCE((SELECT sources FROM published), ARRAY[]::TEXT[]) AS "publishedBy"
    FROM dams d
    WHERE d.id = ${damId}
  `;
  return rows[0] ?? null;
}
