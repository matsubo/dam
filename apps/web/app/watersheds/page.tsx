import {
  driestWatersheds,
  listWatersheds,
  ratesForWatersheds,
  realDamCountsForWatersheds,
} from '@dam/db/repo/watersheds';
import type { Metadata } from 'next';
import Link from 'next/link';
import type { CSSProperties } from 'react';
import { Breadcrumbs } from '../../components/breadcrumbs.tsx';
import { EntityIcon } from '../../components/entity-icon.tsx';
import { WatershedSpotlight } from '../../components/watershed-spotlight.tsx';
import { fmtPct } from '../../lib/format.ts';
import { rateBand } from '../../lib/rate-color.ts';
import styles from './page.module.css';

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
  // Water-shortage spotlight: lowest-rate systems whose rate is backed by
  // >= 3 rate-able dams (so a single low dam can't headline a watershed).
  // Same query the home page uses — one shared, representative definition.
  const [rates, realDamCounts, driest] = await Promise.all([
    ratesForWatersheds(ordered.map((w) => w.id)),
    realDamCountsForWatersheds(ordered.map((w) => w.id)),
    driestWatersheds(6, 3),
  ]);
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
        <div className="mb-6">
          <WatershedSpotlight items={driest} />
        </div>
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
                className="w-2.5 h-2.5 rounded-xs"
                style={{ background: band.color }}
              />
              {band.label}
            </span>
          );
        })}
      </div>

      {/* One table for every breakpoint — page.module.css reflows it into cards
          below md and draws icons, dots and bars as pseudo-elements, so ~650
          rows stay at 7 elements each instead of being rendered twice. */}
      <div className="overflow-x-auto">
        <table className={styles.list}>
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
              const rc = realDamCounts.get(w.id.toString()) ?? 0;
              return (
                <tr key={w.slug}>
                  <td>
                    <Link href={`/watersheds/${w.slug}`}>{w.name}</Link>
                  </td>
                  <td>{w.kind === 'first' ? '一級' : w.kind === 'second' ? '二級' : 'その他'}</td>
                  <td>{w.damCount}</td>
                  {/* Cells 4–5 stay empty without a value; the stylesheet draws "—". */}
                  <td>{rc > 0 ? `${rc} 基` : null}</td>
                  {rate != null ? (
                    <td
                      aria-label={`貯水率 ${(rate * 100).toFixed(1)}% ${rateBand(rate).label}`}
                      style={
                        {
                          '--r': `${(rate * 100).toFixed(1)}%`,
                          '--c': rateBand(rate).color,
                        } as CSSProperties
                      }
                    >
                      {fmtPct(rate)}
                    </td>
                  ) : (
                    <td />
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
