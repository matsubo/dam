import { sql } from '@dam/db/client';
import { coverageHeadline } from '@dam/db/repo/coverage';
import { listDams, lowStorageDams } from '@dam/db/repo/dams';
import { nationalStorageTotals, storageRate } from '@dam/db/repo/storage_totals';
import { driestWatersheds, nationalStorageChange } from '@dam/db/repo/watersheds';
import type { LucideIcon } from 'lucide-react';
import {
  ArrowRight,
  BadgeCheck,
  BarChart3,
  Braces,
  Gauge,
  Globe,
  History,
  KeyRound,
  LineChart,
  Map as MapIcon,
} from 'lucide-react';
import type { Metadata } from 'next';
import { unstable_cache } from 'next/cache';
import Link from 'next/link';
import { DamCard } from '../components/dam-card.tsx';
import { DroughtAlert } from '../components/drought-alert.tsx';
import { ENTITY_ICONS } from '../components/entity-icon.tsx';
import { LocateWatershedButton } from '../components/locate-watershed-button.tsx';
import { StorageChangeStrip } from '../components/storage-change-strip.tsx';
import { WatershedSpotlight } from '../components/watershed-spotlight.tsx';
import { fmtCapacityMcm } from '../lib/format.ts';

// force-dynamic skips Next's build-time prerender (which would fail because
// the build container can't reach the DB). Real caching happens in
// unstable_cache wrappers below — 5-min TTL keyed on the four fetchers,
// shared across requests at runtime.
export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: { absolute: '日本のダム貯水率・貯水量マップ — Dam Data Platform' },
  description: '日本全国のダム諸元と貯水量履歴。長期トレンドを 1 時間〜月次の粒度で参照。',
  alternates: { canonical: '/' },
};

/** Master-side counters this page owns. Everything observation-derived is
 *  imported from repo/storage_totals + repo/coverage, which /stats and
 *  /coverage read too — one definition, no drift. */
interface MasterStats {
  damCount: bigint;
  watershedCount: bigint;
  obsTotal: bigint;
  obsLast24h: bigint;
  totalCapacityM3: string | null;
  /** Sum of 利水容量 across the rate-able subset (informational; NOT the rate denominator). */
  activeCapacityM3: string | null;
  rateableDamCount: bigint;
  oldestObs: Date | null;
}

interface HomeStats extends MasterStats {
  /** Latest storage summed across the observed cohort — pairs with observedActiveCapacityM3 for rate. */
  rateableStorageM3: string | null;
  /** Rate-able dams with a fresh (7 d) observation. Rate numerator and denominator both come from this cohort. */
  observedDamCount: number;
  /** Sum of 利水容量 over the observed cohort only — the 全国貯水率 denominator. */
  observedActiveCapacityM3: string | null;
  /** Distinct dams that have at least one non-synthetic observation in the last 30 days. */
  realDamCount: number;
  /** Dams with height_m >= 15 (ダム法の定義: 提高15m以上). Used as the denominator for 貯水率取得ダムカバレッジ. */
  riverDamCount: number;
  /** Distinct dams (height_m >= 15) with storage_rate in the last 30 days. Numerator for coverage. */
  storageRateRiverDamCount: number;
  /** Distinct dams that have at least one non-synthetic observation EVER
   *  (mudam-style historical data counts; vastly larger than the 30 d figure). */
  historicalDamCount: number;
}

