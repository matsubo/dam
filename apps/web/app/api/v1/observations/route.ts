import { findObservationsPage, type ObservationRow } from '@dam/db/repo/observations';
import { z } from 'zod';
import { authorize, makeUnauthorized, rateLimitHeaders } from '../../../../lib/api/auth.ts';
import { asProblem, HttpError } from '../../../../lib/api/error.ts';
import {
  decodeObservationCursor,
  encodeObservationCursor,
} from '../../../../lib/api/observation-cursor.ts';
import { pageLinks, rfc5988Link } from '../../../../lib/api/pagination.ts';
import { hal } from '../../../../lib/api/response.ts';

export const dynamic = 'force-dynamic';

const MAX_PAGE_SIZE = 1000;
const DEFAULT_PAGE_SIZE = 100;

const Query = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  cursor: z.string().min(1).optional(),
  pageSize: z
    .string()
    .regex(/^[0-9]+$/)
    .optional(),
});

function item(row: ObservationRow): Record<string, unknown> {
  return {
    damId: row.damId.toString(),
    damSlug: row.damSlug,
    damName: row.damName,
    observedAt: row.observedAt.toISOString(),
    sourceId: row.sourceId,
    storageVolumeM3: row.storageVolumeM3,
    storageRate: row.storageRate,
    inflowM3s: row.inflowM3s,
    outflowM3s: row.outflowM3s,
    waterLevelM: row.waterLevelM,
    rainfallMm: row.rainfallMm,
    qualityFlag: row.qualityFlag,
    _links: {
      dam: { href: `/api/v1/dams/${row.damSlug}` },
      observations: {
        href: `/api/v1/dams/${row.damSlug}/observations{?from,to,interval}`,
        templated: true,
      },
    },
  };
}

export async function GET(req: Request): Promise<Response> {
  try {
    const auth = await authorize(req);
    if (!auth.ok) return makeUnauthorized(auth);

    const url = new URL(req.url);
    const parsed = Query.safeParse(Object.fromEntries(url.searchParams));
    if (!parsed.success) throw new HttpError(400, 'Invalid query');

    const from = new Date(parsed.data.from);
    const to = new Date(parsed.data.to);
    if (Number.isNaN(from.valueOf()) || Number.isNaN(to.valueOf())) {
      throw new HttpError(400, 'Invalid from/to');
    }
    if (from >= to) throw new HttpError(400, 'from must be before to');

    const pageSize = parsed.data.pageSize ? Number(parsed.data.pageSize) : DEFAULT_PAGE_SIZE;
    if (pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
      throw new HttpError(400, `pageSize must be between 1 and ${MAX_PAGE_SIZE}`);
    }

    // Reject an unreadable cursor instead of silently restarting from `from` —
    // a client that lost its place would otherwise re-ingest the whole window.
    const after = parsed.data.cursor ? decodeObservationCursor(parsed.data.cursor) : null;
    if (parsed.data.cursor && after === null) throw new HttpError(400, 'Invalid cursor');

    const page = await findObservationsPage({ from, to, pageSize, after });

    const nextCursor = page.nextCursor ? encodeObservationCursor(page.nextCursor) : null;
    const self = url.pathname + url.search;
    const linkHeader = rfc5988Link(nextCursor, self);
    return hal(
      { items: page.items.map(item), count: page.items.length },
      { ...pageLinks(self, nextCursor) },
      {
        headers: {
          ...rateLimitHeaders(auth.rate),
          ...(linkHeader ? { Link: linkHeader } : {}),
        },
      },
    );
  } catch (e) {
    return asProblem(e);
  }
}
