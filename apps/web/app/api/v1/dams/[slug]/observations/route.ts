import { sql } from '@dam/db/client';
import { type SeriesPoint, findSeries } from '@dam/db/repo/observations';
import { preferredSourceForDam } from '@dam/db/repo/source_priorities';
import { z } from 'zod';
import { HttpError, asProblem } from '../../../../../../lib/api/error.ts';
import { hal } from '../../../../../../lib/api/response.ts';

export const dynamic = 'force-dynamic';

const Query = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  interval: z.enum(['hourly', 'daily', 'monthly']),
  format: z.enum(['json', 'csv']).optional(),
  /**
   * '1' / 'true' returns every source that has rows in the window instead of
   * the single highest-priority one. Hourly bucket only — the daily/monthly
   * continuous aggregates already collapse all sources into 'aggregate'.
   */
  all_sources: z.enum(['0', '1', 'true', 'false']).optional(),
});

function toCsv(slug: string, series: SeriesPoint[]): string {
  const header = [
    'dam_slug',
    'observed_at',
    'storage_volume_m3',
    'storage_rate',
    'inflow_m3s',
    'outflow_m3s',
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
      p.inflowM3s ?? '',
      p.outflowM3s ?? '',
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
      all_sources: url.searchParams.get('all_sources') ?? undefined,
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

    const allSources = parsed.data.all_sources === '1' || parsed.data.all_sources === 'true';
    // The default hourly path picks the highest-priority source that
    // actually has observations FOR THIS DAM in the window, so the chart
    // shows a single coherent series. Falling back to a global pick (the
    // earlier behaviour) caused empty hourly graphs for any dam whose data
    // lived under a non-top-priority source. all_sources=1 asks for every
    // source at once (e.g. tokyo-waterworks + jwa-junpo) — skip the pick.
    const preferred =
      parsed.data.interval === 'hourly' && !allSources
        ? await preferredSourceForDam(dam.id, from, to)
        : null;
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
