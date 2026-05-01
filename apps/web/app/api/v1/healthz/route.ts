import { sql } from '@dam/db/client';
import { hal } from '../../../../lib/api/response.ts';

export const dynamic = 'force-dynamic';

export async function GET() {
  await sql`SELECT 1`;
  return hal({ status: 'ok' }, { self: { href: '/api/v1/healthz' } });
}
