// Public geolocation → watershed jump: /watersheds/locate?lat=..&lng=..
// redirects to the watershed page containing the point (or the nearest one).
// This is a page-side route so the home "現在地から水系を見る" button works
// without an API key.

import { findNearestWatershed, findWatershedContaining } from '@dam/db/repo/watersheds';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

const Query = z.object({
  lat: z.string().min(1).transform(Number).pipe(z.number().gte(-90).lte(90)),
  lng: z.string().min(1).transform(Number).pipe(z.number().gte(-180).lte(180)),
});

function redirect(location: string): Response {
  return new Response(null, { status: 307, headers: { location } });
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const parsed = Query.safeParse({
    lat: url.searchParams.get('lat'),
    lng: url.searchParams.get('lng'),
  });
  if (!parsed.success) return redirect('/watersheds?locate=invalid');
  const { lat, lng } = parsed.data;

  const contained = await findWatershedContaining(lat, lng);
  const w = contained ?? (await findNearestWatershed(lat, lng));
  if (!w) return redirect('/watersheds?locate=notfound');
  return redirect(`/watersheds/${encodeURIComponent(w.slug)}`);
}
