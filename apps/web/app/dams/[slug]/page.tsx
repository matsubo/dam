import { PREFECTURES } from '@dam/core/prefectures';
import {
  findDamBySlug,
  latestObservation,
  latestRateByDam,
  listDams,
  nearbyDams,
  storageChange,
} from '@dam/db/repo/dams';
import { damSeasonalNorm } from '@dam/db/repo/seasonal';
import { aggregateWatershed, findWatershedBySlug } from '@dam/db/repo/watersheds';
import { ExternalLink } from 'lucide-react';
import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Breadcrumbs } from '../../../components/breadcrumbs.tsx';
import { DamCard } from '../../../components/dam-card.tsx';
import { DamLocationMap } from '../../../components/dam-location-map.tsx';
import { EntityIcon } from '../../../components/entity-icon.tsx';
import { ObservationChart } from '../../../components/observation-chart.tsx';
import { QualityBadge } from '../../../components/quality-badge.tsx';
import { ReservoirGauge } from '../../../components/reservoir-gauge.tsx';
import { SourceBadge } from '../../../components/source-badge.tsx';
import { StorageChangeStrip } from '../../../components/storage-change-strip.tsx';
import { damDisplayName } from '../../../lib/dam-name.ts';
import { flowStatus } from '../../../lib/flow-status.ts';
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
  // Search intent is "〇〇ダム 貯水率" — the display name carries the ダム
  // suffix and the title/description lead with 貯水率.
  const dn = damDisplayName(d.name);
  const pref = PREF_NAME.get(d.prefCode) ?? d.prefCode;
  return {
    title: `${dn}の貯水率・貯水量（${pref}）`,
    description: `${dn}（${pref}）の現在の貯水率・貯水量・流入量・放流量と推移グラフ。${d.manager ? `${d.manager}が管理。` : ''}1時間ごとに更新。`,
    alternates: { canonical: `/dams/${slug}` },
    openGraph: {
      title: `${dn}の貯水率・貯水量`,
      description: `${dn}（${pref}）の現在の貯水率と貯水量の推移`,
    },
  };
}

