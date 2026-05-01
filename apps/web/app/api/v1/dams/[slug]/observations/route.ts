import { sql } from '@dam/db/client';
import { findSeries } from '@dam/db/repo/observations';
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
    const { slug } = await params;
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

    const self = `/api/v1/dams/${slug}/observations?from=${parsed.data.from}&to=${parsed.data.to}&interval=${parsed.data.interval}`;
    return hal(
      { series, count: series.length, source: preferred ?? null },
      {
        self: { href: self },
        dam: { href: `/api/v1/dams/${slug}` },
      },
    );
  } catch (e) {
    return asProblem(e);
  }
}
