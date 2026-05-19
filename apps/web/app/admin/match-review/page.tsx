// /admin/match-review — Phase A3 (#4): surface uncertain matcher decisions
// staged in `match_review` for visual confirmation. This is a READ-ONLY
// dashboard; resolution writes go through the POST endpoint at
// /api/v1/admin/match-review/[id]/resolve.

import { sql } from '@dam/db/client';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Breadcrumbs } from '../../../components/breadcrumbs.tsx';
import { SOURCE_DETAILS } from '../../../lib/source-details.ts';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'マッチング確認',
  description: 'matcher が確度の低いマッチングを stage したリスト。手動で承認/却下。',
  robots: { index: false, follow: false },
};

interface ReviewRow {
  id: bigint;
  source_id: string;
  source_external_id: string;
  best_dam_id: bigint | null;
  best_dam_name: string | null;
  confidence: number;
  payload: {
    catalogue?: { obsNm?: string; lat?: number; lon?: number; ofcCd?: number };
    bestReason?: string;
    bestDistanceM?: number | null;
    candidates?: { id: string; name: string; distanceM: number }[];
  };
  resolved_dam_id: bigint | null;
  resolved_at: Date | null;
  created_at: Date;
}

async function loadReview(): Promise<{
  unresolved: ReviewRow[];
  resolvedCount: bigint;
}> {
  const [unresolved, totals] = await Promise.all([
    sql<ReviewRow[]>`
      SELECT
        mr.id,
        mr.source_id,
        mr.source_external_id,
        mr.best_dam_id,
        d.name AS best_dam_name,
        mr.confidence::FLOAT8 AS confidence,
        mr.payload,
        mr.resolved_dam_id,
        mr.resolved_at,
        mr.created_at
      FROM match_review mr
      LEFT JOIN dams d ON d.id = mr.best_dam_id
      WHERE mr.resolved_dam_id IS NULL
      ORDER BY mr.confidence ASC, mr.created_at DESC
      LIMIT 200
    `,
    sql<
      { resolved: bigint }[]
    >`SELECT COUNT(*)::BIGINT AS resolved FROM match_review WHERE resolved_dam_id IS NOT NULL`,
  ]);
  return {
    unresolved,
    resolvedCount: totals[0]?.resolved ?? 0n,
  };
}

function badgeColor(c: number): string {
  if (c >= 0.6) return 'bg-amber-100 text-amber-900 border-amber-300';
  if (c >= 0.4) return 'bg-orange-100 text-orange-900 border-orange-300';
  return 'bg-red-100 text-red-900 border-red-300';
}

export default async function MatchReviewPage() {
  const { unresolved, resolvedCount } = await loadReview();

  return (
    <div className="max-w-6xl mx-auto px-5 md:px-10 py-8">
      <Breadcrumbs
        items={[{ label: 'ホーム', href: '/' }, { label: '管理' }, { label: 'マッチング確認' }]}
      />
      <h1 className="text-2xl font-semibold mb-2">マッチング確認</h1>
      <p className="text-sm text-on-surface-variant mb-6">
        ソースと master ダムのマッチングのうち、確度 (confidence) が 0.8 未満のものを stage
        しています。下のリストから候補を選んで承認・却下できます。 確度 1.0 (完全一致) は自動で
        external_ids に書き込み済みなので表示されません。
      </p>

      <section className="mb-8 grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="bg-white border border-outline-variant rounded-xl p-5">
          <div className="text-xs uppercase tracking-wider text-on-surface-variant mb-1">
            未確認
          </div>
          <div className="text-3xl font-display font-semibold tabular-nums">
            {unresolved.length.toLocaleString()}
          </div>
        </div>
        <div className="bg-white border border-outline-variant rounded-xl p-5">
          <div className="text-xs uppercase tracking-wider text-on-surface-variant mb-1">
            解決済 (累計)
          </div>
          <div className="text-3xl font-display font-semibold tabular-nums">
            {Number(resolvedCount).toLocaleString()}
          </div>
        </div>
      </section>

      {unresolved.length === 0 ? (
        <div className="text-sm text-on-surface-variant py-10 text-center bg-surface-container-low rounded-xl">
          すべてのマッチングが解決済みです 🎉
        </div>
      ) : (
        <div className="space-y-4">
          {unresolved.map((row) => {
            const cat = row.payload.catalogue ?? {};
            const cands = row.payload.candidates ?? [];
            const sourceLabel = SOURCE_DETAILS[row.source_id]?.label ?? row.source_id;
            return (
              <article
                key={String(row.id)}
                className="bg-white border border-outline-variant rounded-xl p-5"
              >
                <header className="flex items-baseline justify-between mb-3">
                  <div>
                    <span className="text-xs uppercase tracking-wider text-on-surface-variant mr-2">
                      {sourceLabel}
                    </span>
                    <strong className="text-lg">{cat.obsNm ?? row.source_external_id}</strong>
                    <span className="ml-2 text-xs text-on-surface-variant font-mono">
                      {row.source_external_id}
                    </span>
                  </div>
                  <span
                    className={`text-xs border rounded-full px-2 py-0.5 tabular-nums ${badgeColor(row.confidence)}`}
                  >
                    confidence {row.confidence.toFixed(2)}
                  </span>
                </header>
                <p className="text-xs text-on-surface-variant mb-3">
                  位置: {cat.lat?.toFixed(4)}, {cat.lon?.toFixed(4)} / 管理事務所コード {cat.ofcCd}{' '}
                  / matcher 判定: {row.payload.bestReason}
                </p>
                <table className="w-full text-sm">
                  <thead className="bg-surface-container-low">
                    <tr className="text-left">
                      <th className="px-3 py-2 font-medium">候補ダム</th>
                      <th className="px-3 py-2 font-medium text-right">距離 (m)</th>
                      <th className="px-3 py-2 font-medium">推奨</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cands.map((c) => (
                      <tr key={c.id} className="border-t border-outline-variant">
                        <td className="px-3 py-2">
                          <Link className="text-primary hover:underline" href={`/dams/${c.id}`}>
                            {c.name}
                          </Link>
                          <span className="ml-2 text-xs text-on-surface-variant font-mono">
                            id {c.id}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums font-mono">
                          {c.distanceM.toLocaleString()}
                        </td>
                        <td className="px-3 py-2">
                          {row.best_dam_id != null && String(row.best_dam_id) === c.id ? (
                            <span className="text-xs bg-primary text-white rounded-full px-2 py-0.5">
                              matcher pick
                            </span>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </article>
            );
          })}
        </div>
      )}

      <p className="mt-8 text-xs text-on-surface-variant">
        この画面は読み取り専用。承認・却下の書き込み API は今後追加予定。
      </p>
    </div>
  );
}
