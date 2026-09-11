import { sql } from '@dam/db/client';
import { type SeriesPoint, findWatershedSeries } from '@dam/db/repo/observations';
import { z } from 'zod';
import { HttpError, asProblem } from '../../../../../../lib/api/error.ts';
import { hal } from '../../../../../../lib/api/response.ts';

export const dynamic = 'force-dynamic';

const Query = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  interval: z.enum(['hourly', 'daily', 'monthly']),
  format: z.enum(['json', 'csv']).optional(),
  /** '1' / 'true' aggregates every source in the window, not just the top one. */
  all_sources: z.enum(['0', '1', 'true', 'false']).optional(),
});

function toCsv(slug: string, series: SeriesPoint[]): string {
  const header = [
    'watershed_slug',
    'observed_at',
    'storage_volume_m3',
    'storage_rate',
    'quality_flag',
    'source_id',
  ].join(',');
  const lines = series.map((p) => {
    const observed =
      p.observedAt instanceof Date ? p.observedAt.toISOString() : String(p.observedAt);
    return [
      slug,
      observed,
      p.storageVolumeM3 ?? '',
      p.storageRate ?? '',
      p.qualityFlag,
      p.sourceId,
    ].join(',');
  });
  return `${header}\n${lines.join('\n')}\n`;
}

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
      format: url.searchParams.get('format') ?? undefined,
      all_sources: url.searchParams.get('all_sources') ?? undefined,
    });
    if (!parsed.success) throw new HttpError(400, 'Invalid query');
    const from = new Date(parsed.data.from);
    const to = new Date(parsed.data.to);
    if (Number.isNaN(from.valueOf()) || Number.isNaN(to.valueOf())) {
      throw new HttpError(400, 'Invalid from/to');
    }

    // Rate denominator = 有効貯水容量 of the rate-able subset only (dams with
    // a known active_capacity_m3). Excluded dams don't contribute to either
    // the numerator or denominator, keeping the watershed-level ratio honest.
    const wsRows = await sql<
      { id: bigint; total_capacity_m3: string | null; active_capacity_m3: string | null }[]
    >`SELECT w.id,
             COALESCE(SUM(d.total_capacity_m3), 0)::TEXT  AS total_capacity_m3,
             COALESCE(SUM(d.active_capacity_m3), 0)::TEXT AS active_capacity_m3
      FROM watersheds w
      LEFT JOIN dams d ON d.watershed_id = w.id
      WHERE w.slug = ${slug}
      GROUP BY w.id
      LIMIT 1`;
    const ws = wsRows[0];
    if (!ws) throw new HttpError(404, 'Watershed not found');

    const allSources = parsed.data.all_sources === '1' || parsed.data.all_sources === 'true';
    // Source selection happens per dam inside findWatershedSeries — a single
    // global pick can't describe a watershed whose dams sit on different feeds.
    // `all_sources=1` skips that per-dam pick entirely.
    const series = await findWatershedSeries({
      watershedId: ws.id,
      from,
      to,
      bucket: parsed.data.interval,
      allSources,
    });

    if (parsed.data.format === 'csv') {
      const filename = `${slug}-${parsed.data.interval}-${parsed.data.from.slice(0, 10)}_${parsed.data.to.slice(0, 10)}.csv`;
      return new Response(toCsv(slug, series), {
        status: 200,
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="${filename}"`,
          'cache-control':
            parsed.data.interval === 'hourly' ? 'public, max-age=300' : 'public, max-age=3600',
        },
      });
    }

    const self = `/api/v1/watersheds/${rawSlug}/observations?from=${parsed.data.from}&to=${parsed.data.to}&interval=${parsed.data.interval}`;
    return hal(
      {
        series,
        count: series.length,
        // No single source: each dam contributes via its own preferred feed.
        source: null,
        totalCapacityM3: ws.total_capacity_m3,
        // The chart uses this for its rate-axis denominator.
        activeCapacityM3: ws.active_capacity_m3,
      },
      {
        self: { href: self },
        watershed: { href: `/api/v1/watersheds/${rawSlug}` },
        csv: { href: `${self}&format=csv` },
      },
    );
  } catch (e) {
    return asProblem(e);
  }
}
