import {
  findDamBySlug,
  latestObservation,
  latestRateAndSourceByDam,
  nearbyDams,
} from '@dam/db/repo/dams';
import { authorize, makeUnauthorized, rateLimitHeaders } from '../../../../../lib/api/auth.ts';
import { asProblem, HttpError } from '../../../../../lib/api/error.ts';
import { hal } from '../../../../../lib/api/response.ts';

export const dynamic = 'force-dynamic';

interface DamPublicViewInput {
  id: bigint;
  slug: string;
  name: string;
  prefCode: string;
  manager: string | null;
  totalCapacityM3: string | null;
  activeCapacityM3: string | null;
  lat: number;
  lng: number;
  watershedSlug: string | null;
  watershedName: string | null;
}

function damPublicView(d: DamPublicViewInput) {
  return {
    id: d.id.toString(),
    slug: d.slug,
    name: d.name,
    prefCode: d.prefCode,
    manager: d.manager,
    totalCapacityM3: d.totalCapacityM3,
    activeCapacityM3: d.activeCapacityM3,
    location: { lat: d.lat, lng: d.lng },
    watershed: d.watershedSlug ? { slug: d.watershedSlug, name: d.watershedName } : null,
  };
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  try {
    const auth = await authorize(req);
    if (!auth.ok) return makeUnauthorized(auth);

    const { slug } = await params;
    const dam = await findDamBySlug(slug);
    if (!dam) throw new HttpError(404, 'Dam not found');

    const [latest, nearby, rateAndSource] = await Promise.all([
      latestObservation(dam.id),
      nearbyDams(dam.id, 20_000, 10),
      latestRateAndSourceByDam([dam.id]),
    ]);
    const ras = rateAndSource.get(dam.id.toString());
    const realSourceId = ras?.realSourceId ?? null;

    return hal(
      {
        ...damPublicView(dam),
        nameKana: dam.nameKana,
        type: dam.type,
        heightM: dam.heightM,
        effectiveCapacityM3: dam.effectiveCapacityM3,
        floodCapacityM3: dam.floodCapacityM3,
        completedYear: dam.completedYear,
        externalIds: dam.externalIds,
        latest,
        // Explicit dataRealness block so API consumers don't have to compare
        // `latest.sourceId` strings or guess at the synthetic-seed boundary.
        // hasRealDataLast30d means: at least one upstream-fed observation
        // exists in the last 30 days. realSourceId is the source_id of the
        // most-recent such observation (or null if none).
        dataRealness: {
          hasRealDataLast30d: realSourceId !== null,
          realSourceId,
        },
        nearby: nearby.map(damPublicView),
      },
      {
        self: { href: `/api/v1/dams/${slug}` },
        observations: {
          href: `/api/v1/dams/${slug}/observations{?from,to,interval}`,
          templated: true,
        },
        watershed: dam.watershedSlug ? { href: `/api/v1/watersheds/${dam.watershedSlug}` } : null,
        prefecture: { href: `/api/v1/prefectures/${dam.prefCode}/dams` },
        sources: { href: `/api/v1/dams/${slug}/sources` },
        web: { href: `/dams/${slug}` },
      },
      { headers: rateLimitHeaders(auth.rate) },
    );
  } catch (e) {
    return asProblem(e);
  }
}
