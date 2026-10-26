import { SOURCES, type SourceDeclaration } from '@dam/core/sources';
import { sql } from '../client.ts';

export interface SourceSyncResult {
  synced: number;
  /** Rows with no declaration: left untouched, reported so they get one. */
  undeclared: string[];
}

/**
 * Write every declared source's row (docs/adr/0001): the declaration is the
 * only owner of these columns. Rows nobody declares are left alone.
 */
export async function syncSourcePriorities(
  declarations: readonly SourceDeclaration[] = SOURCES,
): Promise<SourceSyncResult> {
  const rows = declarations.map((s) => ({
    source_id: s.id,
    priority: s.priority,
    description: s.description,
    active: s.status !== 'retired',
    provides_observations: s.providesObservations,
    universe_enumerable: s.universeEnumerable,
    historical_only: s.status === 'historical',
    trusted_rate_basis: s.trustedRateBasis,
  }));
  if (rows.length > 0) {
    await sql`
      INSERT INTO source_priorities ${sql(rows)}
      ON CONFLICT (source_id) DO UPDATE SET
        priority              = EXCLUDED.priority,
        description           = EXCLUDED.description,
        active                = EXCLUDED.active,
        provides_observations = EXCLUDED.provides_observations,
        universe_enumerable   = EXCLUDED.universe_enumerable,
        historical_only       = EXCLUDED.historical_only,
        trusted_rate_basis    = EXCLUDED.trusted_rate_basis
    `;
  }
  const declared = declarations.map((s) => s.id);
  const undeclared = await sql<{ source_id: string }[]>`
    SELECT source_id FROM source_priorities
    WHERE source_id <> ALL(${declared}::TEXT[])
    ORDER BY source_id
  `;
  return { synced: rows.length, undeclared: undeclared.map((r) => r.source_id) };
}

export async function preferredSource(): Promise<string | null> {
  const rows = await sql<{ source_id: string }[]>`
    SELECT source_id FROM source_priorities WHERE active ORDER BY priority DESC LIMIT 1
  `;
  return rows[0]?.source_id ?? null;
}

/**
 * Pick the highest-priority active source that has at least one observation
 * for the given dam in [from, to). Returns null if no source has data in
 * the window — the caller should then leave the source filter unset so any
 * remaining rows still surface.
 *
 * Used by the per-dam observations API so the hourly chart shows the best
 * available source for THAT dam, instead of a single global pick that may
 * not cover the dam at all (previous behaviour produced 0-point hourly
 * graphs whenever the dam's data lived under a non-top-priority source).
 */
export async function preferredSourceForDam(
  damId: bigint,
  from: Date,
  to: Date,
): Promise<string | null> {
  const rows = await sql<{ source_id: string }[]>`
    SELECT sp.source_id
    FROM source_priorities sp
    WHERE sp.active
      AND EXISTS (
        SELECT 1 FROM observations o
        WHERE o.dam_id = ${damId}
          AND o.source_id = sp.source_id
          AND o.observed_at >= ${from}
          AND o.observed_at <  ${to}
      )
    ORDER BY sp.priority DESC
    LIMIT 1
  `;
  return rows[0]?.source_id ?? null;
}

export async function priorityMap(): Promise<Map<string, number>> {
  const rows = await sql<{ source_id: string; priority: number }[]>`
    SELECT source_id, priority FROM source_priorities WHERE active
  `;
  return new Map(rows.map((r) => [r.source_id, r.priority] as const));
}
