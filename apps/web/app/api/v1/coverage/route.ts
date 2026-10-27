import { sourceLabel } from '@dam/core/sources';
import { COVERAGE_STATUS, COVERAGE_STATUSES, coverageSnapshot } from '@dam/db/repo/coverage';
import { z } from 'zod';
import { authorize, makeUnauthorized, rateLimitHeaders } from '../../../../lib/api/auth.ts';
import { asProblem, HttpError } from '../../../../lib/api/error.ts';
import { hal } from '../../../../lib/api/response.ts';

export const dynamic = 'force-dynamic';

const Query = z.object({
  status: z.enum(COVERAGE_STATUSES).optional(),
  pref: z
    .string()
    .regex(/^[0-9]{2}$/)
    .optional(),
});

export async function GET(req: Request): Promise<Response> {
  try {
    const auth = await authorize(req);
    if (!auth.ok) return makeUnauthorized(auth);

    const url = new URL(req.url);
    const parsed = Query.safeParse(Object.fromEntries(url.searchParams));
    if (!parsed.success) throw new HttpError(400, 'Invalid query');

    const { summary, dams } = await coverageSnapshot();
    const items = dams
      .filter((r) => (parsed.data.status ? r.status === parsed.data.status : true))
      .filter((r) => (parsed.data.pref ? r.prefCode === parsed.data.pref : true));

    return hal(
      {
        summary: {
          ...summary,
          pendingScanSources: summary.pendingScanSources.map((p) => {
            const id = encodeURIComponent(p.sourceId);
            return {
              sourceId: p.sourceId,
              label: sourceLabel(p.sourceId),
              reason: p.reason,
              _links: {
                source: { href: `/api/v1/sources/${id}` },
                web: { href: `/sources/${id}` },
              },
            };
          }),
        },
        // Restated in the payload so a client never has to guess whether
        // `notPublished` means "nobody publishes it" or "we haven't looked".
        statusMeanings: Object.fromEntries(
          COVERAGE_STATUSES.map((s) => [s, COVERAGE_STATUS[s].meaning]),
        ),
        items: items.map((r) => ({
          damId: r.damId.toString(),
          slug: r.slug,
          name: r.name,
          prefCode: r.prefCode,
          status: r.status,
          publishedBy: r.publishedBy,
          _links: { dam: { href: `/api/v1/dams/${r.slug}` } },
        })),
        count: items.length,
      },
      {
        self: { href: '/api/v1/coverage' },
        web: { href: '/coverage' },
        dams: { href: '/api/v1/dams' },
      },
      { headers: rateLimitHeaders(auth.rate) },
    );
  } catch (e) {
    return asProblem(e);
  }
}
