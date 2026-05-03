import { PREFECTURES } from '@dam/core/prefectures';
import { sql } from '@dam/db/client';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Breadcrumbs } from '../../components/breadcrumbs.tsx';
import { fmtCapacityMcm } from '../../lib/format.ts';

export const dynamic = 'force-dynamic';
export const revalidate = 900;

export const metadata: Metadata = {
  title: 'マクロ統計',
  description:
    '日本全国のダムに関するマクロ指標。都道府県別・水系別・規模別の集計と最新貯水率。',
  alternates: { canonical: '/stats' },
};

const PREF_NAME = new Map(PREFECTURES.map((p) => [p.code, p.name]));

interface PrefRow {
  prefCode: string;
  damCount: number;
  totalCapacityM3: string | null;
  storageM3: string | null;
}
interface WsRow {
  slug: string;
  name: string;
  damCount: number;
  totalCapacityM3: string | null;
  storageM3: string | null;
}
interface SizeBucket {
  bucket: string;
  damCount: number;
  totalCapacityM3: string | null;
}
interface YearRow {
  decade: number;
  damCount: number;
  totalCapacityM3: string | null;
}
interface Headline {
  damCount: bigint;
  watershedCount: bigint;
  obsTotal: bigint;
  obsLast24h: bigint;
  totalCapacityM3: string | null;
  totalStorageM3: string | null;
  oldestObs: Date | null;
  newestObs: Date | null;
  rawSnapshots: bigint;
  apiKeys: bigint;
}

async function loadStats() {
  const [headlineRows, prefs, ws, sizes, years] = await Promise.all([
    sql<Headline[]>`
      SELECT
        (SELECT COUNT(*) FROM dams)::BIGINT                                    AS "damCount",
        (SELECT COUNT(*) FROM watersheds)::BIGINT                              AS "watershedCount",
        (SELECT COUNT(*) FROM observations)::BIGINT                            AS "obsTotal",
        (SELECT COUNT(*) FROM observations WHERE observed_at > NOW() - INTERVAL '24 hours')::BIGINT AS "obsLast24h",
        (SELECT SUM(total_capacity_m3)::TEXT FROM dams)                        AS "totalCapacityM3",
        (SELECT SUM(volume)::TEXT FROM (
          SELECT DISTINCT ON (dam_id) storage_volume_m3 AS volume
          FROM observations WHERE observed_at > NOW() - INTERVAL '7 days'
          ORDER BY dam_id, observed_at DESC
        ) latest)                                                              AS "totalStorageM3",
        (SELECT MIN(observed_at) FROM observations)                            AS "oldestObs",
        (SELECT MAX(observed_at) FROM observations)                            AS "newestObs",
        (SELECT COUNT(*) FROM raw_snapshots)::BIGINT                           AS "rawSnapshots",
        (SELECT COUNT(*) FROM api_keys WHERE revoked_at IS NULL)::BIGINT       AS "apiKeys"
    `,
    sql<PrefRow[]>`
      WITH latest AS (
        SELECT DISTINCT ON (dam_id) dam_id, storage_volume_m3
        FROM observations WHERE observed_at > NOW() - INTERVAL '7 days'
        ORDER BY dam_id, observed_at DESC
      )
      SELECT
        d.pref_code               AS "prefCode",
        COUNT(d.id)::INT          AS "damCount",
        SUM(d.total_capacity_m3)::TEXT  AS "totalCapacityM3",
        SUM(latest.storage_volume_m3)::TEXT AS "storageM3"
      FROM dams d
      LEFT JOIN latest ON latest.dam_id = d.id
      GROUP BY d.pref_code
      ORDER BY SUM(d.total_capacity_m3) DESC NULLS LAST
    `,
    sql<WsRow[]>`
      WITH latest AS (
        SELECT DISTINCT ON (dam_id) dam_id, storage_volume_m3
        FROM observations WHERE observed_at > NOW() - INTERVAL '7 days'
        ORDER BY dam_id, observed_at DESC
      )
      SELECT
        w.slug                              AS slug,
        w.name                              AS name,
        COUNT(d.id)::INT                    AS "damCount",
        SUM(d.total_capacity_m3)::TEXT      AS "totalCapacityM3",
        SUM(latest.storage_volume_m3)::TEXT AS "storageM3"
      FROM watersheds w
      JOIN dams d ON d.watershed_id = w.id
      LEFT JOIN latest ON latest.dam_id = d.id
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
        SUM(total_capacity_m3)::TEXT       AS "totalCapacityM3"
      FROM dams
      GROUP BY bucket
      ORDER BY MAX(COALESCE(total_capacity_m3, 0)) DESC
    `,
    sql<YearRow[]>`
      SELECT
        (FLOOR(completed_year / 10) * 10)::INT AS decade,
        COUNT(*)::INT                          AS "damCount",
        SUM(total_capacity_m3)::TEXT           AS "totalCapacityM3"
      FROM dams
      WHERE completed_year IS NOT NULL
      GROUP BY decade
      ORDER BY decade
    `,
  ]);
  return { headline: headlineRows[0]!, prefs, ws, sizes, years };
}

