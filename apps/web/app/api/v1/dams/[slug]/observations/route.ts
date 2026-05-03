import { sql } from '@dam/db/client';
import { findSeries, type SeriesPoint } from '@dam/db/repo/observations';
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
});

function toCsv(slug: string, series: SeriesPoint[]): string {
  const header = [
    'dam_slug',
    'observed_at',
    'storage_volume_m3',
    'storage_rate',
    'quality_flag',
    'source_id',
  ].join(',');
  const lines = series.map((p) => {
    // observed_at is a Date when read from postgres.js — serialise as ISO 8601
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
    const { slug } = await params;
    const url = new URL(req.url);
    const parsed = Query.safeParse({
      from: url.searchParams.get('from'),
      to: url.searchParams.get('to'),
      interval: url.searchParams.get('interval'),
      format: url.searchParams.get('format') ?? undefined,
    });
    if (!parsed.success) throw new HttpError(400, 'Invalid query');
    const from = new Date(parsed.data.from);
    const to = new Date(parsed.data.to);
    if (Number.isNaN(from.valueOf()) || Number.isNaN(to.valueOf())) {
      throw new HttpError(400, 'Invalid from/to');
    }

    const damRows = await sql<{ id: bigint }[]>`SELECT id FROM dams WHERE slug = ${slug} LIMIT 1`;
    const dam = damRows[0];
    if (!dam) throw new HttpError(404, 'Dam not found');

    const preferred = parsed.data.interval === 'hourly' ? await preferredSource() : null;
    const series = await findSeries({
      damId: dam.id,
      from,
      to,
      bucket: parsed.data.interval,
      preferredSource: preferred,
    });

    if (parsed.data.format === 'csv') {
      const filename = `${slug}-${parsed.data.interval}-${parsed.data.from.slice(0, 10)}_${parsed.data.to.slice(0, 10)}.csv`;
      return new Response(toCsv(slug, series), {
        status: 200,
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="${filename}"`,
          // Cache the dump at the edge — same data on subsequent fetches with
          // identical query params, refresh after an hour for hourly bucket.
          'cache-control':
            parsed.data.interval === 'hourly' ? 'public, max-age=300' : 'public, max-age=3600',
        },
      });
    }

    const self = `/api/v1/dams/${slug}/observations?from=${parsed.data.from}&to=${parsed.data.to}&interval=${parsed.data.interval}`;
    return hal(
      { series, count: series.length, source: preferred ?? null },
      {
        self: { href: self },
        dam: { href: `/api/v1/dams/${slug}` },
        // Self-describing CSV variant — clients can fetch the same window in
        // tabular form by following this link.
        csv: { href: `${self}&format=csv` },
      },
    );
  } catch (e) {
    return asProblem(e);
  }
}
