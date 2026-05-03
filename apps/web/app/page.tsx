import { sql } from '@dam/db/client';
import { listDams } from '@dam/db/repo/dams';
import type { Metadata } from 'next';
import Link from 'next/link';
import { DamCard } from '../components/dam-card.tsx';
import { fmtCapacityMcm } from '../lib/format.ts';

export const dynamic = 'force-dynamic';
export const revalidate = 900;
export const metadata: Metadata = {
  title: { absolute: 'Dam Data Platform — 日本のダム貯水量' },
  description: '日本全国のダム貯水量データと推移。1時間ごとの最新値と長期トレンド。',
};

interface HomeStats {
  damCount: bigint;
  watershedCount: bigint;
  obsTotal: bigint;
  obsLast24h: bigint;
  totalCapacityM3: string | null;
  totalStorageM3: string | null;
  oldestObs: Date | null;
}

async function homeStats(): Promise<HomeStats> {
  const rows = await sql<HomeStats[]>`
    SELECT
      (SELECT COUNT(*)            FROM dams)::BIGINT                                     AS "damCount",
      (SELECT COUNT(*)            FROM watersheds)::BIGINT                               AS "watershedCount",
      (SELECT COUNT(*)            FROM observations)::BIGINT                             AS "obsTotal",
      (SELECT COUNT(*)            FROM observations WHERE observed_at > NOW() - INTERVAL '24 hours')::BIGINT AS "obsLast24h",
      (SELECT SUM(total_capacity_m3)::TEXT FROM dams)                                    AS "totalCapacityM3",
      (SELECT SUM(volume)::TEXT FROM (
        SELECT DISTINCT ON (dam_id) storage_volume_m3 AS volume
        FROM observations WHERE observed_at > NOW() - INTERVAL '7 days'
        ORDER BY dam_id, observed_at DESC
      ) latest)                                                                          AS "totalStorageM3",
      (SELECT MIN(observed_at)    FROM observations)                                     AS "oldestObs"
  `;
  const row = rows[0];
  if (!row) throw new Error('homeStats query returned no row');
  return row;
}

const fmt = (n: bigint | number) => Number(n).toLocaleString('ja-JP');

