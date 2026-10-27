import { sourceSummaries } from '@dam/db/repo/source_summary';
import { hal } from '../../../../lib/api/response.ts';

export const dynamic = 'force-dynamic';

export async function GET() {
  return hal(
    { items: await sourceSummaries() },
    {
      self: { href: '/api/v1/sources' },
      source: { href: '/api/v1/sources/{sourceId}', templated: true },
      web: { href: '/sources' },
    },
  );
}
