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
 * Call it with the WHOLE list the provider publishes, matched and unmatched
 * alike — a partial call would silently shrink the known universe. Where the
 * provider's catalogue is a constant in the task, build the list from that
 * constant rather than from the rows that happened to parse this run, so a
 * single failing page doesn't drop a station from the universe.
 */
export async function recordUniverse(sourceId: string, rows: UniverseRow[]): Promise<number> {
  // Fail-safe by design. Every one of the ~70 ingest tasks awaits this BEFORE
  // upsertObservations, so anything thrown here costs that run its
  // observations — the actual product — to protect coverage metadata, which
  // is only ever an explanation of the observations. That trade is never
  // worth making, so a failure is logged and swallowed. The known crash
  // (duplicate ON CONFLICT target) is fixed below; this guards the unknown
  // ones, and the next successful run re-records the same list anyway.
  try {
    return await recordUniverseOrThrow(sourceId, rows);
  } catch (err) {
    console.error(`recordUniverse(${sourceId}) failed; observations continue:`, err);
    return 0;
  }
}

async function recordUniverseOrThrow(sourceId: string, rows: UniverseRow[]): Promise<number> {
  // De-duplicate on the primary key before building the multi-row INSERT.
  // postgres.js emits one statement, and Postgres rejects a duplicate target
  // with `21000: ON CONFLICT DO UPDATE command cannot affect row a second
  // time`. Several providers legitimately repeat a station — the same dam
  // under both 水道用 and 工業用水 tables, or the same names in every monthly
  // ZIP — and callers run this BEFORE upsertObservations, so an exception
  // here would take the observation write down with it.
  //
  // LAST ENTRY WINS, and that is load-bearing: shimane, saitama and shizuoka
  // seed the full station list with `resolvedDamId: null` and then push the
  // resolved rows after it, so a station missing from today's snapshot still
  // counts as published while a matched one keeps its id. Changing this to
  // first-wins would silently null out those three sources' matches.
  const deduped = [...new Map(rows.map((r) => [r.externalId, r])).values()];
  if (deduped.length > 0) {
    const values = deduped.map((r) => ({
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
        -- Never downgrade a good match back to NULL. Some tasks resolve from
        -- rows that survived this run's fetch, so a partial outage would
        -- otherwise wipe resolved_dam_id for every station that happened to
        -- be missing — turning a matched dam into unmatched backlog. A real
        -- re-match still overwrites, because it supplies a non-NULL id.
        resolved_dam_id = COALESCE(EXCLUDED.resolved_dam_id, source_universe.resolved_dam_id),
        last_seen_at    = NOW()
    `;
  }
  // An empty list does NOT count as a scan. Every provider here publishes at
  // least one dam, so `rows.length === 0` means the fetch or parse failed —
  // and stamping a run for it would let a transient upstream outage close the
  // honesty gate and flip that provider's dams to 提供元なし.
  if (deduped.length === 0) return 0;
  await sql`
    INSERT INTO source_universe_runs (source_id, last_full_scan_at, row_count)
    VALUES (${sourceId}, NOW(), ${deduped.length})
    ON CONFLICT (source_id) DO UPDATE SET
      last_full_scan_at = EXCLUDED.last_full_scan_at,
      row_count         = EXCLUDED.row_count
  `;
  return deduped.length;
}

export type DamCoverageStatus =
  /** An observation landed in the last 30 days. */
  | 'covered'
  /** An upstream publishes this dam and we matched it, but nothing arrives. */
  | 'published_not_ingested'
  /** No scanned provider publishes it — but some provider is still unscanned. */
  | 'unknown'
  /** Every observation-producing provider has been scanned; none publishes it. */
  | 'not_published';

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
 *
 * Two residual caveats, both surfaced in `coverageSummary()` rather than
 * hidden:
 *  - `sourcesNotEnumerable` — providers that publish no station list at all
 *    (a portal that lists dams only during a flood event). They are excluded
 *    from the gate, so `not_published` stays provisional for their areas.
 *  - A handful of HTML-scraped providers (nara / niigata / miyagi) have no
 *    catalogue constant to iterate, so their universe is whatever parsed on
 *    the last good run. A station that reports even once ever is recorded and
 *    persists; one that has NEVER parsed stays invisible.
 */
export async function classifyDamCoverage(): Promise<DamCoverageRow[]> {
  return sql<DamCoverageRow[]>`
    WITH pending AS (
      SELECT COUNT(*)::INT AS n
      FROM source_priorities sp
      WHERE sp.active
        AND sp.provides_observations
        AND sp.universe_enumerable
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
             ELSE 'not_published'
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
  notPublished: number;
  /** Published stations we cannot tie to any master dam — the backlog. */
  unmatchedStations: number;
  /** Observation providers still to be instrumented. While > 0, `unknown` is not `not_published`. */
  sourcesPendingScan: number;
  /**
   * Providers that publish no enumerable station list (e.g. a portal that
   * only lists dams during a flood event). They are excluded from the gate,
   * so `not_published` carries a residual caveat for the areas they cover.
   */
  sourcesNotEnumerable: number;
}

export async function coverageSummary(): Promise<CoverageSummary> {
  const rows = await classifyDamCoverage();
  const count = (s: DamCoverageStatus): number => rows.filter((r) => r.status === s).length;
  const [extra] = await sql<{ unresolved: bigint; pending: bigint; not_enumerable: bigint }[]>`
    SELECT
      (SELECT COUNT(*) FROM source_universe WHERE resolved_dam_id IS NULL)::BIGINT AS unresolved,
      (SELECT COUNT(*) FROM source_priorities sp
        WHERE sp.active AND sp.provides_observations AND sp.universe_enumerable
          AND NOT EXISTS (SELECT 1 FROM source_universe_runs r WHERE r.source_id = sp.source_id)
      )::BIGINT AS pending,
      (SELECT COUNT(*) FROM source_priorities sp
        WHERE sp.active AND sp.provides_observations AND NOT sp.universe_enumerable
      )::BIGINT AS not_enumerable
  `;
  return {
    covered: count('covered'),
    publishedNotIngested: count('published_not_ingested'),
    unknown: count('unknown'),
    notPublished: count('not_published'),
    unmatchedStations: Number(extra?.unresolved ?? 0),
    sourcesPendingScan: Number(extra?.pending ?? 0),
    sourcesNotEnumerable: Number(extra?.not_enumerable ?? 0),
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
        AND sp.universe_enumerable
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
             ELSE 'not_published'
           END        AS "status",
           COALESCE((SELECT sources FROM published), ARRAY[]::TEXT[]) AS "publishedBy"
    FROM dams d
    WHERE d.id = ${damId}
  `;
  return rows[0] ?? null;
}