export default async function Home() {
  const [s, latest] = await Promise.all([homeStats(), listDams({ pageSize: 6, orderBy: 'capacity' })]);
  const overallRate =
    s.totalCapacityM3 && s.totalStorageM3 && Number(s.totalCapacityM3) > 0
      ? Number(s.totalStorageM3) / Number(s.totalCapacityM3)
      : null;
  const yearsCovered = s.oldestObs
    ? Math.max(1, Math.round((Date.now() - s.oldestObs.getTime()) / (365 * 24 * 3600 * 1000)))
    : null;

  return (
    <>
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
              全国 {fmt(s.damCount)} 基のダムを網羅。1 時間ごとに更新する貯水量データを、
              研究者・防災担当・開発者のために<strong className="text-on-surface">無償で公開</strong>しています。
            </p>
            <div className="flex flex-wrap gap-3">
              <Link href="/dams" className="btn-primary text-base">
                ダムを探す
              </Link>
              <Link href="/api/docs" className="btn-outline text-base">
                API 仕様を見る
              </Link>
            </div>
            <div className="mt-10 flex flex-wrap items-center gap-x-8 gap-y-3 text-sm">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-primary text-base">update</span>
                <span className="text-on-surface-variant">1 時間ごと更新</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-primary text-base">history</span>
                <span className="text-on-surface-variant">
                  {yearsCovered ? `直近 ${yearsCovered} 年分の履歴` : '長期トレンド'}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-primary text-base">license</span>
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
                    // dam.teraren.com/api/v1/dams.json
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

      {/* No-key band */}
      <section className="bg-primary-container py-6">
        <div className="max-w-7xl mx-auto px-5 md:px-10 flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="material-symbols-outlined text-white" style={{ fontSize: 32 }}>
              key_off
            </span>
            <h3 className="font-display text-h3 text-white font-semibold">
              API キー不要。登録ゼロで、すぐ使えます。
            </h3>
          </div>
          <p className="text-white/90 text-body-md font-medium text-center md:text-right max-w-md">
            公開データへのアクセスに障壁を設けないことが、我々のオープンデータへのコミットメントです。
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
                現在貯水量 ÷ 総貯水容量（直近 7 日の最新値の合計）
              </div>
            </div>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Stat label="ダム" value={fmt(s.damCount)} sub="登録済み" />
            <Stat label="水系" value={fmt(s.watershedCount)} sub="一級・二級・その他" />
            <Stat
              label="観測レコード"
              value={fmt(s.obsTotal)}
              sub={yearsCovered ? `直近 ${yearsCovered} 年分` : ''}
            />
            <Stat label="直近24時間の観測" value={fmt(s.obsLast24h)} />
            <Stat label="全国合計貯水容量" value={fmtCapacityMcm(s.totalCapacityM3)} sub="登録ダム合計" />
            <Stat label="現在の合計貯水量" value={fmtCapacityMcm(s.totalStorageM3)} sub="直近 7 日の最新値" />
            <Stat
              label="観測カバー期間"
              value={yearsCovered ? `${yearsCovered} 年` : '—'}
              sub="最古〜現在"
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
            {latest.items.map((d) => (
              <DamCard key={d.slug} d={d} />
            ))}
          </div>
          <p className="mt-6">
            <Link href="/dams" className="btn-outline text-sm">
              すべてのダムを見る
              <span className="material-symbols-outlined text-base">arrow_forward</span>
            </Link>
          </p>
        </div>
      </section>

      {/* CTA grid */}
      <section className="py-16 md:py-20 bg-surface">
        <div className="max-w-7xl mx-auto px-5 md:px-10 grid grid-cols-1 md:grid-cols-3 gap-4">
          <CtaCard
            href="/map"
            icon="map"
            title="日本のダム地図"
            text="全国のダムを地図で確認。円の大きさ = 容量、色 = 貯水率。"
          />
          <CtaCard
            href="/watersheds"
            icon="water_drop"
            title="水系から探す"
            text="一級・二級水系ごとのダムと貯水率の推移を集計。"
          />
          <CtaCard
            href="/stats"
            icon="bar_chart"
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
              <h2 className="font-display text-h2 font-semibold mb-3">ゼロコンフィグでデータ連携。</h2>
              <p className="text-body-md text-on-surface-variant">
                API キー不要。クリーンな RESTful エンドポイントが構造化された JSON を返却します。
                分析パイプラインにも、Web アプリにもすぐ投入できます。
              </p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
              <div className="card-surface">
                <span className="material-symbols-outlined text-primary mb-3" style={{ fontSize: 28 }}>
                  speed
                </span>
                <h4 className="font-display font-bold mb-2">高速な集計 API</h4>
                <p className="text-sm text-on-surface-variant">
                  TimescaleDB 連続集計で、5 年分の月次データもミリ秒で。
                </p>
              </div>
              <div className="card-surface">
                <span className="material-symbols-outlined text-primary mb-3" style={{ fontSize: 28 }}>
                  data_object
                </span>
                <h4 className="font-display font-bold mb-2">HATEOAS Level 3</h4>
                <p className="text-sm text-on-surface-variant">
                  すべてのレスポンスに `_links` を含む、自己記述的な JSON。
                </p>
              </div>
              <div className="card-surface">
                <span className="material-symbols-outlined text-primary mb-3" style={{ fontSize: 28 }}>
                  public
                </span>
                <h4 className="font-display font-bold mb-2">空間検索</h4>
                <p className="text-sm text-on-surface-variant">
                  PostGIS で水系や近傍ダムを高速検索。
                </p>
              </div>
              <div className="card-surface">
                <span className="material-symbols-outlined text-primary mb-3" style={{ fontSize: 28 }}>
                  history
                </span>
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

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-white border border-outline-variant rounded-xl p-4">
      <div className="text-xs text-on-surface-variant">{label}</div>
      <div className="text-2xl font-display font-semibold tabular-nums">{value}</div>
      {sub && <div className="text-xs text-on-surface-variant mt-1">{sub}</div>}
    </div>
  );
}

function CtaCard({
  href,
  icon,
  title,
  text,
}: {
  href: string;
  icon: string;
  title: string;
  text: string;
}) {
  return (
    <Link href={href} className="card-surface block no-underline group">
      <span className="material-symbols-outlined text-primary mb-3" style={{ fontSize: 36 }}>
        {icon}
      </span>
      <h3 className="font-display text-h3 font-bold mb-2 text-on-surface group-hover:text-primary">
        {title}
      </h3>
      <p className="text-sm text-on-surface-variant">{text}</p>
    </Link>
  );
}