async function homeStats(): Promise<HomeStats> {
  // observations is a TimescaleDB hypertable; COUNT(*) over its 6.7 M rows
  // takes seconds. Use TimescaleDB's purpose-built approximate_row_count()
  // — it sums chunk-level pg_class.reltuples (the parent table's reltuples
  // is always 0 because rows live in children), instant after ANALYZE.
  //
  // The storage cohort and the coverage counters live in the db repo so the
  // home page, /stats and /coverage cannot quote different definitions of
  // the same word: 全国貯水率 sums numerator AND denominator over dams with a
  // fresh reading (repo/storage_totals), and coverage keeps 実測 and 貯水率取得
  // separate (repo/coverage).
  const [rows, totals, coverage] = await Promise.all([
    sql<MasterStats[]>`
      SELECT
        (SELECT COUNT(*)::BIGINT      FROM dams)                                           AS "damCount",
        (SELECT COUNT(*)::BIGINT      FROM watersheds)                                     AS "watershedCount",
        GREATEST(0, approximate_row_count('observations'))::BIGINT                         AS "obsTotal",
        (SELECT COUNT(*)::BIGINT      FROM observations WHERE observed_at > NOW() - INTERVAL '24 hours') AS "obsLast24h",
        (SELECT SUM(total_capacity_m3)::TEXT FROM dams)                                    AS "totalCapacityM3",
        (SELECT SUM(active_capacity_m3)::TEXT FROM dams WHERE active_capacity_m3 IS NOT NULL) AS "activeCapacityM3",
        (SELECT COUNT(*)::BIGINT      FROM dams WHERE active_capacity_m3 IS NOT NULL)      AS "rateableDamCount",
        (SELECT MIN(observed_at)      FROM observations)                                   AS "oldestObs"
    `,
    nationalStorageTotals(),
    coverageHeadline(),
  ]);
  const row = rows[0];
  if (!row) throw new Error('homeStats query returned no row');
  return {
    ...row,
    rateableStorageM3: totals.storageM3,
    observedDamCount: totals.observedDamCount,
    observedActiveCapacityM3: totals.activeCapacityM3,
    realDamCount: coverage.realtimeDamCount,
    riverDamCount: coverage.riverDamCount,
    storageRateRiverDamCount: coverage.storageRateRiverDamCount,
    historicalDamCount: coverage.historicalDamCount,
  };
}

const fmt = (n: bigint | number) => Number(n).toLocaleString('ja-JP');

async function featuredSparklines(damIds: bigint[]): Promise<Map<string, number[]>> {
  if (damIds.length === 0) return new Map();
  // Pull the last ~30 daily volume points for each featured dam in a single
  // round-trip; cards then render an SVG sparkline server-side, so there's
  // no client cost beyond a tiny inline <path>.
  // postgres.js doesn't auto-cast a JS bigint[] to BIGINT[]; pass the IDs as
  // a stringified-int8 array so PostgreSQL can coerce.
  const damIdStrs = damIds.map((id) => id.toString());
  const rows = await sql<{ dam_id: bigint; series: string }[]>`
    SELECT dam_id,
           string_agg(last_storage_volume_m3::TEXT, ',' ORDER BY day) AS series
    FROM (
      SELECT dam_id, day, last_storage_volume_m3
      FROM obs_daily
      WHERE dam_id::TEXT = ANY(${damIdStrs}::TEXT[])
        AND day > NOW() - INTERVAL '60 days'
      ORDER BY dam_id, day
    ) sub
    GROUP BY dam_id
  `;
  const out = new Map<string, number[]>();
  for (const r of rows) {
    out.set(
      r.dam_id.toString(),
      r.series
        .split(',')
        .map((v) => Number(v))
        .filter((n) => Number.isFinite(n)),
    );
  }
  return out;
}

// Memoise the four home-page fetchers across requests. Dam metadata + the
// daily-grain change strip + macro counts barely move within a 5-minute
// window — caching them in-process turns warm hits into <50 ms responses
// without paying the DB round-trip. Tags let us invalidate from a future
// revalidateTag('home') if we ever need a manual refresh.
const HOME_CACHE_OPTS = { revalidate: 300, tags: ['home'] };

