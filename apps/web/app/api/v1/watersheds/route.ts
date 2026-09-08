import { listWatersheds } from '@dam/db/repo/watersheds';
import { z } from 'zod';
import { authorize, makeUnauthorized, rateLimitHeaders } from '../../../../lib/api/auth.ts';
import { HttpError, asProblem } from '../../../../lib/api/error.ts';
import { pageLinks, rfc5988Link } from '../../../../lib/api/pagination.ts';
import { hal } from '../../../../lib/api/response.ts';

export const dynamic = 'force-dynamic';

const Query = z.object({
  kind: z.enum(['first', 'second']).optional(),
  cursor: z
    .string()
    .regex(/^[0-9]+$/)
    .optional(),
  pageSize: z
    .string()
    .regex(/^[0-9]+$/)
    .optional(),
});

export async function GET(req: Request): Promise<Response> {
  try {
    const auth = await authorize(req);
    if (!auth.ok) return makeUnauthorized(auth);

    const url = new URL(req.url);
    const parsed = Query.safeParse(Object.fromEntries(url.searchParams));
    if (!parsed.success) throw new HttpError(400, 'Invalid query');

    const r = await listWatersheds({
      kind: parsed.data.kind ?? null,
      cursor: parsed.data.cursor ? BigInt(parsed.data.cursor) : null,
      pageSize: parsed.data.pageSize ? Number(parsed.data.pageSize) : 200,
    });

    const self = url.pathname + url.search;
    const linkHeader = rfc5988Link(r.nextCursor, self);
    return hal(
      {
        items: r.items.map((w) => ({
          id: w.id.toString(),
          slug: w.slug,
          code: w.code,
          name: w.name,
          kind: w.kind,
          ndiCode: w.ndiCode,
          damCount: w.damCount,
        })),
        count: r.items.length,
      },
      pageLinks(self, r.nextCursor),
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
