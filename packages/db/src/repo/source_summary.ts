// The source summary: one shape for /sources, /sources/[id], /api/v1/sources
// and its detail. A declared source's facts (@dam/core/sources, ADR 0001)
// plus what it delivered in the last 30 days. Undeclared source_priorities
// rows are not sources the site describes.

import { allSourceFacts, type SourceFacts, sourceById, sourceFacts } from '@dam/core/sources';
import { sql } from '../client.ts';

export interface SourceSummary extends SourceFacts {
  /** Observation rows written in the last 30 days. */
  readonly rows30d: number;
  /** Dams with at least one of those rows. */
  readonly dams30d: number;
  /** Newest and oldest observed_at among those rows (null without any). */
  readonly latestObservedAt: Date | null;
  readonly earliestObservedAt: Date | null;
}

interface Stats {
  sourceId: string;
  rows30d: number;
  dams30d: number;
  latestObservedAt: Date | null;
  earliestObservedAt: Date | null;
}

/**
 * 30-day statistics per source, or for one source. Per (source, dam) first,
 * then per source: COUNT(DISTINCT dam_id) sorted the window to disk (#108).
 */
async function stats30d(sourceId: string | null): Promise<Map<string, Stats>> {
  const rows = await sql<Stats[]>`
    SELECT
      source_id         AS "sourceId",
      SUM(n)::INT       AS "rows30d",
      COUNT(*)::INT     AS "dams30d",
      MAX(latest)       AS "latestObservedAt",
      MIN(earliest)     AS "earliestObservedAt"
    FROM (
      SELECT source_id, dam_id, COUNT(*) AS n,
             MAX(observed_at) AS latest, MIN(observed_at) AS earliest
      FROM observations
      WHERE observed_at > NOW() - INTERVAL '30 days'
        AND (${sourceId}::TEXT IS NULL OR source_id = ${sourceId})
      GROUP BY source_id, dam_id
    ) per_dam
    GROUP BY source_id
  `;
  return new Map(rows.map((r) => [r.sourceId, r]));
}

function summarize(facts: SourceFacts, stats: Stats | undefined): SourceSummary {
  return {
    ...facts,
    rows30d: stats?.rows30d ?? 0,
    dams30d: stats?.dams30d ?? 0,
    latestObservedAt: stats?.latestObservedAt ?? null,
    earliestObservedAt: stats?.earliestObservedAt ?? null,
  };
}

/** Every declared source, highest priority first. */
export async function sourceSummaries(): Promise<SourceSummary[]> {
  const stats = await stats30d(null);
  return allSourceFacts().map((f) => summarize(f, stats.get(f.sourceId)));
}

/** One declared source, or null for an id no declaration has. */
export async function sourceSummary(sourceId: string): Promise<SourceSummary | null> {
  const declaration = sourceById(sourceId);
  if (!declaration) return null;
  const stats = await stats30d(sourceId);
  return summarize(sourceFacts(declaration), stats.get(sourceId));
}

export interface SourceDam {
  readonly id: bigint;
  readonly slug: string;
  readonly name: string;
  readonly prefCode: string;
  /** This source's newest row for the dam in the last 30 days. */
  readonly latestObservedAt: Date;
  readonly latestStorageVolumeM3: string | null;
  readonly latestStorageRate: number | null;
}

/** The dams a source delivered in the last 30 days, most recent first. */
export async function sourceDams(sourceId: string, limit = 200): Promise<SourceDam[]> {
  return sql<SourceDam[]>`
    SELECT
      d.id, d.slug, d.name, d.pref_code AS "prefCode",
      latest.observed_at                AS "latestObservedAt",
      latest.storage_volume_m3::TEXT    AS "latestStorageVolumeM3",
      latest.storage_rate::FLOAT8       AS "latestStorageRate"
    FROM dams d
    JOIN LATERAL (
      SELECT observed_at, storage_volume_m3, storage_rate
      FROM observations o
      WHERE o.dam_id = d.id
        AND o.source_id = ${sourceId}
        AND o.observed_at > NOW() - INTERVAL '30 days'
      ORDER BY o.observed_at DESC
      LIMIT 1
    ) latest ON TRUE
    ORDER BY latest.observed_at DESC, d.id
    LIMIT ${limit}
  `;
}
