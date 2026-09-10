import { PREFECTURES } from '@dam/core/prefectures';
import { sql } from '@dam/db/client';
import {
  type StorageTotals,
  nationalStorageTotals,
  storageRate,
  storageTotalsByPref,
  storageTotalsByWatershed,
} from '@dam/db/repo/storage_totals';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Breadcrumbs } from '../../components/breadcrumbs.tsx';
import { fmtCapacityMcm } from '../../lib/format.ts';

export const dynamic = 'force-dynamic';
export const revalidate = 900;

export const metadata: Metadata = {
  title: 'マクロ統計',
  description: '日本全国のダムに関するマクロ指標。都道府県別・水系別・規模別の集計と最新貯水率。',
  alternates: { canonical: '/stats' },
};

const PREF_NAME = new Map(PREFECTURES.map((p) => [p.code, p.name]));

/** Master-side aggregates. Everything observation-derived comes from
 *  storage_totals so /stats and the home page share one definition. */
interface PrefRow {
  prefCode: string;
  damCount: number;
  totalCapacityM3: string | null;
  activeCapacityM3: string | null;
}
interface WsRow {
  slug: string;
  name: string;
  damCount: number;
  totalCapacityM3: string | null;
  activeCapacityM3: string | null;
}
interface SizeBucket {
  bucket: string;
  damCount: number;
  totalCapacityM3: string | null;
  activeCapacityM3: string | null;
}
interface YearRow {
  decade: number;
  damCount: number;
  totalCapacityM3: string | null;
  activeCapacityM3: string | null;
}
interface Headline {
  damCount: bigint;
  watershedCount: bigint;
  obsTotal: bigint;
  obsLast24h: bigint;
  totalCapacityM3: string | null;
  activeCapacityM3: string | null;
  oldestObs: Date | null;
  newestObs: Date | null;
  rawSnapshots: bigint;
  apiKeys: bigint;
}

async function loadStats() {
  const [headlineRows, prefs, ws, sizes, years, national, prefTotals, wsTotals] = await Promise.all(
    [
      sql<Headline[]>`
      SELECT
        (SELECT COUNT(*) FROM dams)::BIGINT                                    AS "damCount",
        (SELECT COUNT(*) FROM watersheds)::BIGINT                              AS "watershedCount",
        (SELECT COUNT(*) FROM observations)::BIGINT                            AS "obsTotal",
        (SELECT COUNT(*) FROM observations WHERE observed_at > NOW() - INTERVAL '24 hours')::BIGINT AS "obsLast24h",
        (SELECT SUM(total_capacity_m3)::TEXT FROM dams)                        AS "totalCapacityM3",
        (SELECT SUM(active_capacity_m3)::TEXT FROM dams WHERE active_capacity_m3 IS NOT NULL) AS "activeCapacityM3",
        (SELECT MIN(observed_at) FROM observations)                            AS "oldestObs",
        (SELECT MAX(observed_at) FROM observations)                            AS "newestObs",
        (SELECT COUNT(*) FROM raw_snapshots)::BIGINT                           AS "rawSnapshots",
        (SELECT COUNT(*) FROM api_keys WHERE revoked_at IS NULL)::BIGINT       AS "apiKeys"
    `,
      sql<PrefRow[]>`
      SELECT
        d.pref_code                     AS "prefCode",
        COUNT(d.id)::INT                AS "damCount",
        SUM(d.total_capacity_m3)::TEXT  AS "totalCapacityM3",
        SUM(d.active_capacity_m3)::TEXT AS "activeCapacityM3"
      FROM dams d
      GROUP BY d.pref_code
      ORDER BY SUM(d.total_capacity_m3) DESC NULLS LAST
    `,
      sql<WsRow[]>`
      SELECT
        w.slug                          AS slug,
        w.name                          AS name,
        COUNT(d.id)::INT                AS "damCount",
        SUM(d.total_capacity_m3)::TEXT  AS "totalCapacityM3",
        SUM(d.active_capacity_m3)::TEXT AS "activeCapacityM3"
      FROM watersheds w
      JOIN dams d ON d.watershed_id = w.id
      GROUP BY w.slug, w.name
      HAVING COUNT(d.id) > 0
      ORDER BY SUM(d.total_capacity_m3) DESC NULLS LAST
      LIMIT 20
    `,
      sql<SizeBucket[]>`
      SELECT
        CASE
          WHEN total_capacity_m3 IS NULL              THEN '不明'
          WHEN total_capacity_m3 >= 1e9               THEN '10億 m³ 以上'
          WHEN total_capacity_m3 >= 1e8               THEN '1〜10億 m³'
          WHEN total_capacity_m3 >= 1e7               THEN '1000万〜1億 m³'
          WHEN total_capacity_m3 >= 1e6               THEN '100〜1000万 m³'
          WHEN total_capacity_m3 >= 1e5               THEN '10〜100万 m³'
          ELSE '10万 m³ 未満'
        END                                AS bucket,
        COUNT(*)::INT                      AS "damCount",
        SUM(total_capacity_m3)::TEXT       AS "totalCapacityM3",
        SUM(active_capacity_m3)::TEXT      AS "activeCapacityM3"
      FROM dams
      GROUP BY bucket
      ORDER BY MAX(COALESCE(total_capacity_m3, 0)) DESC
    `,
      sql<YearRow[]>`
      SELECT
        (FLOOR(completed_year / 10) * 10)::INT AS decade,
        COUNT(*)::INT                          AS "damCount",
        SUM(total_capacity_m3)::TEXT           AS "totalCapacityM3",
        SUM(active_capacity_m3)::TEXT          AS "activeCapacityM3"
      FROM dams
      WHERE completed_year IS NOT NULL
      GROUP BY decade
      ORDER BY decade
    `,
      nationalStorageTotals(),
      storageTotalsByPref(),
      storageTotalsByWatershed(),
    ],
  );
  // biome-ignore lint/style/noNonNullAssertion: scalar-subselect SELECT with no FROM always returns exactly 1 row
  return { headline: headlineRows[0]!, prefs, ws, sizes, years, national, prefTotals, wsTotals };
}

