import { sql } from '../client.ts';

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
