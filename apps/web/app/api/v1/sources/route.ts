import { sql } from '@dam/db/client';
import { hal } from '../../../../lib/api/response.ts';

export const dynamic = 'force-dynamic';

interface Row {
  source_id: string;
  description: string | null;
  priority: number;
  active: boolean;
  last_fetched_at: Date | null;
  last_status: string | null;
}

export async function GET() {
  const rows = await sql<Row[]>`
    SELECT
      sp.source_id,
      sp.description,
      sp.priority,
      sp.active,
      lf.last_fetched_at,
      lf.last_status
    FROM source_priorities sp
    LEFT JOIN LATERAL (
      SELECT fetched_at AS last_fetched_at, parse_status AS last_status
      FROM raw_snapshots WHERE source_id = sp.source_id
      ORDER BY fetched_at DESC LIMIT 1
    ) lf ON TRUE
    ORDER BY sp.priority DESC
  `;
  return hal({ sources: rows }, { self: { href: '/api/v1/sources' } });
}
