import { sql } from '@dam/db/client';
import { asProblem, HttpError } from '../../../../../lib/api/error.ts';
import { hal } from '../../../../../lib/api/response.ts';

export const dynamic = 'force-dynamic';

interface SourceRow {
  source_id: string;
  description: string | null;
  priority: number;
  active: boolean;
  rows_30d: number;
  distinct_dams_30d: number;
  latest_observed_at: Date | null;
  earliest_observed_at: Date | null;
}

interface DamRow {
  id: string;
  slug: string;
  name: string;
  pref_code: string;
  latest_observed_at: Date | null;
  latest_storage_volume_m3: string | null;
  latest_storage_rate: number | null;
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id: rawId } = await params;
    const id = decodeURIComponent(rawId);
    const sourceRows = await sql<SourceRow[]>`
      SELECT
        sp.source_id,
        sp.description,
        sp.priority,
        sp.active,
        COALESCE(o.rows_30d, 0)::INT          AS rows_30d,
        COALESCE(o.distinct_dams_30d, 0)::INT AS distinct_dams_30d,
        o.latest_observed_at,
        o.earliest_observed_at
      FROM source_priorities sp
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*)::INT                AS rows_30d,
          COUNT(DISTINCT dam_id)::INT  AS distinct_dams_30d,
          MAX(observed_at)             AS latest_observed_at,
          MIN(observed_at)             AS earliest_observed_at
        FROM observations
        WHERE source_id = sp.source_id
          AND observed_at > NOW() - INTERVAL '30 days'
      ) o ON TRUE
      WHERE sp.source_id = ${id}
      LIMIT 1
    `;
    const source = sourceRows[0];
    if (!source) throw new HttpError(404, 'Source not found');

    // Per-dam summary for the dams this source covers (capped at 200 to
    // keep the response bounded; tokyo-waterworks has 15, jwa-junpo 26,
    // synthetic >2k but that's the only one likely to hit the cap).
    const dams = await sql<DamRow[]>`
      SELECT
        d.id::TEXT          AS id,
        d.slug,
        d.name,
        d.pref_code,
        latest.observed_at  AS latest_observed_at,
        latest.storage_volume_m3::TEXT AS latest_storage_volume_m3,
        latest.storage_rate::FLOAT8    AS latest_storage_rate
      FROM dams d
      JOIN LATERAL (
        SELECT observed_at, storage_volume_m3, storage_rate
        FROM observations o
        WHERE o.dam_id = d.id
          AND o.source_id = ${id}
          AND o.observed_at > NOW() - INTERVAL '30 days'
        ORDER BY o.observed_at DESC
        LIMIT 1
      ) latest ON TRUE
      ORDER BY latest.observed_at DESC, d.id
      LIMIT 200
    `;

    return hal(
      {
        ...source,
        dams,
      },
      {
        self: { href: `/api/v1/sources/${encodeURIComponent(id)}` },
        index: { href: '/api/v1/sources' },
        web: { href: `/sources/${encodeURIComponent(id)}` },
      },
    );
  } catch (e) {
    return asProblem(e);
  }
}
