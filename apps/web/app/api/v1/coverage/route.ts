import {
  classifyDamCoverage,
  coverageSummary,
  type DamCoverageStatus,
} from '@dam/db/repo/source_universe';
import { z } from 'zod';
import { authorize, makeUnauthorized, rateLimitHeaders } from '../../../../lib/api/auth.ts';
import { asProblem, HttpError } from '../../../../lib/api/error.ts';
import { hal } from '../../../../lib/api/response.ts';
import { sourceLabel } from '../../../../lib/source-details.ts';

export const dynamic = 'force-dynamic';

const STATUSES = [
  'covered',
  'published_not_ingested',
  'published_no_data',
  'unknown',
  'not_published',
] as const;

const Query = z.object({
  status: z.enum(STATUSES).optional(),
  pref: z
    .string()
    .regex(/^[0-9]{2}$/)
    .optional(),
});

/** Why a dam has no data, in the terms a caller can act on. */
const MEANING: Record<DamCoverageStatus, string> = {
  covered:
    '取得済み。直近 30 日に観測値がある、または月次・不定期の提供元が公開している最新の値 (提供元自身の日付) を取り込み済み。',
  published_not_ingested:
    'データ提供元が公開しており、マスタとの紐付けも済んでいるのに観測値が入っていない。取り込み側の不具合で、こちらで直せる。',
  published_no_data:
    'データ提供元の公開一覧には載っているが、掲載しているすべての提供元が使える値を出していない (調査対象外、全項目が欠測表示、落水中の 0.0 % など、提供元自身が空と示している)。取り込み側で直せるものは無い。',
  unknown:
    '未調査。まだ公開一覧を記録していないデータ提供元 (summary.pendingScanSources) が残っているため、提供の有無を判定できない。',
  not_published:
    '観測値を出す全提供元の公開一覧を記録した上で、どこにも現れなかった。現時点でこのダムのデータを公開している提供元が無い。ただし公開一覧を列挙できない提供元 (summary.sourcesNotEnumerable) と、定期スキャンを持たない歴史ダンプ (summary.sourcesHistoricalOnly) はゲートから除外しているため、その分の保留が残る。',
};

export async function GET(req: Request): Promise<Response> {
  try {
    const auth = await authorize(req);
    if (!auth.ok) return makeUnauthorized(auth);

    const url = new URL(req.url);
    const parsed = Query.safeParse(Object.fromEntries(url.searchParams));
    if (!parsed.success) throw new HttpError(400, 'Invalid query');

    const [summary, all] = await Promise.all([coverageSummary(), classifyDamCoverage()]);
    const items = all
      .filter((r) => (parsed.data.status ? r.status === parsed.data.status : true))
      .filter((r) => (parsed.data.pref ? r.prefCode === parsed.data.pref : true));

    return hal(
      {
        summary: {
          ...summary,
          pendingScanSources: summary.pendingScanSources.map((p) => {
            const id = encodeURIComponent(p.sourceId);
            return {
              sourceId: p.sourceId,
              label: sourceLabel(p.sourceId),
              reason: p.reason,
              _links: {
                source: { href: `/api/v1/sources/${id}` },
                web: { href: `/sources/${id}` },
              },
            };
          }),
        },
        // Restated in the payload so a client never has to guess whether
        // `notPublished` means "nobody publishes it" or "we haven't looked".
        statusMeanings: MEANING,
        items: items.map((r) => ({
          damId: r.damId.toString(),
          slug: r.slug,
          name: r.name,
          prefCode: r.prefCode,
          status: r.status,
          publishedBy: r.publishedBy,
          _links: { dam: { href: `/api/v1/dams/${r.slug}` } },
        })),
        count: items.length,
      },
      {
        self: { href: '/api/v1/coverage' },
        web: { href: '/coverage' },
        dams: { href: '/api/v1/dams' },
      },
      { headers: rateLimitHeaders(auth.rate) },
    );
  } catch (e) {
    return asProblem(e);
  }
}