// unstable_cache uses JSON.stringify, which throws on bigint. Wrap each
// fetcher to coerce bigint → string/number before caching, and rehydrate at
// the call site where the original type is needed.
const cachedHomeStats = unstable_cache(
  async () => {
    const s = await homeStats();
    return {
      damCount: Number(s.damCount),
      watershedCount: Number(s.watershedCount),
      obsTotal: Number(s.obsTotal),
      obsLast24h: Number(s.obsLast24h),
      totalCapacityM3: s.totalCapacityM3,
      activeCapacityM3: s.activeCapacityM3,
      rateableStorageM3: s.rateableStorageM3,
      rateableDamCount: Number(s.rateableDamCount),
      observedDamCount: Number(s.observedDamCount),
      observedActiveCapacityM3: s.observedActiveCapacityM3,
      realDamCount: Number(s.realDamCount),
      riverDamCount: Number(s.riverDamCount),
      storageRateRiverDamCount: Number(s.storageRateRiverDamCount),
      historicalDamCount: Number(s.historicalDamCount),
      oldestObsIso: s.oldestObs?.toISOString() ?? null,
    };
  },
  ['home-stats'],
  HOME_CACHE_OPTS,
);
const cachedTopDams = unstable_cache(
  async () => {
    const r = await listDams({ pageSize: 6, orderBy: 'capacity' });
    return {
      ...r,
      // bigint → string for JSON safety; rehydrate after the cache read.
      items: r.items.map((d) => ({ ...d, id: d.id.toString() })),
    };
  },
  ['home-top-dams'],
  HOME_CACHE_OPTS,
);
const cachedNationalChange = unstable_cache(
  nationalStorageChange,
  ['home-national-change'],
  HOME_CACHE_OPTS,
);
const DROUGHT_THRESHOLD_PCT = 40;
const cachedDroughtDams = unstable_cache(
  async () => lowStorageDams(DROUGHT_THRESHOLD_PCT, 12),
  ['home-drought-dams'],
  HOME_CACHE_OPTS,
);
const cachedDriestWatersheds = unstable_cache(
  async () => driestWatersheds(6, 3),
  ['home-driest-watersheds'],
  HOME_CACHE_OPTS,
);
// unstable_cache JSON-stringifies its return value, which loses Map<>. Stash
// as a plain object keyed by dam_id; rehydrate to a Map at the call site.
const cachedFeaturedSparklines = unstable_cache(
  async (idsCsv: string): Promise<Record<string, number[]>> => {
    const ids = idsCsv.split(',').map((s) => BigInt(s));
    const m = await featuredSparklines(ids);
    return Object.fromEntries(m);
  },
  ['home-sparklines'],
  HOME_CACHE_OPTS,
);

