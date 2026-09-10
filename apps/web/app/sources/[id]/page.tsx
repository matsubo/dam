import { PREFECTURES } from '@dam/core/prefectures';
import { sql } from '@dam/db/client';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Breadcrumbs } from '../../../components/breadcrumbs.tsx';
import { fmtDate, fmtPct } from '../../../lib/format.ts';
import { SOURCE_DETAILS } from '../../../lib/source-details.ts';

export const dynamic = 'force-dynamic';
export const revalidate = 300;

const PREF_NAME = new Map(PREFECTURES.map((p) => [p.code, p.name]));

interface PageProps {
  params: Promise<{ id: string }>;
}

interface SourceRow {
  source_id: string;
  description: string | null;
  priority: number;
  active: boolean;
  rows_30d: bigint;
  distinct_dams_30d: bigint;
  latest_observed_at: Date | null;
  earliest_observed_at: Date | null;
}

interface DamRow {
  id: bigint;
  slug: string;
  name: string;
  pref_code: string;
  latest_observed_at: Date | null;
  latest_storage_volume_m3: string | null;
  latest_storage_rate: number | null;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id: raw } = await params;
  const id = decodeURIComponent(raw);
  const detail = SOURCE_DETAILS[id];
  return {
    title: `データソース: ${detail?.label ?? id}`,
    description: detail?.what ?? `${id} ソースが提供するダム観測値の最新状態。`,
    alternates: { canonical: `/sources/${encodeURIComponent(id)}` },
  };
}

export default async function SourceDetailPage({ params }: PageProps) {
  const { id: raw } = await params;
  const id = decodeURIComponent(raw);
  const detail = SOURCE_DETAILS[id];

  const sourceRows = await sql<SourceRow[]>`
    SELECT
      sp.source_id,
      sp.description,
      sp.priority,
      sp.active,
      COALESCE(o.rows_30d, 0)::BIGINT          AS rows_30d,
      COALESCE(o.distinct_dams_30d, 0)::BIGINT AS distinct_dams_30d,
      o.latest_observed_at,
      o.earliest_observed_at
    FROM source_priorities sp
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*)::BIGINT                AS rows_30d,
        COUNT(DISTINCT dam_id)::BIGINT  AS distinct_dams_30d,
        MAX(observed_at)                AS latest_observed_at,
        MIN(observed_at)                AS earliest_observed_at
      FROM observations
      WHERE source_id = sp.source_id
        AND observed_at > NOW() - INTERVAL '30 days'
    ) o ON TRUE
    WHERE sp.source_id = ${id}
    LIMIT 1
  `;
  const source = sourceRows[0];
  if (!source) notFound();

  const dams = await sql<DamRow[]>`
    SELECT
      d.id, d.slug, d.name, d.pref_code,
      latest.observed_at  AS latest_observed_at,
      latest.storage_volume_m3::TEXT AS latest_storage_volume_m3,
      latest.storage_rate::FLOAT8    AS latest_storage_rate
    FROM dams d
    JOIN LATERAL (
      SELECT observed_at, storage_volume_m3, storage_rate
      FROM observations o
      WHERE o.dam_id = d.id
        AND o.source_id = ${id}
        AND o.observed_at > NOW() - INTERVAL '30 days'
      ORDER BY o.observed_at DESC
      LIMIT 1
    ) latest ON TRUE
    ORDER BY latest.observed_at DESC, d.id
    LIMIT 200
  `;

  return (
    <div className="max-w-5xl mx-auto px-5 md:px-10 py-8">
      <Breadcrumbs
        items={[
          { label: 'ホーム', href: '/' },
          { label: 'データソース', href: '/sources' },
          { label: detail?.label ?? id },
        ]}
      />
      <h1 className="text-2xl font-semibold mb-2">{detail?.label ?? id}</h1>
      <p className="text-sm text-on-surface-variant mb-6 max-w-3xl">
        {detail?.what ?? source.description ?? '—'}
      </p>

      <section className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-8">
        <Stat label="ID" value={source.source_id} mono />
        <Stat label="優先度" value={String(source.priority)} />
        <Stat
          label="ダム"
          value={`${Number(source.distinct_dams_30d).toLocaleString('ja-JP')} 基`}
          sub="直近30日"
        />
        <Stat
          label="観測件数"
          value={`${Number(source.rows_30d).toLocaleString('ja-JP')} 件`}
          sub="直近30日"
        />
      </section>

      {detail ? (
        <dl className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm mb-8">
          <Field label="提供元">{detail.upstream}</Field>
          <Field label="ライセンス">{detail.license}</Field>
          <Field label="取得頻度">{detail.cadence}</Field>
          <Field label="最新観測">
            {source.latest_observed_at ? fmtDate(source.latest_observed_at) : '—'}
          </Field>
        </dl>
      ) : null}

      <h2 className="text-lg font-semibold mb-3">このソースが提供するダム ({dams.length})</h2>
      {dams.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className="text-left">ダム</th>
                <th className="text-left">都道府県</th>
                <th className="text-right">貯水率</th>
                <th className="text-right">貯水量 (m³)</th>
                <th className="text-left">観測時刻</th>
              </tr>
            </thead>
            <tbody>
              {dams.map((d) => (
                <tr key={d.id.toString()}>
                  <td>
                    <Link href={`/dams/${d.slug}`} className="hover:text-primary">
                      {d.name}
                    </Link>
                  </td>
                  <td>{PREF_NAME.get(d.pref_code) ?? d.pref_code}</td>
                  <td className="text-right tabular-nums">
                    {d.latest_storage_rate != null ? fmtPct(d.latest_storage_rate) : '—'}
                  </td>
                  <td className="text-right tabular-nums">
                    {d.latest_storage_volume_m3
                      ? Number(d.latest_storage_volume_m3).toLocaleString('ja-JP')
                      : '—'}
                  </td>
                  <td className="text-xs text-on-surface-variant">
                    {d.latest_observed_at ? fmtDate(d.latest_observed_at) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm text-on-surface-variant">
          直近 30 日にこのソースからの観測値はありません。
        </p>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  mono,
}: {
  label: string;
  value: string;
  sub?: string;
  mono?: boolean;
}) {
  return (
    <div className="bg-white border border-outline-variant rounded-xl p-4">
      <div className="text-xs text-on-surface-variant">{label}</div>
      <div className={`text-xl font-semibold tabular-nums ${mono ? 'font-mono text-base' : ''}`}>
        {value}
      </div>
      {sub ? <div className="text-xs text-on-surface-variant mt-1">{sub}</div> : null}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="border border-outline-variant rounded p-3">
      <dt className="text-xs text-on-surface-variant mb-1">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
