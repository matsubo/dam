import { PREFECTURES } from '@dam/core/prefectures';
import { findDamBySlug, latestObservation, listDams, nearbyDams } from '@dam/db/repo/dams';
import { aggregateWatershed, findWatershedBySlug } from '@dam/db/repo/watersheds';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Breadcrumbs } from '../../../components/breadcrumbs.tsx';
import { DamCard } from '../../../components/dam-card.tsx';
import { ObservationChart } from '../../../components/observation-chart.tsx';
import { QualityBadge } from '../../../components/quality-badge.tsx';
import { fmtCapacityMcm, fmtDate, fmtN, fmtPct } from '../../../lib/format.ts';

export const dynamic = 'force-dynamic';
export const revalidate = 900;
export const dynamicParams = true;

const PREF_NAME = new Map(PREFECTURES.map((p) => [p.code, p.name]));

interface PageProps {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug: rawSlug } = await params;
  const slug = decodeURIComponent(rawSlug);
  const d = await findDamBySlug(slug);
  if (!d) return { title: 'ダムが見つかりません' };
  return {
    title: `${d.name}（${PREF_NAME.get(d.prefCode) ?? d.prefCode}）`,
    description: `${d.name}の貯水量・流入量・放流量の最新データと推移。${d.manager ?? ''}が管理。`,
    alternates: { canonical: `/dams/${slug}` },
    openGraph: { title: d.name, description: `${d.manager ?? ''}が管理するダム` },
  };
}

export default async function DamDetail({ params }: PageProps) {
  const { slug: rawSlug } = await params;
  const slug = decodeURIComponent(rawSlug);
  const d = await findDamBySlug(slug);
  if (!d) notFound();
  const [latest, nearby, watershed, watershedDams] = await Promise.all([
    latestObservation(d.id),
    nearbyDams(d.id, 20_000, 6),
    d.watershedSlug ? findWatershedBySlug(d.watershedSlug) : Promise.resolve(null),
    d.watershedSlug
      ? listDams({ watershedSlug: d.watershedSlug, pageSize: 12 })
      : Promise.resolve({ items: [], nextCursor: null }),
  ]);
  const watershedAgg = watershed ? await aggregateWatershed(watershed.id) : null;
  const otherInWatershed = watershedDams.items.filter((w) => w.id !== d.id).slice(0, 6);

  const ld = {
    '@context': 'https://schema.org',
    '@type': 'Place',
    name: d.name,
    geo: { '@type': 'GeoCoordinates', latitude: d.lat, longitude: d.lng },
    address: {
      '@type': 'PostalAddress',
      addressCountry: 'JP',
      addressRegion: PREF_NAME.get(d.prefCode) ?? d.prefCode,
    },
  };

  return (
    <>
      <Breadcrumbs
        items={[
          { label: 'ホーム', href: '/' },
          { label: 'ダム', href: '/dams' },
          ...(d.watershedSlug
            ? [{ label: d.watershedName ?? '', href: `/watersheds/${d.watershedSlug}` }]
            : []),
          { label: d.name },
        ]}
      />
      <h1 className="text-3xl font-semibold mb-2">{d.name}</h1>
      <p className="text-muted mb-6">
        {d.nameKana ?? ''} · {PREF_NAME.get(d.prefCode) ?? d.prefCode}
        {d.watershedSlug && d.watershedName ? (
          <>
            {' · '}
            <Link href={`/watersheds/${d.watershedSlug}`}>{d.watershedName}</Link>
          </>
        ) : null}
        {' · '}
        {d.manager ?? '—'}
      </p>

      <section className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
        <Stat label="総貯水容量" value={fmtCapacityMcm(d.totalCapacityM3)} />
        <Stat label="有効貯水容量" value={fmtCapacityMcm(d.effectiveCapacityM3)} />
        <Stat label="堤高" value={d.heightM ? `${fmtN(d.heightM)} m` : '—'} />
      </section>

      <section className="border border-gray-200 rounded p-4 mb-8">
        <header className="flex items-baseline justify-between mb-3">
          <h2 className="text-lg font-semibold">最新観測値</h2>
          {latest && (
            <span className="text-sm text-muted">
              {fmtDate(latest.observedAt)} · {latest.sourceId}{' '}
              <QualityBadge flag={latest.qualityFlag} />
            </span>
          )}
        </header>
        {latest ? (
          <dl className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <Pair label="貯水量" value={fmtCapacityMcm(latest.storageVolumeM3)} />
            <Pair label="貯水率" value={fmtPct(latest.storageRate)} />
            <Pair
              label="流入量"
              value={latest.inflowM3s ? `${fmtN(latest.inflowM3s)} m³/s` : '—'}
            />
            <Pair
              label="放流量"
              value={latest.outflowM3s ? `${fmtN(latest.outflowM3s)} m³/s` : '—'}
            />
          </dl>
        ) : (
          <p className="text-muted">まだ観測値がありません。</p>
        )}
      </section>

      <section className="mb-8">
        <h2 className="text-lg font-semibold mb-3">推移グラフ</h2>
        <ObservationChart slug={slug} />
      </section>

      {watershed && (
        <section className="mb-8">
          <header className="flex items-baseline justify-between mb-3">
            <h2 className="text-lg font-semibold">
              <Link href={`/watersheds/${watershed.slug}`}>{watershed.name}</Link>
            </h2>
            <span className="text-sm text-muted">
              {watershed.kind === 'first'
                ? '一級水系'
                : watershed.kind === 'second'
                  ? '二級水系'
                  : 'その他'}
              {watershedAgg ? ` · ダム ${watershedAgg.damCount} 基` : ''}
              {watershedAgg?.totalCapacityM3
                ? ` · 総貯水容量 ${fmtCapacityMcm(watershedAgg.totalCapacityM3)}`
                : ''}
            </span>
          </header>
          {otherInWatershed.length > 0 ? (
            <>
              <p className="text-sm text-muted mb-3">同じ{watershed.name}の他のダム</p>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {otherInWatershed.map((n) => (
                  <DamCard key={n.slug} d={n} />
                ))}
              </div>
              <p className="mt-3 text-sm">
                <Link href={`/watersheds/${watershed.slug}`}>
                  {watershed.name}のダム一覧をすべて見る →
                </Link>
              </p>
            </>
          ) : (
            <p className="text-sm text-muted">この水系で他のダムはまだ登録されていません。</p>
          )}
        </section>
      )}

      {nearby.length > 0 && (
        <section className="mb-8">
          <h2 className="text-lg font-semibold mb-3">近隣のダム</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {nearby.map((n) => (
              <DamCard key={n.slug} d={{ ...n, totalCapacityM3: n.totalCapacityM3 }} />
            ))}
          </div>
        </section>
      )}

      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: required to emit schema.org JSON-LD */}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(ld) }} />
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-gray-200 rounded p-3">
      <div className="text-xs text-muted">{label}</div>
      <div className="text-xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}
function Pair({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-muted">{label}</div>
      <div className="text-base tabular-nums">{value}</div>
    </div>
  );
}