export default async function Home() {
  const [statsRaw, latestRaw, change, droughtDams, driest] = await Promise.all([
    cachedHomeStats(),
    cachedTopDams(),
    cachedNationalChange(),
    cachedDroughtDams(),
    cachedDriestWatersheds(),
  ]);
  // Rehydrate JSON-safe primitives back to the shapes the rest of the page
  // expects (bigint dam ids, Date oldestObs).
  const s = {
    ...statsRaw,
    oldestObs: statsRaw.oldestObsIso ? new Date(statsRaw.oldestObsIso) : null,
  };
  const latest: Awaited<ReturnType<typeof listDams>> = {
    ...latestRaw,
    items: latestRaw.items.map((d) => ({ ...d, id: BigInt(d.id) })),
  };
  const sparklines = new Map(
    Object.entries(
      await cachedFeaturedSparklines(latest.items.map((d) => d.id.toString()).join(',')),
    ),
  );
  // 全国貯水率: 直近7日に実測のあるダムだけで、貯水量合計 ÷ 利水容量合計。
  // 実測のないダムは分子にも分母にも入れない（容量だけ混ぜると率が下振れする）。
  const overallRate = storageRate({
    observedDamCount: s.observedDamCount,
    storageM3: s.rateableStorageM3,
    activeCapacityM3: s.observedActiveCapacityM3,
  });
  const yearsCovered = s.oldestObs
    ? Math.max(1, Math.round((Date.now() - s.oldestObs.getTime()) / (365 * 24 * 3600 * 1000)))
    : null;

  // Dataset schema (schema.org / Google Dataset Search). One per page so an
  // agent that only fetches the homepage gets a structured citation of the
  // dataset, its publisher, license, and download URLs without scraping HTML.
  const datasetLd = {
    '@context': 'https://schema.org',
    '@type': 'Dataset',
    name: 'Dam Data Japan',
    alternateName: '日本のダム貯水量データ',
    description:
      'Master metadata and historical storage volume / inflow / outflow at 1-hour grain for ~2,749 dams across all 47 prefectures in Japan, aggregated from 国土数値情報 and ダム便覧 (with 国土地理院 for elevation and ja.wikipedia for photo fallback). Realtime values are not republished.',
    url: 'https://dam.teraren.com/',
    creator: {
      '@type': 'Person',
      name: 'Dam Data Japan operator',
      url: 'https://discord.gg/UbWqspWbAk',
    },
    license: 'https://dam.teraren.com/legal/terms',
    isAccessibleForFree: true,
    inLanguage: ['ja', 'en'],
    keywords: ['dam', 'reservoir', 'Japan', 'storage volume', 'hydrology', 'open data'],
    spatialCoverage: {
      '@type': 'Place',
      name: 'Japan',
      geo: { '@type': 'GeoShape', box: '24 122 46 146' },
    },
    distribution: [
      {
        '@type': 'DataDownload',
        encodingFormat: 'application/openapi+json',
        contentUrl: 'https://dam.teraren.com/api/v1/openapi.json',
        name: 'OpenAPI 3 specification',
      },
      {
        '@type': 'DataDownload',
        encodingFormat: 'application/hal+json',
        contentUrl: 'https://dam.teraren.com/api/v1/dams',
        name: 'JSON list of all dams',
      },
      {
        '@type': 'DataDownload',
        encodingFormat: 'text/csv',
        contentUrl:
          'https://dam.teraren.com/api/v1/dams/{slug}/observations?from=&to=&interval=daily&format=csv',
        name: 'Per-dam observation series CSV',
      },
    ],
  };
  // WebSite schema with SearchAction → enables Google's sitelinks search box
  // pointing at /search?q={query}.
  const websiteLd = {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    url: 'https://dam.teraren.com/',
    name: 'Dam Data Platform',
    inLanguage: 'ja',
    potentialAction: {
      '@type': 'SearchAction',
      target: { '@type': 'EntryPoint', urlTemplate: 'https://dam.teraren.com/search?q={query}' },
      'query-input': 'required name=query',
    },
  };
  // Organization schema → publisher signal (E-E-A-T) and a single anchor for
  // the social profile links surfaced in SERP knowledge cards.
  const orgLd = {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: 'Dam Data Japan',
    url: 'https://dam.teraren.com/',
    logo: 'https://dam.teraren.com/icon',
    sameAs: ['https://discord.gg/UbWqspWbAk', 'https://x.com/matsubokkuri'],
  };
  return (
    <>
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted JSON-LD
        dangerouslySetInnerHTML={{ __html: JSON.stringify(datasetLd) }}
      />
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted JSON-LD
        dangerouslySetInnerHTML={{ __html: JSON.stringify(websiteLd) }}
      />
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted JSON-LD
        dangerouslySetInnerHTML={{ __html: JSON.stringify(orgLd) }}
      />
      {/* Hero */}
      <section className="relative overflow-hidden pt-20 md:pt-28 pb-14 bg-white">
        <div className="absolute inset-0 dots-bg opacity-60 pointer-events-none" />
        <div className="relative max-w-7xl mx-auto px-5 md:px-10 grid lg:grid-cols-2 gap-12 items-center">
          <div className="z-10">
            <div className="eyebrow mb-5">
              <span className="inline-block w-6 h-px bg-primary align-middle mr-3" />
              RESERVOIR · OPEN DATA
            </div>
            <h1 className="font-display text-[36px] sm:text-[44px] md:text-[56px] font-extrabold leading-[1.08] tracking-[-0.02em] text-on-surface mb-6">
              日本のダム貯水データを、
              <br className="hidden sm:inline" />
              <span className="text-primary">誰にでも開かれた</span>形で。
            </h1>
            <p className="text-body-lg text-on-surface-variant mb-8 max-w-xl">
              全国 {fmt(s.damCount)} 基のダムを網羅。諸元データと 1 時間〜月次粒度の貯水量履歴を、
              研究者・防災担当・開発者のために
              <strong className="text-on-surface">無償で公開</strong>
              しています (リアルタイム値は一次情報源を併用してください)。
            </p>
            <div className="flex flex-wrap gap-3">
              <Link href="/dams" className="btn-primary text-base">
                ダムを探す
              </Link>
              <LocateWatershedButton />
              <Link href="/api/docs" className="btn-outline text-base">
                API 仕様を見る
              </Link>
            </div>
            <div className="mt-10 flex flex-wrap items-center gap-x-8 gap-y-3 text-sm">
              <div className="flex items-center gap-2">
                <LineChart className="text-primary" size={18} aria-hidden="true" />
                <span className="text-on-surface-variant">1 時間粒度の履歴</span>
              </div>
              <div className="flex items-center gap-2">
                <History className="text-primary" size={18} aria-hidden="true" />
                <span className="text-on-surface-variant">
                  {yearsCovered ? `直近 ${yearsCovered} 年分の履歴` : '長期トレンド'}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <BadgeCheck className="text-primary" size={18} aria-hidden="true" />
                <span className="text-on-surface-variant">商用利用可</span>
              </div>
            </div>
          </div>

          {/* Hero stat card */}
          <div className="relative">
            <div className="relative bg-gradient-to-br from-primary to-[#003f8c] rounded-2xl p-8 md:p-10 text-white overflow-hidden aspect-[4/3]">
              <div
                className="absolute inset-0 opacity-20"
                style={{
                  backgroundImage:
                    'radial-gradient(circle at 20% 30%, rgba(255,255,255,0.4) 0%, transparent 40%), radial-gradient(circle at 70% 70%, rgba(255,255,255,0.3) 0%, transparent 40%)',
                }}
              />
              <div className="relative h-full flex flex-col justify-between">
                <div>
                  <div className="text-[11px] font-bold tracking-[0.22em] uppercase text-primary-fixed-dim mb-3">
                    LIVE · Reservoir Registry
                  </div>
                  <div className="font-code text-[12px] text-primary-fixed-dim">
                    {'// dam.teraren.com/api/v1/dams.json'}
                  </div>
                </div>
                <div className="space-y-5">
                  <div>
                    <div className="text-[11px] uppercase tracking-wider text-primary-fixed-dim mb-1">
                      ダム総数 / Reservoirs
                    </div>
                    <div className="font-display font-extrabold text-5xl md:text-6xl tracking-tight tabular-nums">
                      {fmt(s.damCount)}
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-4 pt-5 border-t border-white/20">
                    <div>
                      <div className="text-[10px] uppercase tracking-wider text-primary-fixed-dim mb-1">
                        水系
                      </div>
                      <div className="font-code font-semibold text-xl tabular-nums">
                        {fmt(s.watershedCount)}
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase tracking-wider text-primary-fixed-dim mb-1">
                        観測レコード
                      </div>
                      <div className="font-code font-semibold text-xl tabular-nums">
                        {(Number(s.obsTotal) / 1_000_000).toFixed(1)}M
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase tracking-wider text-primary-fixed-dim mb-1">
                        全国貯水率
                      </div>
                      <div className="font-code font-semibold text-xl tabular-nums">
                        {overallRate != null ? `${(overallRate * 100).toFixed(1)}%` : '—'}
                      </div>
                    </div>
                  </div>
                </div>
                <div className="flex items-center justify-between text-[10px] uppercase tracking-widest text-primary-fixed-dim">
                  <span>Source: 国交省 · 国土数値情報</span>
                  <span className="flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-green-300 animate-pulse" />
                    SYNCED
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Drought alert — surfaced near top so visitors see at-risk dams
          before the marketing band. Renders nothing when no real-data dam
          is below the threshold. */}
      {droughtDams.length > 0 ? (
        <section className="bg-white py-6">
          <div className="max-w-7xl mx-auto px-5 md:px-10">
            <DroughtAlert dams={droughtDams} thresholdPct={DROUGHT_THRESHOLD_PCT} />
          </div>
        </section>
      ) : null}

      {/* Watershed spotlight — the driest 水系 as colour-coded tiles, so the
          per-watershed 貯水率 (the site's core signal) is visible from the
          front door, not buried on /watersheds. */}
      {driest.length > 0 ? (
        <section className="py-6">
          <div className="max-w-7xl mx-auto px-5 md:px-10">
            <WatershedSpotlight items={driest} />
          </div>
        </section>
      ) : null}

      {/* Free-API band */}
      <section className="bg-primary-container py-6">
        <div className="max-w-7xl mx-auto px-5 md:px-10 flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <KeyRound className="text-white" size={32} aria-hidden="true" />
            <h3 className="font-display text-h3 text-white font-semibold">
              無料の API キーで、すぐ使えます。
            </h3>
          </div>
          <p className="text-white/90 text-body-md font-medium text-center md:text-right max-w-md">
            Google でサインインして発行 (600 req/min · 100,000
            req/day)。研究・防災・教育・商用、いずれも無償でご利用いただけます。
          </p>
        </div>
      </section>

      {/* Macro stats */}
      <section className="py-16 md:py-20 bg-surface">
        <div className="max-w-7xl mx-auto px-5 md:px-10">
          <div className="border-l-4 border-primary pl-6 mb-8">
            <h2 className="font-display text-h2 font-semibold mb-2">マクロ指標</h2>
            <p className="text-body-md text-on-surface-variant">
              全国合計の容量・貯水量・直近の観測ボリュームをひと目で。
            </p>
          </div>
          {/* Hero metric: full-width single-row progress bar at the top */}
          <div className="bg-white border border-outline-variant rounded-xl p-5 mb-3">
            <div className="flex items-center gap-4 flex-wrap">
              <div className="text-sm text-on-surface-variant whitespace-nowrap">全国貯水率</div>
              <div className="flex-1 min-w-[200px]">
                <RateBar rate={overallRate} />
              </div>
              <div className="text-3xl font-display font-semibold tabular-nums whitespace-nowrap">
                {overallRate != null ? `${(overallRate * 100).toFixed(1)} %` : '—'}
              </div>
              <div className="basis-full text-xs text-on-surface-variant">
                {`現在貯水量 ÷ 利水容量（直近 7 日に実測のある ${fmt(s.observedDamCount)} 基で集計）`}
              </div>
            </div>
            {change.current ? (
              <div className="mt-4 pt-4 border-t border-outline-variant">
                <div className="text-xs text-on-surface-variant mb-2">全国合計貯水量の変化</div>
                <StorageChangeStrip change={change} />
              </div>
            ) : null}
          </div>
          {/* Coverage bar: dams with storage_rate / river management dams (height >= 15 m) */}
          {(() => {
            const pct =
              s.riverDamCount > 0
                ? ((s.storageRateRiverDamCount / s.riverDamCount) * 100).toFixed(1)
                : null;
            return (
              <div className="bg-white border border-outline-variant rounded-xl p-4 mb-3 flex items-center gap-4 flex-wrap">
                <div className="text-sm font-medium text-on-surface whitespace-nowrap">
                  貯水率取得ダムカバレッジ
                </div>
                <div className="flex-1 min-w-[160px]">
                  <div className="h-2 bg-surface-container-low rounded-full overflow-hidden">
                    <div
                      className="h-full bg-primary rounded-full"
                      style={{ width: pct ? `${pct}%` : '0%' }}
                    />
                  </div>
                </div>
                <div className="text-xl font-display font-semibold tabular-nums whitespace-nowrap">
                  {pct ? `${pct} %` : '—'}
                </div>
                <div className="basis-full text-xs text-on-surface-variant">
                  {`直近 30 日に貯水率データあり: ${fmt(s.storageRateRiverDamCount)} 基 / 河川管理ダム ${fmt(s.riverDamCount)} 基（高さ 15 m 以上）`}
                </div>
              </div>
            );
          })()}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Stat label="ダム" value={fmt(s.damCount)} sub="登録済み" />
            <Stat label="水系" value={fmt(s.watershedCount)} sub="一級・二級・その他" />
            <Stat
              label="観測レコード"
              value={fmt(s.obsTotal)}
              sub={yearsCovered ? `直近 ${yearsCovered} 年分` : ''}
            />
            <Stat label="直近24時間の観測" value={fmt(s.obsLast24h)} />
            <Stat
              label="全国合計貯水容量"
              value={fmtCapacityMcm(s.totalCapacityM3)}
              sub="登録ダム合計(総容量)"
            />
            <Stat
              label="全国合計利水容量"
              value={fmtCapacityMcm(s.activeCapacityM3)}
              sub="利水容量データのある全ダム合計"
            />
            <Stat
              label="現在の合計貯水量"
              value={fmtCapacityMcm(s.rateableStorageM3)}
              sub={`直近 7 日 · ${fmt(s.observedDamCount)} 基`}
            />
            <Stat
              label="観測カバー期間"
              value={yearsCovered ? `${yearsCovered} 年` : '—'}
              sub="最古〜現在"
            />
            <Stat
              label="実測データ"
              value={fmt(s.realDamCount)}
              sub={`基（直近 30 日 / 全 ${fmt(s.damCount)} 基中）→ 一覧へ`}
              href="/dams?real=1"
            />
            <Stat
              label="歴史データ"
              value={fmt(s.historicalDamCount)}
              sub={`基（NILIM mudam 経由の過去 5 年分含む / 全 ${fmt(s.damCount)} 基中）`}
            />
          </div>
        </div>
      </section>

      {/* Featured dams */}
      <section className="py-16 md:py-20 bg-white">
        <div className="max-w-7xl mx-auto px-5 md:px-10">
          <div className="border-l-4 border-primary pl-6 mb-8">
            <h2 className="font-display text-h2 font-semibold mb-2">代表的なダム</h2>
            <p className="text-body-md text-on-surface-variant">
              総貯水容量が大きい順。クリックで貯水量の長期推移グラフへ。
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {latest.items.map((d) => {
              const series = sparklines.get(d.id.toString());
              return <DamCard key={d.slug} d={d} {...(series ? { sparkline: series } : {})} />;
            })}
          </div>
          <p className="mt-6">
            <Link href="/dams" className="btn-outline text-sm">
              すべてのダムを見る
              <ArrowRight size={16} aria-hidden="true" />
            </Link>
          </p>
        </div>
      </section>

      {/* CTA grid */}
      <section className="py-16 md:py-20 bg-surface">
        <div className="max-w-7xl mx-auto px-5 md:px-10 grid grid-cols-1 md:grid-cols-3 gap-4">
          <CtaCard
            href="/map"
            Icon={MapIcon}
            title="日本のダム地図"
            text="全国のダムを地図で確認。円の大きさ = 容量、色 = 貯水率。"
          />
          <CtaCard
            href="/watersheds"
            Icon={ENTITY_ICONS.watershed}
            title="水系から探す"
            text="一級・二級水系ごとのダムと貯水率の推移を集計。"
          />
          <CtaCard
            href="/stats"
            Icon={BarChart3}
            title="マクロ統計"
            text="都道府県別・水系別・規模別の集計を一覧で。"
          />
        </div>
      </section>

      {/* Code sample */}
      <section className="py-16 md:py-20 bg-white">
        <div className="max-w-7xl mx-auto px-5 md:px-10 grid lg:grid-cols-2 gap-14 items-start">
          <div className="space-y-8">
            <div className="border-l-4 border-primary pl-6">
              <h2 className="font-display text-h2 font-semibold mb-3">無料 API でデータ連携。</h2>
              <p className="text-body-md text-on-surface-variant">
                Google サインインで発行できる無料の API キー (600 req/min · 100,000 req/day)
                で、クリーンな RESTful エンドポイントから構造化された JSON
                を取得。分析パイプラインにも、Web アプリにもすぐ投入できます。
              </p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
              <div className="card-surface">
                <Gauge className="text-primary mb-3" size={28} aria-hidden="true" />
                <h4 className="font-display font-bold mb-2">高速な集計 API</h4>
                <p className="text-sm text-on-surface-variant">
                  TimescaleDB 連続集計で、5 年分の月次データもミリ秒で。
                </p>
              </div>
              <div className="card-surface">
                <Braces className="text-primary mb-3" size={28} aria-hidden="true" />
                <h4 className="font-display font-bold mb-2">HATEOAS Level 3</h4>
                <p className="text-sm text-on-surface-variant">
                  すべてのレスポンスに `_links` を含む、自己記述的な JSON。
                </p>
              </div>
              <div className="card-surface">
                <Globe className="text-primary mb-3" size={28} aria-hidden="true" />
                <h4 className="font-display font-bold mb-2">空間検索</h4>
                <p className="text-sm text-on-surface-variant">
                  PostGIS で水系や近傍ダムを高速検索。
                </p>
              </div>
              <div className="card-surface">
                <History className="text-primary mb-3" size={28} aria-hidden="true" />
                <h4 className="font-display font-bold mb-2">時系列対応</h4>
                <p className="text-sm text-on-surface-variant">
                  hourly / daily / monthly の 3 解像度で取得。
                </p>
              </div>
            </div>
          </div>
          <div className="code-block">
            <div className="code-block-head">
              <div className="flex gap-1.5">
                <div className="w-3 h-3 rounded-full bg-[#ff5f57]" />
                <div className="w-3 h-3 rounded-full bg-[#febc2e]" />
                <div className="w-3 h-3 rounded-full bg-[#28c840]" />
              </div>
              <span className="text-white/50 font-code text-xs">fetch_dam.sh</span>
            </div>
            <div className="code-block-body">
              <pre>{`# ダム情報
${'curl'} -s https://dam.teraren.com/api/v1/dams/biwakokaihatsu-25 \\
  | jq '{name, totalCapacityM3, watershedName}'
{
  "name": "琵琶湖開発",
  "totalCapacityM3": "1900000000.00",
  "watershedName": "淀川"
}

# 1 年分の日次貯水量
curl -s "https://dam.teraren.com/api/v1/dams/biwakokaihatsu-25/observations\\
?from=2025-05-03&to=2026-05-03&interval=daily" \\
  | jq '.series | length'
365`}</pre>
            </div>
          </div>
        </div>
      </section>

      {/* Recruitment band. Sits directly after the API section because that's
          where developers stop scrolling. */}
      <section className="py-16 md:py-20 bg-surface-container-low border-t border-outline-variant">
        <div className="max-w-3xl mx-auto px-5 md:px-10 text-center">
          <div className="eyebrow mb-4 justify-center">
            <span className="inline-block w-6 h-px bg-primary align-middle mr-3" />
            CONTRIBUTE
          </div>
          <h2 className="font-display text-h2 font-semibold mb-4">
            このサイトは、一人で作っています。
          </h2>
          <p className="text-body-md text-on-surface-variant mb-8">
            全国のダムの実測値は、県・地方整備局・企業局へとバラバラに公開されていて、
            まだ取り込めていないダムが数多く残っています。カバレッジを一緒に上げてくれる
            開発者を探しています。データソースの情報提供だけでも歓迎です。
          </p>
          <div className="flex flex-wrap gap-3 justify-center">
            <Link href="/contribute" className="btn-primary text-base">
              開発者募集を見る
            </Link>
            <Link href="/coverage" className="btn-outline text-base">
              いまのカバレッジ
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}

