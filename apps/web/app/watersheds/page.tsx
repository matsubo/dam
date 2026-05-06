import { listWatersheds, ratesForWatersheds } from '@dam/db/repo/watersheds';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Breadcrumbs } from '../../components/breadcrumbs.tsx';
import { EntityIcon } from '../../components/entity-icon.tsx';
import { fmtPct } from '../../lib/format.ts';

export const dynamic = 'force-dynamic';
export const revalidate = 3600;
export const metadata: Metadata = {
  title: '水系一覧',
  description:
    '一級・二級水系ごとのダム数と貯水量推移。日本国内の主要 644 水系を網羅。',
  alternates: { canonical: '/watersheds' },
};

export default async function WatershedsPage() {
  // Fetch all watersheds. Order: 一級 first, then 二級, then 'other' — and
  // within each band, by descending dam count so the most populated systems
  // surface at the top. Filter to systems that actually have at least one
  // dam in the master, since this is a dam-data site.
  const r = await listWatersheds({ pageSize: 1000 });
  const all = r.items;
  const totals = all.reduce(
    (acc, w) => {
      acc[w.kind]++;
      return acc;
    },
    { first: 0, second: 0, other: 0 } as Record<'first' | 'second' | 'other', number>,
  );
  const withDams = all.filter((w) => w.damCount > 0);
  const ordered = [...withDams].sort((a, b) => {
    const rank = { first: 0, second: 1, other: 2 } as const;
    if (rank[a.kind] !== rank[b.kind]) return rank[a.kind] - rank[b.kind];
    return b.damCount - a.damCount;
  });
  const counts = ordered.reduce(
    (acc, w) => {
      acc[w.kind]++;
      return acc;
    },
    { first: 0, second: 0, other: 0 } as Record<'first' | 'second' | 'other', number>,
  );
  const emptyCount = all.length - ordered.length;
  // Per-watershed 貯水率: SUM(latest storage) / SUM(active_capacity) over
  // rate-able dams in each system. Single round-trip across the visible list.
  const rates = await ratesForWatersheds(ordered.map((w) => w.id));
  return (
    <div className="max-w-7xl mx-auto px-5 md:px-10 py-8">
      <Breadcrumbs items={[{ label: 'ホーム', href: '/' }, { label: '水系' }]} />
      <h1 className="text-2xl font-semibold mb-2 inline-flex items-center gap-2">
        <EntityIcon kind="watershed" size={24} className="text-primary shrink-0" />
        <span>水系一覧</span>
      </h1>
      <p className="text-muted mb-6 text-sm">
        ダムが登録されている {ordered.length} 水系を表示（一級 {counts.first} · 二級 {counts.second}{' '}
        · その他 {counts.other}）。マスタ全体は {all.length} 水系（一級 {totals.first} · 二級{' '}
        {totals.second} · その他 {totals.other}）
        {emptyCount > 0 ? `、うち ${emptyCount} 水系はダム登録なし` : ''}。
      </p>
      {/* Mobile: stacked cards. */}
      <ul className="md:hidden space-y-2">
        {ordered.map((w) => {
          const rate = rates.get(w.id.toString()) ?? null;
          const kindLabel =
            w.kind === 'first' ? '一級' : w.kind === 'second' ? '二級' : 'その他';
          return (
            <li
              key={w.slug}
              className="bg-white border border-outline-variant rounded-xl p-3"
            >
              <Link
                href={`/watersheds/${w.slug}`}
                className="font-display font-semibold inline-flex items-center gap-1.5 text-on-surface no-underline hover:text-primary"
              >
                <EntityIcon kind="watershed" size={14} className="shrink-0" />
                {w.name}
              </Link>
              <div className="text-xs text-on-surface-variant mt-1 flex flex-wrap items-center gap-x-2">
                <span>{kindLabel}水系</span>
                <span aria-hidden="true">·</span>
                <span className="inline-flex items-center gap-1">
                  <EntityIcon kind="dam" size={11} className="text-primary shrink-0" />
                  {w.damCount} 基
                </span>
              </div>
              <div className="mt-2 flex items-center gap-3">
                <span className="text-[11px] text-on-surface-variant w-12 shrink-0">
                  貯水率
                </span>
                {rate != null ? (
                  <>
                    <div
                      className="relative h-1.5 rounded-full bg-surface-container overflow-hidden flex-1"
                      aria-label={`貯水率 ${(rate * 100).toFixed(1)}%`}
                    >
                      <div
                        className="absolute inset-y-0 left-0 bg-primary"
                        style={{ width: `${rate * 100}%` }}
                      />
                    </div>
                    <span className="text-xs font-semibold w-12 text-right tabular-nums">
                      {fmtPct(rate)}
                    </span>
                  </>
                ) : (
                  <span className="text-xs text-on-surface-variant">—</span>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {/* Desktop: classic table. */}
      <div className="hidden md:block overflow-x-auto">
        <table>
          <thead>
            <tr>
              <th>水系</th>
              <th>区分</th>
              <th className="text-right">ダム数</th>
              <th className="text-right">貯水率</th>
            </tr>
          </thead>
          <tbody>
            {ordered.map((w) => {
              const rate = rates.get(w.id.toString()) ?? null;
              return (
                <tr key={w.slug}>
                  <td>
                    <span className="inline-flex items-center gap-1.5">
                      <EntityIcon kind="watershed" size={14} className="shrink-0" />
                      <Link href={`/watersheds/${w.slug}`}>{w.name}</Link>
                    </span>
                  </td>
                  <td>{w.kind === 'first' ? '一級' : w.kind === 'second' ? '二級' : 'その他'}</td>
                  <td className="text-right tabular-nums">
                    <span className="inline-flex items-center gap-1 justify-end">
                      <EntityIcon kind="dam" size={12} className="text-primary shrink-0" />
                      {w.damCount}
                    </span>
                  </td>
                  <td className="text-right tabular-nums">
                    {rate != null ? (
                      <div className="inline-flex items-center gap-2 min-w-[140px]">
                        <div
                          className="relative h-1.5 rounded-full bg-surface-container overflow-hidden flex-1"
                          aria-label={`貯水率 ${(rate * 100).toFixed(1)}%`}
                        >
                          <div
                            className="absolute inset-y-0 left-0 bg-primary"
                            style={{ width: `${rate * 100}%` }}
                          />
                        </div>
                        <span className="text-xs font-semibold w-12 text-right">
                          {fmtPct(rate)}
                        </span>
                      </div>
                    ) : (
                      <span className="text-xs text-on-surface-variant">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
