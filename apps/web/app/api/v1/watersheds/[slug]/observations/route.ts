import { sql } from '@dam/db/client';
import { type SeriesPoint, findWatershedSeries } from '@dam/db/repo/observations';
import { preferredSource } from '@dam/db/repo/source_priorities';
import { z } from 'zod';
import { HttpError, asProblem } from '../../../../../../lib/api/error.ts';
import { hal } from '../../../../../../lib/api/response.ts';

export const dynamic = 'force-dynamic';

const Query = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  interval: z.enum(['hourly', 'daily', 'monthly']),
  format: z.enum(['json', 'csv']).optional(),
  /** '1' / 'true' excludes synthetic-seed rows (hourly bucket only). */
  exclude_synthetic: z.enum(['0', '1', 'true', 'false']).optional(),
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
      exclude_synthetic: url.searchParams.get('exclude_synthetic') ?? undefined,
    });
    if (!parsed.success) throw new HttpError(400, 'Invalid query');
    const from = new Date(parsed.data.from);
    const to = new Date(parsed.data.to);
    if (Number.isNaN(from.valueOf()) || Number.isNaN(to.valueOf())) {
      throw new HttpError(400, 'Invalid from/to');
    }

    // Rate denominator = 利水容量 of the rate-able subset only (dams with
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

    const excludeSynthetic =
      parsed.data.exclude_synthetic === '1' || parsed.data.exclude_synthetic === 'true';
    // Bypass preferredSource when the caller wants every real source — see
    // the dam-level route for the same pattern.
    const preferred =
      parsed.data.interval === 'hourly' && !excludeSynthetic ? await preferredSource() : null;
    const series = await findWatershedSeries({
      watershedId: ws.id,
      from,
      to,
      bucket: parsed.data.interval,
      preferredSource: preferred,
      excludeSynthetic,
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
        source: preferred ?? null,
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