// Horizontal progress bar for storage rate. Same colour scale as the
// reservoir gauge / map markers (red = 渇水, blue = 満水).
function RateBar({ rate }: { rate: number | null }) {
  if (rate == null || !Number.isFinite(rate)) {
    return (
      <div className="relative h-3 rounded-full bg-surface-container overflow-hidden">
        <div className="absolute inset-y-0 left-0 bg-on-surface-variant/30 w-0" />
      </div>
    );
  }
  const pct = Math.max(0, Math.min(1, rate)) * 100;
  const color =
    rate < 0.2
      ? '#dc2626'
      : rate < 0.4
        ? '#f97316'
        : rate < 0.6
          ? '#eab308'
          : rate < 0.8
            ? '#16a34a'
            : '#1e6dff';
  return (
    <div
      className="relative h-3 rounded-full bg-surface-container overflow-hidden"
      role="progressbar"
      tabIndex={0}
      aria-label="全国貯水率"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className="absolute inset-y-0 left-0 transition-[width] duration-500 ease-out"
        style={{ width: `${pct}%`, backgroundColor: color }}
      />
      {/* tick marks at 20/40/60/80 so the colour bands are decipherable */}
      <div className="absolute inset-0 flex justify-between pointer-events-none">
        {[0.2, 0.4, 0.6, 0.8].map((t) => (
          <div
            key={t}
            className="border-l border-white/60"
            style={{ marginLeft: `calc(${t * 100}% - 1px)`, height: '100%' }}
          />
        ))}
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  href,
}: {
  label: string;
  value: string;
  sub?: string;
  href?: string;
}) {
  const inner = (
    <>
      <div className="text-xs text-on-surface-variant">{label}</div>
      <div className="text-2xl font-display font-semibold tabular-nums">{value}</div>
      {sub && <div className="text-xs text-on-surface-variant mt-1">{sub}</div>}
    </>
  );
  if (href) {
    return (
      <Link
        href={href}
        className="block bg-white border border-outline-variant rounded-xl p-4 hover:border-primary transition-colors"
      >
        {inner}
      </Link>
    );
  }
  return <div className="bg-white border border-outline-variant rounded-xl p-4">{inner}</div>;
}

function CtaCard({
  href,
  Icon,
  title,
  text,
}: {
  href: string;
  Icon: LucideIcon;
  title: string;
  text: string;
}) {
  return (
    <Link href={href} className="card-surface block no-underline group">
      <Icon className="text-primary mb-3" size={36} aria-hidden="true" />
      <h3 className="font-display text-h3 font-bold mb-2 text-on-surface group-hover:text-primary">
        {title}
      </h3>
      <p className="text-sm text-on-surface-variant">{text}</p>
    </Link>
  );
}
