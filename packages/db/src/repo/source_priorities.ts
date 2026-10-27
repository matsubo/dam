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
 * The best source for a dam over [from, to) (window_source(), 0226): the
 * highest-ranked source with a value in the window — the reading's tie-break
 * (priority of an active source, then source_id), and a source writing only
 * empty rows never wins. Null when no source has a value there: the caller
 * then leaves the source filter unset so any remaining rows still surface.
 *
 * Used by the per-dam observations API so the hourly chart shows one coherent
 * series from the best source for THAT dam.
 */
export async function windowSource(damId: bigint, from: Date, to: Date): Promise<string | null> {
  const [row] = await sql<{ source_id: string }[]>`
    SELECT source_id FROM window_source(${damId}, ${from}, ${to})
  `;
  return row?.source_id ?? null;
}

export async function priorityMap(): Promise<Map<string, number>> {
  const rows = await sql<{ source_id: string; priority: number }[]>`
    SELECT source_id, priority FROM source_priorities WHERE active
  `;
  return new Map(rows.map((r) => [r.source_id, r.priority] as const));
}
