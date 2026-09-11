import { watershedSeasonalNorm } from '@dam/db/repo/seasonal';
import { aggregateWatershed, findWatershedBySlug } from '@dam/db/repo/watersheds';
import { authorize, makeUnauthorized, rateLimitHeaders } from '../../../../../../lib/api/auth.ts';
import { asProblem, HttpError } from '../../../../../../lib/api/error.ts';
import { hal } from '../../../../../../lib/api/response.ts';

export const dynamic = 'force-dynamic';

export async function GET(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  try {
    const auth = await authorize(req);
    if (!auth.ok) return makeUnauthorized(auth);

    const { slug } = await params;
    const w = await findWatershedBySlug(slug);
    if (!w) throw new HttpError(404, 'Watershed not found');
    const [agg, seasonalNorm] = await Promise.all([
      aggregateWatershed(w.id),
      watershedSeasonalNorm(w.id),
    ]);

    return hal(
      { ...agg, seasonalNorm },
      {
        self: { href: `/api/v1/watersheds/${slug}/aggregate` },
        watershed: { href: `/api/v1/watersheds/${slug}` },
      },
      { headers: rateLimitHeaders(auth.rate) },
    );
  } catch (e) {
    return asProblem(e);
  }
}
