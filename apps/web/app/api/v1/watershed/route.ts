import { findNearestWatershed, findWatershedContaining } from '@dam/db/repo/watersheds';
import { z } from 'zod';
import { authorize, rateLimitHeaders } from '../../../../lib/api/auth.ts';
import { asProblem, HttpError } from '../../../../lib/api/error.ts';
import { hal } from '../../../../lib/api/response.ts';

export const dynamic = 'force-dynamic';

const Query = z.object({
  lat: z.string().min(1).transform(Number).pipe(z.number().gte(-90).lte(90)),
  lng: z.string().min(1).transform(Number).pipe(z.number().gte(-180).lte(180)),
});

export async function GET(req: Request): Promise<Response> {
  try {
    const auth = await authorize(req);
    if (!auth.ok) {
      const headers: Record<string, string> = {
        'content-type': 'application/problem+json',
      };
      if (auth.rate) {
        Object.assign(headers, rateLimitHeaders(auth.rate));
        if (auth.status === 429) {
          headers['Retry-After'] = String(
            Math.max(0, Math.ceil((auth.rate.resetAt - Date.now()) / 1000)),
          );
        }
      }
      return new Response(
        JSON.stringify({ type: 'about:blank', title: auth.reason, status: auth.status }),
        { status: auth.status, headers },
      );
    }

    const url = new URL(req.url);
    const parsed = Query.safeParse({
      lat: url.searchParams.get('lat'),
      lng: url.searchParams.get('lng'),
    });
    if (!parsed.success) throw new HttpError(400, 'Invalid lat/lng');
    const { lat, lng } = parsed.data;

    const w = await findWatershedContaining(lat, lng);
    const selfHref = `/api/v1/watershed?lat=${lat}&lng=${lng}`;

    if (w) {
      return hal(
        {
          watershed: { code: w.code, slug: w.slug, name: w.name, kind: w.kind, ndiCode: w.ndiCode },
        },
        {
          self: { href: selfHref },
          watershed: { href: `/api/v1/watersheds/${w.slug}` },
          dams_in_watershed: { href: `/api/v1/watersheds/${w.slug}/dams` },
          web: { href: `/watersheds/${w.slug}` },
        },
        { headers: rateLimitHeaders(auth.rate) },
      );
    }

    const nearest = await findNearestWatershed(lat, lng);
    return new Response(
      JSON.stringify({
        type: 'about:blank',
        title: 'No watershed contains the given coordinates',
        status: 404,
        _links: {
          self: { href: selfHref },
          nearest: nearest ? { href: `/api/v1/watersheds/${nearest.slug}` } : undefined,
        },
      }),
      {
        status: 404,
        headers: {
          'content-type': 'application/problem+json',
          ...rateLimitHeaders(auth.rate),
        },
      },
    );
  } catch (err) {
    return asProblem(err);
  }
}
