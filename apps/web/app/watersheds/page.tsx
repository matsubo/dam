import {
  listWatersheds,
  ratesForWatersheds,
  realDamCountsForWatersheds,
} from '@dam/db/repo/watersheds';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Breadcrumbs } from '../../components/breadcrumbs.tsx';
import { EntityIcon } from '../../components/entity-icon.tsx';
import { fmtPct } from '../../lib/format.ts';
import { rateBand } from '../../lib/rate-color.ts';

// Legend bands shown once at the top so the colour coding is self-explanatory.
const LEGEND: { at: number; label: string }[] = [
  { at: 0.1, label: '危機的' },
  { at: 0.3, label: '渇水警戒' },
  { at: 0.5, label: 'やや低い' },
  { at: 0.7, label: '平常' },
  { at: 0.95, label: '十分' },
];

export const dynamic = 'force-dynamic';
export const revalidate = 3600;
export const metadata: Metadata = {
  title: '水系一覧',
  description: '一級・二級水系ごとのダム数と貯水量推移。日本国内の主要 644 水系を網羅。',
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
  const [rates, realDamCounts] = await Promise.all([
    ratesForWatersheds(ordered.map((w) => w.id)),
    realDamCountsForWatersheds(ordered.map((w) => w.id)),
  ]);
  // Water-shortage spotlight: the lowest-rate systems surface at the very top
  // so an ordinary visitor sees at a glance where water is scarce. Only count
  // systems with enough real observation to be meaningful (実測 >= 3 dams).
  const driest = ordered
    .map((w) => ({ w, rate: rates.get(w.id.toString()) ?? null }))
    .filter(
      (x): x is { w: (typeof ordered)[number]; rate: number } =>
        x.rate != null && (realDamCounts.get(x.w.id.toString()) ?? 0) >= 3,
    )
    .sort((a, b) => a.rate - b.rate)
    .slice(0, 6);
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

      {/* Water-shortage spotlight — the lowest-rate systems, colour-coded. */}
      {driest.length > 0 ? (
        <section className="mb-6">
          <h2 className="text-sm font-semibold text-on-surface mb-2 inline-flex items-center gap-1.5">
            <span aria-hidden className="w-2 h-2 rounded-full" style={{ background: '#dc2626' }} />
            貯水率の低い水系
          </h2>
          <ul className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2">
            {driest.map(({ w, rate }) => {
              const band = rateBand(rate);
              return (
                <li key={w.slug}>
                  <Link
                    href={`/watersheds/${w.slug}`}
                    className="block bg-white border border-outline-variant rounded-xl p-3 no-underline hover:border-primary transition-colors"
                    style={{ borderLeft: `4px solid ${band.color}` }}
                  >
                    <div className="font-display font-semibold text-on-surface truncate">
                      {w.name}
                    </div>
                    <div
                      className="text-2xl font-display font-bold tabular-nums leading-tight"
                      style={{ color: band.color }}
                    >
                      {fmtPct(rate)}
                    </div>
                    <div className="text-[11px]" style={{ color: band.color }}>
                      {band.label}
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {/* Colour legend so the coding is self-explanatory. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mb-4 text-[11px] text-on-surface-variant">
        <span>貯水率:</span>
        {LEGEND.map((b) => {
          const band = rateBand(b.at);
          return (
            <span key={b.label} className="inline-flex items-center gap-1">
              <span
                aria-hidden
                className="w-2.5 h-2.5 rounded-sm"
                style={{ background: band.color }}
              />
              {band.label}
            </span>
          );
        })}
      </div>

      {/* Mobile: stacked cards. */}
      <ul className="md:hidden space-y-2">
        {ordered.map((w) => {
          const rate = rates.get(w.id.toString()) ?? null;
          const kindLabel = w.kind === 'first' ? '一級' : w.kind === 'second' ? '二級' : 'その他';
          return (
            <li key={w.slug} className="bg-white border border-outline-variant rounded-xl p-3">
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
                {(() => {
                  const rc = realDamCounts.get(w.id.toString()) ?? 0;
                  return rc > 0 ? (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="inline-flex items-center gap-1 text-emerald-700">
                        <span aria-hidden className="w-1.5 h-1.5 rounded-full bg-emerald-600" />
                        実測 {rc} 基
                      </span>
                    </>
                  ) : null;
                })()}
              </div>
              <div className="mt-2 flex items-center gap-3">
                <span className="text-[11px] text-on-surface-variant w-12 shrink-0">貯水率</span>
                {rate != null ? (
                  <>
                    <div
                      className="relative h-2 rounded-full bg-surface-container overflow-hidden flex-1"
                      aria-label={`貯水率 ${(rate * 100).toFixed(1)}% ${rateBand(rate).label}`}
                    >
                      <div
                        className="absolute inset-y-0 left-0 rounded-full"
                        style={{ width: `${rate * 100}%`, background: rateBand(rate).color }}
                      />
                    </div>
                    <span
                      className="text-xs font-bold w-12 text-right tabular-nums"
                      style={{ color: rateBand(rate).color }}
                    >
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
              <th className="text-right">実測</th>
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
                  <td className="text-right tabular-nums text-xs">
                    {(() => {
                      const rc = realDamCounts.get(w.id.toString()) ?? 0;
                      return rc > 0 ? (
                        <span className="inline-flex items-center gap-1 justify-end text-emerald-700">
                          <span aria-hidden className="w-1.5 h-1.5 rounded-full bg-emerald-600" />
                          {rc} 基
                        </span>
                      ) : (
                        <span className="text-on-surface-variant">—</span>
                      );
                    })()}
                  </td>
                  <td className="text-right tabular-nums">
                    {rate != null ? (
                      <div className="inline-flex items-center gap-2 min-w-[140px]">
                        <div
                          className="relative h-2 rounded-full bg-surface-container overflow-hidden flex-1"
                          aria-label={`貯水率 ${(rate * 100).toFixed(1)}% ${rateBand(rate).label}`}
                        >
                          <div
                            className="absolute inset-y-0 left-0 rounded-full"
                            style={{ width: `${rate * 100}%`, background: rateBand(rate).color }}
                          />
                        </div>
                        <span
                          className="text-xs font-bold w-12 text-right"
                          style={{ color: rateBand(rate).color }}
                        >
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