export default async function DamDetail({ params }: PageProps) {
  const { slug: rawSlug } = await params;
  const slug = decodeURIComponent(rawSlug);
  const d = await findDamBySlug(slug);
  if (!d) notFound();
  const dn = damDisplayName(d.name);
  const [latest, change, nearby, watershed, watershedDams, norm] = await Promise.all([
    latestObservation(d.id),
    storageChange(d.id),
    nearbyDams(d.id, 20_000, 6),
    d.watershedSlug ? findWatershedBySlug(d.watershedSlug) : Promise.resolve(null),
    d.watershedSlug
      ? listDams({ watershedSlug: d.watershedSlug, pageSize: 12 })
      : Promise.resolve({ items: [], nextCursor: null }),
    damSeasonalNorm(d.id),
  ]);
  const watershedAgg = watershed ? await aggregateWatershed(watershed.id) : null;
  const otherInWatershed = watershedDams.items.filter((w) => w.id !== d.id).slice(0, 6);
  // Latest 貯水率 per "同じ水系の他のダム" card.
  const otherRates =
    otherInWatershed.length > 0
      ? await latestRateByDam(otherInWatershed.map((n) => n.id))
      : new Map<string, number | null>();

  const ld = {
    '@context': 'https://schema.org',
    '@type': 'Place',
    name: dn,
    alternateName: d.name,
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
                unoptimized={d.imageUrl.includes('wikimedia.org')}
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
          <span>{dn}の貯水率・貯水量</span>
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
          {latest && latest.sourceId !== 'synthetic' && (
            <span className="text-sm text-muted inline-flex items-baseline gap-1.5">
              <span>{fmtDate(latest.observedAt)}</span>
              <SourceBadge sourceId={latest.sourceId} />
              <QualityBadge flag={latest.qualityFlag} />
            </span>
          )}
        </header>
        {/* When the only available observation is synthetic, we suppress
            the "latest value" block entirely. A synthetic observed_at
            looks deceptively like a stale crawl ("最新観測値: 5/5") even
            though it's just the seed timestamp. The chart below still
            renders synthetic for shape. */}
        {latest && latest.sourceId === 'synthetic' ? (
          <p className="text-sm text-on-surface-variant">
            このダムには実観測値の上流フィードが未接続です。下のグラフは推定値 (synthetic seed) を
            表示しています。実測ソースとの紐付けは
            <Link href="/sources" className="text-primary hover:underline mx-1">
              データソース
            </Link>
            を参照。
          </p>
        ) : latest ? (
          (() => {
            // Denominator policy: 利水容量 only — never mislabel a
            // total-capacity ratio as 貯水率. Prefer
            // latest.effectiveActiveCapacityM3 over the dam's static
            // activeCapacityM3: for sources in source_priorities.trusted_rate_basis,
            // it's back-solved from that source's own season-aware 利水容量
            // rate (see issue #17 — 八田原ダム's static Damnet capacity omits
            // the much smaller 洪水期 figure); otherwise it's the same static
            // value as before.
            const cap = latest.effectiveActiveCapacityM3
              ? Number(latest.effectiveActiveCapacityM3)
              : null;
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
                    {(() => {
                      const inN = latest.inflowM3s != null ? Number(latest.inflowM3s) : null;
                      const outN = latest.outflowM3s != null ? Number(latest.outflowM3s) : null;
                      const fs = flowStatus(inN, outN);
                      if (!fs) return null;
                      const tone =
                        fs.tone === 'drain'
                          ? { dot: '#f97316', text: 'text-orange-700' }
                          : fs.tone === 'fill'
                            ? { dot: '#1e6dff', text: 'text-blue-700' }
                            : { dot: '#6b7280', text: 'text-on-surface-variant' };
                      return (
                        <div className="col-span-2">
                          <div className="text-xs text-muted">水収支</div>
                          <div className={`text-sm inline-flex items-center gap-1.5 ${tone.text}`}>
                            <span
                              aria-hidden
                              className="w-2 h-2 rounded-full shrink-0"
                              style={{ background: tone.dot }}
                            />
                            {fs.label}
                          </div>
                        </div>
                      );
                    })()}
                    {norm && Number(norm.normVolumeM3) > 0 ? (
                      <div className="col-span-2">
                        <div className="text-xs text-muted">平年比</div>
                        <div className="text-base tabular-nums">
                          {Math.round(
                            (Number(norm.currentVolumeM3) / Number(norm.normVolumeM3)) * 100,
                          )}{' '}
                          %
                          <span className="text-xs text-muted ml-2">
                            例年この時期 {fmtCapacityMcm(norm.normVolumeM3)}（過去{norm.years}
                            年平均）
                          </span>
                        </div>
                      </div>
                    ) : null}
                  </dl>
                </div>
                {/* Drought callout — only when (a) the rate is below the
                    same threshold the homepage drought banner uses, and
                    (b) the source isn't 'synthetic' (we don't want to
                    raise a drought alarm based on placeholder data). */}
                {rate != null && rate < 0.4 && latest.sourceId !== 'synthetic' ? (
                  <div
                    className={`mt-4 rounded-lg p-3 border ${
                      rate < 0.2
                        ? 'border-red-300 bg-red-50 text-red-900'
                        : rate < 0.3
                          ? 'border-orange-300 bg-orange-50 text-orange-900'
                          : 'border-amber-300 bg-amber-50 text-amber-900'
                    }`}
                    role="alert"
                  >
                    <div className="text-sm font-semibold">
                      {rate < 0.2
                        ? '貯水率がきわめて低い水準です'
                        : rate < 0.3
                          ? '渇水警戒水準です'
                          : '貯水率が平年を下回っています'}
                    </div>
                    <p className="text-xs mt-1 opacity-90">
                      実測値（{latest.sourceId}）に基づく。貯水率 {(rate * 100).toFixed(1)}%。
                      節水・取水制限などの公的アナウンスが出ている可能性があります。
                      <Link href="/" className="underline ml-1 inline-flex items-center gap-0.5">
                        他の渇水ダムも見る
                      </Link>
                    </p>
                  </div>
                ) : null}
              </>
            );
          })()
        ) : (
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
              {watershedAgg?.activeCapacityM3
                ? ` · 利水容量 ${fmtCapacityMcm(watershedAgg.activeCapacityM3)}`
                : ''}
            </span>
          </header>
          {otherInWatershed.length > 0 ? (
            <>
              <p className="text-sm text-muted mb-3">同じ{watershed.name}の他のダム</p>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {otherInWatershed.map((n) => (
                  <DamCard key={n.slug} d={n} rate={otherRates.get(n.id.toString()) ?? null} />
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
          <ul className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {nearby.map((n) => {
              const km = n.distanceM / 1000;
              const distLabel = km >= 10 ? `${km.toFixed(1)} km` : `${km.toFixed(2)} km`;
              const bearing = bearingFromRadians(n.bearingRad);
              const activeCap = n.effectiveActiveCapacityM3
                ? Number(n.effectiveActiveCapacityM3)
                : null;
              const latest = n.latestStorageM3 ? Number(n.latestStorageM3) : null;
              const rate =
                latest != null && activeCap != null && activeCap > 0
                  ? Math.min(1, latest / activeCap)
                  : null;
              return (
                <li key={n.slug} className="card-surface">
                  <Link
                    href={`/dams/${n.slug}`}
                    className="font-display font-semibold leading-tight text-base mb-1 truncate inline-flex items-center gap-1.5 text-on-surface no-underline hover:text-primary"
                  >
                    <EntityIcon kind="dam" size={14} className="text-primary shrink-0" />
                    {n.name}
                  </Link>
                  <div className="text-xs text-on-surface-variant mb-2 inline-flex items-center gap-2">
                    <span className="tabular-nums">{distLabel}</span>
                    <span aria-label={`方角 ${bearing.label}`} title={`方角 ${bearing.label}`}>
                      {bearing.arrow} {bearing.label}
                    </span>
                  </div>
                  {rate != null ? (
                    <div className="space-y-1" aria-label={`貯水率 ${(rate * 100).toFixed(1)}%`}>
                      <div className="relative h-1.5 rounded-full bg-surface-container overflow-hidden">
                        <div
                          className="absolute inset-y-0 left-0 bg-primary"
                          style={{ width: `${rate * 100}%` }}
                        />
                      </div>
                      <div className="flex justify-between text-[11px] text-on-surface-variant tabular-nums">
                        <span>貯水率</span>
                        <span className="font-semibold text-on-surface">{fmtPct(rate)}</span>
                      </div>
                    </div>
                  ) : (
                    <div className="text-[11px] text-on-surface-variant">
                      貯水率 — (利水容量 or 観測値なし)
                    </div>
                  )}
                  <div className="mt-2 text-xs text-on-surface-variant">
                    総貯水容量{' '}
                    <span className="text-on-surface tabular-nums">
                      {fmtCapacityMcm(n.totalCapacityM3)}
                    </span>
                  </div>
                  <div className="text-xs text-on-surface-variant">
                    利水容量{' '}
                    <span className="text-on-surface tabular-nums">
                      {fmtCapacityMcm(n.activeCapacityM3)}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: required to emit schema.org JSON-LD */}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(ld) }} />
    </div>
  );
}

// 8-point compass label for a bearing in radians clockwise from north.
// PostGIS ST_Azimuth returns 0 = north, π/2 = east. Convert to degrees and
// snap to 45° buckets.
function bearingFromRadians(rad: number): { label: string; arrow: string } {
  const deg = ((((rad * 180) / Math.PI) % 360) + 360) % 360;
  const idx = Math.round(deg / 45) % 8;
  const labels = ['北', '北東', '東', '南東', '南', '南西', '西', '北西'] as const;
  const arrows = ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'] as const;
  return { label: labels[idx] ?? '', arrow: arrows[idx] ?? '' };
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
