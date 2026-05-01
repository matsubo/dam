import type { FetchTarget } from '@dam/core/source_adapter';
import { sql } from '@dam/db/client';

const BASE = process.env.KASENBOSAI_BASE_URL ?? 'https://www.river.go.jp/kawabou/sample/?fid=';

/**
 * Resolve all dams that have a kasenbosai external_id. The crawler only
 * targets dams already in the master.
 */
export async function buildTargets(): Promise<FetchTarget[]> {
  const rows = await sql<{ kb: string }[]>`
    SELECT external_ids ->> 'kasenbosai' AS kb
    FROM dams
    WHERE external_ids ? 'kasenbosai'
    ORDER BY id
  `;
  return rows.map((r) => ({ targetId: r.kb, url: `${BASE}${encodeURIComponent(r.kb)}` }));
}
