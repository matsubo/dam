import { latestRateByDam, listDams } from '@dam/db/repo/dams';
import {
  aggregateWatershed,
  findWatershedBySlug,
  watershedStorageChange,
} from '@dam/db/repo/watersheds';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Breadcrumbs } from '../../../components/breadcrumbs.tsx';
import { DamTable } from '../../../components/dam-table.tsx';
import { EntityIcon } from '../../../components/entity-icon.tsx';
import { ObservationChart } from '../../../components/observation-chart.tsx';
import { ReservoirGauge } from '../../../components/reservoir-gauge.tsx';
import { StorageChangeStrip } from '../../../components/storage-change-strip.tsx';
import { fmtCapacityMcm, fmtDate, fmtPct } from '../../../lib/format.ts';

export const dynamic = 'force-dynamic';
export const revalidate = 900;

interface PageProps {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug: rawSlug } = await params;
  const slug = decodeURIComponent(rawSlug);
  const w = await findWatershedBySlug(slug);
  if (!w) return { title: '水系が見つかりません' };
  return {
    title: w.name,
    description: `${w.name}に属するダムの一覧と貯水量集計。`,
    alternates: { canonical: `/watersheds/${slug}` },
  };
}

export default async function WatershedDetail({ params }: PageProps) {
  const { slug: rawSlug } = await params;
  const slug = decodeURIComponent(rawSlug);
  const w = await findWatershedBySlug(slug);
  if (!w) notFound();
  const [agg, change, list] = await Promise.all([
    aggregateWatershed(w.id),
    watershedStorageChange(w.id),
    listDams({ watershedSlug: slug, pageSize: 200 }),
  ]);
  // Per-dam latest 貯水率 to render a progress-bar column on the table.
  const rates = new Map(
    Array.from((await latestRateByDam(list.items.map((d) => d.id))).entries()).map(([k, v]) => [
      k,
      { rate: v },
    ]),
  );
  return (
    <div className="max-w-7xl mx-auto px-5 md:px-10 py-8">
      <Breadcrumbs
        items={[
          { label: 'ホーム', href: '/' },
          { label: '水系', href: '/watersheds' },
          { label: w.name },
        ]}
      />
      <h1 className="text-3xl font-semibold mb-2 inline-flex items-center gap-2">
        <EntityIcon kind="watershed" size={28} className="text-primary shrink-0" />
        <span>{w.name}</span>
      </h1>
      <p className="text-muted mb-6">
        {w.kind === 'first' ? '一級水系' : w.kind === 'second' ? '二級水系' : 'その他'}
      </p>

      {(() => {
        // Rate uses 利水容量 as the denominator and only counts dams whose
        // 利水容量 is known. Excluded dams contribute to total capacity but
        // not to the rate calc.
        const activeCap = agg.activeCapacityM3 ? Number(agg.activeCapacityM3) : null;
        const rate =
          agg.latestStorageVolumeM3 && activeCap && activeCap > 0
            ? Math.min(1, Number(agg.latestStorageVolumeM3) / activeCap)
            : null;
        return (
          <section className="flex flex-col md:flex-row gap-6 items-center md:items-stretch mb-8">
            <div className="shrink-0 flex flex-col items-center justify-center bg-white border border-outline-variant rounded-xl p-4">
              <ReservoirGauge rate={rate} size={180} />
              <div className="text-xs text-on-surface-variant mt-1">水系合計貯水率</div>
              {agg.rateableDamCount < agg.damCount ? (
                <div className="text-[10px] text-on-surface-variant mt-1 text-center">
                  ({agg.rateableDamCount}/{agg.damCount} 基集計)
                </div>
              ) : null}
            </div>
            <div className="grid grid-cols-2 md:grid-cols-2 gap-4 flex-1">
              <Stat
                label="ダム数"
                value={String(agg.damCount)}
                {...(agg.realDamCount > 0
                  ? { sub: `うち実測データあり ${agg.realDamCount} 基（直近30日）` }
                  : {})}
              />
              <Stat label="総貯水容量" value={fmtCapacityMcm(agg.totalCapacityM3)} />
              <Stat
                label="現在貯水量"
                value={fmtCapacityMcm(agg.latestStorageVolumeM3)}
                {...(agg.observedAt ? { sub: fmtDate(agg.observedAt) } : {})}
              />
              <Stat
                label="貯水率"
                value={fmtPct(rate)}
                sub={
                  agg.rateableDamCount === 0
                    ? '利水容量データなし'
                    : `現在貯水量 ÷ 利水容量(${agg.rateableDamCount}基)`
                }
              />
            </div>
          </section>
        );
      })()}

      <section className="mb-8">
        <h2 className="text-lg font-semibold mb-3">推移グラフ（水系合計）</h2>
        <ObservationChart
          slug={rawSlug}
          kind="watershed"
          capacityM3={agg.activeCapacityM3 ? Number(agg.activeCapacityM3) : null}
        />
        {change.current ? (
          <div className="mt-5">
            <div className="text-xs text-muted mb-2">水系合計貯水量の変化</div>
            <StorageChangeStrip change={change} />
          </div>
        ) : null}
      </section>

      <h2 className="text-lg font-semibold mb-3">この水系のダム</h2>
      <DamTable rows={list.items} rates={rates} />
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="border border-gray-200 rounded p-3">
      <div className="text-xs text-muted">{label}</div>
      <div className="text-xl font-semibold tabular-nums">{value}</div>
      {sub && <div className="text-xs text-muted mt-1">{sub}</div>}
    </div>
  );
}
