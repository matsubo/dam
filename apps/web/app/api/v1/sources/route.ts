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
  rows_30d: number;
  distinct_dams_30d: number;
  latest_observed_at: Date | null;
}

export async function GET() {
  const rows = await sql<Row[]>`
    SELECT
      sp.source_id,
      sp.description,
      sp.priority,
      sp.active,
      lf.last_fetched_at,
      lf.last_status,
      COALESCE(o.rows_30d, 0)::INT          AS rows_30d,
      COALESCE(o.distinct_dams_30d, 0)::INT AS distinct_dams_30d,
      o.latest_observed_at
    FROM source_priorities sp
    LEFT JOIN LATERAL (
      SELECT fetched_at AS last_fetched_at, parse_status AS last_status
      FROM raw_snapshots WHERE source_id = sp.source_id
      ORDER BY fetched_at DESC LIMIT 1
    ) lf ON TRUE
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*)::INT                AS rows_30d,
        COUNT(DISTINCT dam_id)::INT  AS distinct_dams_30d,
        MAX(observed_at)             AS latest_observed_at
      FROM observations
      WHERE source_id = sp.source_id
        AND observed_at > NOW() - INTERVAL '30 days'
    ) o ON TRUE
    ORDER BY sp.priority DESC
  `;
  return hal(
    { sources: rows },
    {
      self: { href: '/api/v1/sources' },
      // Per-source detail follows a template; clients can hydrate each row.
      source: { href: '/api/v1/sources/{source_id}', templated: true },
    },
  );
}
