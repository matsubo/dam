import { sql } from '../client.ts';

export async function preferredSource(): Promise<string | null> {
  const rows = await sql<{ source_id: string }[]>`
    SELECT source_id FROM source_priorities WHERE active ORDER BY priority DESC LIMIT 1
  `;
  return rows[0]?.source_id ?? null;
}

export async function priorityMap(): Promise<Map<string, number>> {
  const rows = await sql<{ source_id: string; priority: number }[]>`
    SELECT source_id, priority FROM source_priorities WHERE active
  `;
  return new Map(rows.map((r) => [r.source_id, r.priority] as const));
}