function pct(volume: string | null, capacity: string | null): string {
  if (!volume || !capacity) return '—';
  const v = Number(volume);
  const c = Number(capacity);
  if (!Number.isFinite(v) || !Number.isFinite(c) || c <= 0) return '—';
  return `${((v / c) * 100).toFixed(1)} %`;
}
const fmt = (n: bigint | number) => Number(n).toLocaleString('ja-JP');

export default async function StatsPage() {
  const s = await loadStats();
  const headline = s.headline;
  const overallRate =
    headline.totalCapacityM3 && headline.totalStorageM3
      ? Number(headline.totalStorageM3) / Number(headline.totalCapacityM3)
      : null;
  return (
    <div className="max-w-7xl mx-auto px-5 md:px-10 py-8">
      <Breadcrumbs items={[{ label: 'ホーム', href: '/' }, { label: 'マクロ統計' }]} />
      <h1 className="text-3xl font-semibold mb-2">マクロ統計</h1>
      <p className="text-muted mb-6">
        全国のダムに関する集計指標。最新貯水量は直近7日間の最新観測値、貯水率は容量比です。
      </p>

      <h2 className="text-lg font-semibold mb-3">サマリー</h2>
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-8">
        <Stat label="ダム" value={fmt(headline.damCount)} />
        <Stat label="水系" value={fmt(headline.watershedCount)} />
        <Stat label="観測レコード総数" value={fmt(headline.obsTotal)} />
        <Stat label="直近24時間の観測" value={fmt(headline.obsLast24h)} />
        <Stat label="全国合計貯水容量" value={fmtCapacityMcm(headline.totalCapacityM3)} />
        <Stat label="現在の合計貯水量" value={fmtCapacityMcm(headline.totalStorageM3)} />
        <Stat
          label="全国貯水率"
          value={overallRate != null ? `${(overallRate * 100).toFixed(1)} %` : '—'}
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
              <td className="tabular-nums">{fmtCapacityMcm(p.storageM3)}</td>
              <td className="tabular-nums">{pct(p.storageM3, p.totalCapacityM3)}</td>
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
              <td className="tabular-nums">{fmtCapacityMcm(w.storageM3)}</td>
              <td className="tabular-nums">{pct(w.storageM3, w.totalCapacityM3)}</td>
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
            <th>合計容量</th>
          </tr>
        </thead>
        <tbody>
          {s.sizes.map((b) => (
            <tr key={b.bucket}>
              <td>{b.bucket}</td>
              <td className="tabular-nums">{fmt(b.damCount)}</td>
              <td className="tabular-nums">{fmtCapacityMcm(b.totalCapacityM3)}</td>
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
            <th>合計容量</th>
          </tr>
        </thead>
        <tbody>
          {s.years.map((y) => (
            <tr key={y.decade}>
              <td>{y.decade}〜</td>
              <td className="tabular-nums">{fmt(y.damCount)}</td>
              <td className="tabular-nums">{fmtCapacityMcm(y.totalCapacityM3)}</td>
            </tr>
          ))}
        </tbody>
      </table>
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
