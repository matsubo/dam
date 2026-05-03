import { sql } from '@dam/db/client';
import { findWatershedSeries } from '@dam/db/repo/observations';
import { preferredSource } from '@dam/db/repo/source_priorities';
import { z } from 'zod';
import { HttpError, asProblem } from '../../../../../../lib/api/error.ts';
import { hal } from '../../../../../../lib/api/response.ts';

export const dynamic = 'force-dynamic';

const Query = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  interval: z.enum(['hourly', 'daily', 'monthly']),
});

export async function GET(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  try {
    const { slug: rawSlug } = await params;
    const slug = decodeURIComponent(rawSlug);
    const url = new URL(req.url);
    const parsed = Query.safeParse({
      from: url.searchParams.get('from'),
      to: url.searchParams.get('to'),
      interval: url.searchParams.get('interval'),
    });
    if (!parsed.success) throw new HttpError(400, 'Invalid query');
    const from = new Date(parsed.data.from);
    const to = new Date(parsed.data.to);
    if (Number.isNaN(from.valueOf()) || Number.isNaN(to.valueOf())) {
      throw new HttpError(400, 'Invalid from/to');
    }

    const wsRows = await sql<
      { id: bigint; total_capacity_m3: string | null }[]
    >`SELECT w.id, COALESCE(SUM(d.total_capacity_m3), 0)::TEXT AS total_capacity_m3
      FROM watersheds w
      LEFT JOIN dams d ON d.watershed_id = w.id
      WHERE w.slug = ${slug}
      GROUP BY w.id
      LIMIT 1`;
    const ws = wsRows[0];
    if (!ws) throw new HttpError(404, 'Watershed not found');

    const preferred = parsed.data.interval === 'hourly' ? await preferredSource() : null;
    const series = await findWatershedSeries({
      watershedId: ws.id,
      from,
      to,
      bucket: parsed.data.interval,
      preferredSource: preferred,
    });

    const self = `/api/v1/watersheds/${rawSlug}/observations?from=${parsed.data.from}&to=${parsed.data.to}&interval=${parsed.data.interval}`;
    return hal(
      {
        series,
        count: series.length,
        source: preferred ?? null,
        totalCapacityM3: ws.total_capacity_m3,
      },
      {
        self: { href: self },
        watershed: { href: `/api/v1/watersheds/${rawSlug}` },
      },
    );
  } catch (e) {
    return asProblem(e);
  }
}