/** 貯水率 over the observed cohort — '—' whenever nothing fresh was observed. */
function pct(totals: StorageTotals | undefined): string {
  const rate = storageRate(totals);
  return rate === null ? '—' : `${(rate * 100).toFixed(1)} %`;
}
const fmt = (n: bigint | number) => Number(n).toLocaleString('ja-JP');

/** "(実測 12 / 86 基)" — how much of the row the rate actually speaks for. */
function CohortNote({ observed, total }: { observed: number; total: number }) {
  if (observed === 0 || observed >= total) return null;
  return (
    <span className="text-[10px] text-muted ml-1">
      (実測 {observed}/{total})
    </span>
  );
}

export default async function StatsPage() {
  const s = await loadStats();
  const headline = s.headline;
  const overallRate = storageRate(s.national);
  return (
    <div className="max-w-7xl mx-auto px-5 md:px-10 py-8">
      <Breadcrumbs items={[{ label: 'ホーム', href: '/' }, { label: 'マクロ統計' }]} />
      <h1 className="text-3xl font-semibold mb-2">マクロ統計</h1>
      <p className="text-muted mb-6">
        全国のダムに関する集計指標。貯水量・貯水率は、直近 7
        日間に貯水量の実測があったダムだけを分子・分母の両方に用いて集計しています（実測のないダムの利水容量は分母に入れません）。取得できているダムの割合は{' '}
        <Link className="text-primary hover:underline" href="/coverage">
          カバレッジ
        </Link>{' '}
        を参照。
      </p>

      <h2 className="text-lg font-semibold mb-3">サマリー</h2>
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-8">
        <Stat label="ダム" value={fmt(headline.damCount)} />
        <Stat label="水系" value={fmt(headline.watershedCount)} />
        <Stat label="観測レコード総数" value={fmt(headline.obsTotal)} />
        <Stat label="直近24時間の観測" value={fmt(headline.obsLast24h)} />
        <Stat label="全国合計貯水容量" value={fmtCapacityMcm(headline.totalCapacityM3)} />
        <Stat
          label="全国合計利水容量"
          value={fmtCapacityMcm(headline.activeCapacityM3)}
          sub="利水容量データのある全ダム合計"
        />
        <Stat
          label="現在の合計貯水量"
          value={fmtCapacityMcm(s.national.storageM3)}
          sub={`直近 7 日 · ${fmt(s.national.observedDamCount)} 基`}
        />
        <Stat
          label="全国貯水率"
          value={overallRate != null ? `${(overallRate * 100).toFixed(1)} %` : '—'}
          sub={`現在貯水量 ÷ 利水容量（直近 7 日に実測のある ${fmt(s.national.observedDamCount)} 基で集計）`}
        />
        <Stat
          label="観測カバー期間"
          value={
            headline.oldestObs && headline.newestObs
              ? `${headline.oldestObs.toISOString().slice(0, 10)} 〜 ${headline.newestObs.toISOString().slice(0, 10)}`
              : '—'
          }
        />
        <Stat label="生データ・スナップショット" value={fmt(headline.rawSnapshots)} />
        <Stat label="有効APIキー" value={fmt(headline.apiKeys)} />
      </section>

      <h2 className="text-lg font-semibold mb-3">都道府県ランキング（容量上位）</h2>
      <table className="mb-8">
        <thead>
          <tr>
            <th>順位</th>
            <th>都道府県</th>
            <th>ダム数</th>
            <th>総貯水容量</th>
            <th>利水容量</th>
            <th>現在貯水量</th>
            <th>貯水率</th>
          </tr>
        </thead>
        <tbody>
          {s.prefs.map((p, i) => (
            <tr key={p.prefCode}>
              <td className="tabular-nums">{i + 1}</td>
              <td>
                <Link href={`/prefectures/${p.prefCode}`}>
                  {PREF_NAME.get(p.prefCode) ?? p.prefCode}
                </Link>
              </td>
              <td className="tabular-nums">{fmt(p.damCount)}</td>
              <td className="tabular-nums">{fmtCapacityMcm(p.totalCapacityM3)}</td>
              <td className="tabular-nums">{fmtCapacityMcm(p.activeCapacityM3)}</td>
              <td className="tabular-nums">
                {fmtCapacityMcm(s.prefTotals.get(p.prefCode)?.storageM3 ?? null)}
              </td>
              <td className="tabular-nums">
                {pct(s.prefTotals.get(p.prefCode))}
                <CohortNote
                  observed={s.prefTotals.get(p.prefCode)?.observedDamCount ?? 0}
                  total={p.damCount}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 className="text-lg font-semibold mb-3">水系ランキング（容量上位 20）</h2>
      <table className="mb-8">
        <thead>
          <tr>
            <th>順位</th>
            <th>水系</th>
            <th>ダム数</th>
            <th>総貯水容量</th>
            <th>利水容量</th>
            <th>現在貯水量</th>
            <th>貯水率</th>
          </tr>
        </thead>
        <tbody>
          {s.ws.map((w, i) => (
            <tr key={w.slug}>
              <td className="tabular-nums">{i + 1}</td>
              <td>
                <Link href={`/watersheds/${w.slug}`}>{w.name}</Link>
              </td>
              <td className="tabular-nums">{fmt(w.damCount)}</td>
              <td className="tabular-nums">{fmtCapacityMcm(w.totalCapacityM3)}</td>
              <td className="tabular-nums">{fmtCapacityMcm(w.activeCapacityM3)}</td>
              <td className="tabular-nums">
                {fmtCapacityMcm(s.wsTotals.get(w.slug)?.storageM3 ?? null)}
              </td>
              <td className="tabular-nums">
                {pct(s.wsTotals.get(w.slug))}
                <CohortNote
                  observed={s.wsTotals.get(w.slug)?.observedDamCount ?? 0}
                  total={w.damCount}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 className="text-lg font-semibold mb-3">規模別の分布</h2>
      <table className="mb-8">
        <thead>
          <tr>
            <th>容量レンジ</th>
            <th>ダム数</th>
            <th>合計総貯水容量</th>
            <th>合計利水容量</th>
          </tr>
        </thead>
        <tbody>
          {s.sizes.map((b) => (
            <tr key={b.bucket}>
              <td>{b.bucket}</td>
              <td className="tabular-nums">{fmt(b.damCount)}</td>
              <td className="tabular-nums">{fmtCapacityMcm(b.totalCapacityM3)}</td>
              <td className="tabular-nums">{fmtCapacityMcm(b.activeCapacityM3)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 className="text-lg font-semibold mb-3">竣工年代の分布</h2>
      <table className="mb-8">
        <thead>
          <tr>
            <th>年代</th>
            <th>ダム数</th>
            <th>合計総貯水容量</th>
            <th>合計利水容量</th>
          </tr>
        </thead>
        <tbody>
          {s.years.map((y) => (
            <tr key={y.decade}>
              <td>{y.decade}〜</td>
              <td className="tabular-nums">{fmt(y.damCount)}</td>
              <td className="tabular-nums">{fmtCapacityMcm(y.totalCapacityM3)}</td>
              <td className="tabular-nums">{fmtCapacityMcm(y.activeCapacityM3)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="border border-gray-200 rounded p-3">
      <div className="text-xs text-muted">{label}</div>
      <div className="text-xl font-semibold tabular-nums">{value}</div>
      {sub && <div className="text-[10px] text-muted mt-1">{sub}</div>}
    </div>
  );
}
