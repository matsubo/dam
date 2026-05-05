import { PREFECTURES } from '@dam/core/prefectures';
import {
  findDamBySlug,
  latestObservation,
  listDams,
  nearbyDams,
  storageChange,
} from '@dam/db/repo/dams';
import { aggregateWatershed, findWatershedBySlug } from '@dam/db/repo/watersheds';
import { ExternalLink } from 'lucide-react';
import { EntityIcon } from '../../../components/entity-icon.tsx';
import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Breadcrumbs } from '../../../components/breadcrumbs.tsx';
import { DamCard } from '../../../components/dam-card.tsx';
import { DamLocationMap } from '../../../components/dam-location-map.tsx';
import { ObservationChart } from '../../../components/observation-chart.tsx';
import { QualityBadge } from '../../../components/quality-badge.tsx';
import { ReservoirGauge } from '../../../components/reservoir-gauge.tsx';
import { StorageChangeStrip } from '../../../components/storage-change-strip.tsx';
import { fmtCapacityMcm, fmtDate, fmtN, fmtPct } from '../../../lib/format.ts';
import { imageCredit } from '../../../lib/image-credit.ts';

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
  const [latest, change, nearby, watershed, watershedDams] = await Promise.all([
    latestObservation(d.id),
    storageChange(d.id),
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
    <div className="max-w-7xl mx-auto px-5 md:px-10 py-8">
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
      <div className="flex items-start gap-4 mb-2">
        {d.imageUrl ? (
          <figure className="shrink-0">
            <div className="relative w-20 h-20 rounded-lg overflow-hidden bg-surface-container-low border border-outline-variant/40">
              <Image
                src={d.imageUrl}
                alt={`${d.name}の写真`}
                fill
                sizes="80px"
                className="object-cover"
              />
            </div>
            {(() => {
              const credit = imageCredit(d.imageUrl);
              if (!credit) return null;
              return (
                <figcaption className="text-[10px] leading-tight text-on-surface-variant mt-1 max-w-[88px]">
                  <a
                    href={credit.href}
                    target="_blank"
                    rel="noopener noreferrer license"
                    className="block font-medium hover:underline"
                  >
                    {credit.text}
                  </a>
                  <span className="block text-[9px] opacity-80">{credit.license}</span>
                </figcaption>
              );
            })()}
          </figure>
        ) : null}
        <h1 className="text-3xl font-semibold inline-flex items-center gap-2">
          <EntityIcon kind="dam" size={28} className="text-primary shrink-0" />
          <span>{d.name}</span>
        </h1>
      </div>
      <p className="text-muted mb-6">
        {d.nameKana ?? ''} · {PREF_NAME.get(d.prefCode) ?? d.prefCode}
        {d.watershedSlug && d.watershedName ? (
          <>
            {' · '}
            <span className="inline-flex items-center gap-1">
              <EntityIcon kind="watershed" size={14} className="shrink-0" />
              <Link href={`/watersheds/${d.watershedSlug}`}>{d.watershedName}</Link>
            </span>
          </>
        ) : null}
        {' · '}
        {d.manager ?? '—'}
      </p>

      <section className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4 mb-8">
        <Stat label="総貯水容量" value={fmtCapacityMcm(d.totalCapacityM3)} />
        <Stat label="有効貯水容量" value={fmtCapacityMcm(d.effectiveCapacityM3)} />
        <Stat label="利水容量" value={fmtCapacityMcm(d.activeCapacityM3)} />
        <Stat label="堤高" value={d.heightM ? `${fmtN(d.heightM)} m` : '—'} />
        <Stat
          label="標高"
          value={
            d.elevationM != null && Number.isFinite(d.elevationM)
              ? `${Math.round(d.elevationM).toLocaleString('ja-JP')} m`
              : '—'
          }
        />
      </section>

      <DamSpecs d={d} />

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
        {latest ? (() => {
          // Denominator policy: 利水容量 only. When the dam has no
          // active capacity (~51% of all dams — Damnet doesn't list
          // them), the rate isn't shown rather than mislabelling a
          // total-capacity ratio (which is what observations.storage_rate
          // typically stores upstream) as 貯水率.
          const cap = d.activeCapacityM3 ? Number(d.activeCapacityM3) : null;
          const vol = latest.storageVolumeM3 ? Number(latest.storageVolumeM3) : null;
          const rate = cap && cap > 0 && vol != null ? Math.min(1, vol / cap) : null;
          return (
          <>
          <div className="flex flex-col md:flex-row gap-6 items-center md:items-start">
            <div className="shrink-0 flex flex-col items-center">
              <ReservoirGauge rate={rate} size={180} />
              <div className="text-xs text-muted mt-1">貯水率</div>
            </div>
            <dl className="grid grid-cols-2 md:grid-cols-2 gap-4 text-sm flex-1">
              <Pair label="貯水量" value={fmtCapacityMcm(latest.storageVolumeM3)} />
              <Pair label="貯水率" value={fmtPct(rate)} />
              <Pair
                label="流入量"
                value={latest.inflowM3s ? `${fmtN(latest.inflowM3s)} m³/s` : '—'}
              />
              <Pair
                label="放流量"
                value={latest.outflowM3s ? `${fmtN(latest.outflowM3s)} m³/s` : '—'}
              />
            </dl>
          </div>
          </>
          );
        })() : (
          <p className="text-muted">まだ観測値がありません。</p>
        )}
      </section>

      <section className="mb-8">
        <h2 className="text-lg font-semibold mb-3">推移グラフ</h2>
        <ObservationChart
          slug={slug}
          capacityM3={d.activeCapacityM3 ? Number(d.activeCapacityM3) : null}
        />
        {latest ? (
          <div className="mt-5">
            <div className="text-xs text-muted mb-2">貯水量の変化</div>
            <StorageChangeStrip change={change} />
          </div>
        ) : null}
      </section>

      <section className="mb-8">
        <h2 className="text-lg font-semibold mb-3">所在地</h2>
        <DamLocationMap lat={d.lat} lng={d.lng} name={d.name} />
        <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-on-surface-variant">
          <span className="tabular-nums">
            {d.lat.toFixed(5)}, {d.lng.toFixed(5)}
          </span>
          <a
            href={`https://www.google.com/maps/search/?api=1&query=${d.lat},${d.lng}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:underline inline-flex items-center gap-1"
          >
            <ExternalLink size={14} aria-hidden="true" />
            Google マップで開く
          </a>
          <a
            href={`https://maps.apple.com/?q=${encodeURIComponent(d.name)}&ll=${d.lat},${d.lng}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-on-surface-variant hover:text-primary hover:underline"
          >
            Apple マップ
          </a>
          <a
            href={`https://maps.gsi.go.jp/#15/${d.lat}/${d.lng}/&base=std&ls=std&disp=1&vs=c1g1j0h0k0l0u0t0z0r0s0m0f0`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-on-surface-variant hover:text-primary hover:underline"
          >
            地理院地図
          </a>
        </div>
      </section>

      {watershed && (
        <section className="mb-8">
          <header className="flex items-baseline justify-between mb-3">
            <h2 className="text-lg font-semibold inline-flex items-center gap-1.5">
              <EntityIcon kind="watershed" size={18} className="shrink-0" />
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
    </div>
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

// Damnet 用途コード → 日本語ラベル. Codes can stack (e.g. "FNAWP").
const PURPOSE_LABEL: Record<string, string> = {
  F: '洪水調節',
  N: '不特定用水',
  A: '農業用水',
  W: '上水道',
  I: '工業用水',
  P: '発電',
  S: '消流雪用水',
  R: 'レクリエーション',
};

function decodePurposes(code: string | null): string {
  if (!code) return '—';
  const labels = Array.from(code).map((c) => PURPOSE_LABEL[c] ?? c);
  return labels.join('・');
}

interface DamSpecData {
  type: string | null;
  completedYear: number | null;
  constructionStartYear: number | null;
  purposes: string | null;
  crestLengthM: string | null;
  embankmentVolumeM3: string | null;
  watershedAreaKm2: string | null;
  reservoirAreaKm2: string | null;
  leftBankLocation: string | null;
  mainContractor: string | null;
  redevelopmentStatus: string | null;
  totalCapacityM3: string | null;
  effectiveCapacityM3: string | null;
  activeCapacityM3: string | null;
  floodCapacityM3: string | null;
}

function DamSpecs({ d }: { d: DamSpecData }) {
  // Skip the section entirely if every Damnet-only field is null — the simple
  // 5-stat strip above already covers what's left.
  const haveAny =
    d.purposes ||
    d.constructionStartYear ||
    d.crestLengthM ||
    d.embankmentVolumeM3 ||
    d.watershedAreaKm2 ||
    d.reservoirAreaKm2 ||
    d.leftBankLocation ||
    d.mainContractor ||
    d.redevelopmentStatus;
  if (!haveAny) return null;
  const fmtNum = (v: string | null, suffix: string, fractionDigits = 0) => {
    if (v == null) return '—';
    const n = Number(v);
    if (!Number.isFinite(n)) return '—';
    return `${n.toLocaleString('ja-JP', { maximumFractionDigits: fractionDigits })} ${suffix}`;
  };
  return (
    <section className="mb-8 bg-white border border-outline-variant rounded-xl p-5">
      <h2 className="text-lg font-semibold mb-4">ダム諸元</h2>
      <dl className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-4 text-sm">
        <Pair label="型式" value={d.type ?? '—'} />
        <Pair label="目的" value={decodePurposes(d.purposes)} />
        <Pair
          label="着工〜竣工"
          value={
            d.constructionStartYear || d.completedYear
              ? `${d.constructionStartYear ?? '—'} 〜 ${d.completedYear ?? '—'} 年`
              : '—'
          }
        />
        <Pair label="堤長" value={fmtNum(d.crestLengthM, 'm', 1)} />
        <Pair label="堤体積" value={fmtNum(d.embankmentVolumeM3, 'm³')} />
        <Pair label="流域面積" value={fmtNum(d.watershedAreaKm2, 'km²', 2)} />
        <Pair label="湛水面積" value={fmtNum(d.reservoirAreaKm2, 'km²', 3)} />
        <Pair label="左岸所在地" value={d.leftBankLocation ?? '—'} />
        <Pair label="主要施工者" value={d.mainContractor ?? '—'} />
        {d.redevelopmentStatus ? <Pair label="再開発" value={d.redevelopmentStatus} /> : null}
      </dl>
    </section>
  );
}
