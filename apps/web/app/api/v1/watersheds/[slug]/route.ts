import { aggregateWatershed, findWatershedBySlug } from '@dam/db/repo/watersheds';
import { authorize, makeUnauthorized, rateLimitHeaders } from '../../../../../lib/api/auth.ts';
import { asProblem, HttpError } from '../../../../../lib/api/error.ts';
import { hal } from '../../../../../lib/api/response.ts';

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
    const agg = await aggregateWatershed(w.id);

    return hal(
      { ...w, id: w.id.toString(), aggregate: agg },
      {
        self: { href: `/api/v1/watersheds/${slug}` },
        dams: { href: `/api/v1/watersheds/${slug}/dams` },
        aggregate: { href: `/api/v1/watersheds/${slug}/aggregate` },
        web: { href: `/watersheds/${slug}` },
      },
      { headers: rateLimitHeaders(auth.rate) },
    );
  } catch (e) {
    return asProblem(e);
  }
}
