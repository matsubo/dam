import { listDams } from '@dam/db/repo/dams';
import { z } from 'zod';
import { authorize, makeUnauthorized, rateLimitHeaders } from '../../../../lib/api/auth.ts';
import { HttpError, asProblem } from '../../../../lib/api/error.ts';
import { pageLinks, rfc5988Link } from '../../../../lib/api/pagination.ts';
import { hal } from '../../../../lib/api/response.ts';

export const dynamic = 'force-dynamic';

const Query = z.object({
  pref: z
    .string()
    .regex(/^[0-9]{2}$/)
    .optional(),
  watershed: z.string().optional(),
  manager: z.string().optional(),
  search: z.string().optional(),
  cursor: z
    .string()
    .regex(/^[0-9]+$/)
    .optional(),
  pageSize: z
    .string()
    .regex(/^[0-9]+$/)
    .optional(),
  /** '1' / 'true' restricts to dams with at least one non-synthetic observation in the last 30 days. */
  real: z.enum(['0', '1', 'true', 'false']).optional(),
  /** When set, restrict to dams with a recent observation from this source_id (e.g. tokyo-waterworks, jwa-junpo). */
  source: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9_:-]+$/)
    .optional(),
});

export async function GET(req: Request): Promise<Response> {
  try {
    const auth = await authorize(req);
    if (!auth.ok) return makeUnauthorized(auth);

    const url = new URL(req.url);
    const parsed = Query.safeParse(Object.fromEntries(url.searchParams));
    if (!parsed.success) throw new HttpError(400, 'Invalid query');
    const { pref, watershed, manager, search, cursor, pageSize, real, source } = parsed.data;
    const realDataOnly = real === '1' || real === 'true';

    const r = await listDams({
      pref: pref ?? null,
      watershedSlug: watershed ?? null,
      manager: manager ?? null,
      search: search ?? null,
      cursor: cursor ? BigInt(cursor) : null,
      pageSize: pageSize ? Number(pageSize) : 50,
      realDataOnly,
      source: source ?? null,
    });

    const self = url.pathname + url.search;
    const linkHeader = rfc5988Link(r.nextCursor, self);
    return hal(
      {
        items: r.items.map((d) => ({
          id: d.id.toString(),
          slug: d.slug,
          name: d.name,
          prefCode: d.prefCode,
          manager: d.manager,
          totalCapacityM3: d.totalCapacityM3,
          location: { lat: d.lat, lng: d.lng },
          watershed: d.watershedSlug ? { slug: d.watershedSlug, name: d.watershedName } : null,
        })),
        count: r.items.length,
      },
      { ...pageLinks(self, r.nextCursor) },
      {
        headers: {
          ...rateLimitHeaders(auth.rate),
          ...(linkHeader ? { Link: linkHeader } : {}),
        },
      },
    );
  } catch (e) {
    return asProblem(e);
  }
}
