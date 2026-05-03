import { listDams } from '@dam/db/repo/dams';
import { aggregateWatershed, findWatershedBySlug } from '@dam/db/repo/watersheds';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Breadcrumbs } from '../../../components/breadcrumbs.tsx';
import { DamTable } from '../../../components/dam-table.tsx';
import { ObservationChart } from '../../../components/observation-chart.tsx';
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
  const [agg, list] = await Promise.all([
    aggregateWatershed(w.id),
    listDams({ watershedSlug: slug, pageSize: 200 }),
  ]);
  return (
    <div className="max-w-7xl mx-auto px-5 md:px-10 py-8">
      <Breadcrumbs
        items={[
          { label: 'ホーム', href: '/' },
          { label: '水系', href: '/watersheds' },
          { label: w.name },
        ]}
      />
      <h1 className="text-3xl font-semibold mb-2">{w.name}</h1>
      <p className="text-muted mb-6">
        {w.kind === 'first' ? '一級水系' : w.kind === 'second' ? '二級水系' : 'その他'}
      </p>

      <section className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <Stat label="ダム数" value={String(agg.damCount)} />
        <Stat label="総貯水容量" value={fmtCapacityMcm(agg.totalCapacityM3)} />
        <Stat
          label="現在貯水量"
          value={fmtCapacityMcm(agg.latestStorageVolumeM3)}
          {...(agg.observedAt ? { sub: fmtDate(agg.observedAt) } : {})}
        />
        <Stat
          label="貯水率"
          value={fmtPct(
            agg.latestStorageVolumeM3 && agg.totalCapacityM3 && Number(agg.totalCapacityM3) > 0
              ? Number(agg.latestStorageVolumeM3) / Number(agg.totalCapacityM3)
              : null,
          )}
          sub="現在貯水量 ÷ 総貯水容量"
        />
      </section>

      <section className="mb-8">
        <h2 className="text-lg font-semibold mb-3">推移グラフ（水系合計）</h2>
        <ObservationChart
          slug={rawSlug}
          kind="watershed"
          capacityM3={agg.totalCapacityM3 ? Number(agg.totalCapacityM3) : null}
        />
      </section>

      <h2 className="text-lg font-semibold mb-3">この水系のダム</h2>
      <DamTable rows={list.items} />
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
