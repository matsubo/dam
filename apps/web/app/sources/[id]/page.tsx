import { PREFECTURES } from '@dam/core/prefectures';
import { sourceById } from '@dam/core/sources';
import { sourceDams, sourceSummary } from '@dam/db/repo/source_summary';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Breadcrumbs } from '../../../components/breadcrumbs.tsx';
import { fmtDate, fmtPct } from '../../../lib/format.ts';

export const dynamic = 'force-dynamic';
export const revalidate = 300;

const PREF_NAME = new Map(PREFECTURES.map((p) => [p.code, p.name]));

interface PageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id: raw } = await params;
  const id = decodeURIComponent(raw);
  const detail = sourceById(id)?.details;
  return {
    title: `データソース: ${detail?.label ?? id}`,
    description: detail?.what ?? `${id} ソースが提供するダム観測値の最新状態。`,
    alternates: { canonical: `/sources/${encodeURIComponent(id)}` },
  };
}

export default async function SourceDetailPage({ params }: PageProps) {
  const { id: raw } = await params;
  const id = decodeURIComponent(raw);
  const [source, dams] = await Promise.all([sourceSummary(id), sourceDams(id)]);
  if (!source) notFound();

  return (
    <div className="max-w-5xl mx-auto px-5 md:px-10 py-8">
      <Breadcrumbs
        items={[
          { label: 'ホーム', href: '/' },
          { label: 'データソース', href: '/sources' },
          { label: source.label },
        ]}
      />
      <h1 className="text-2xl font-semibold mb-2">{source.label}</h1>
      <p className="text-sm text-on-surface-variant mb-6 max-w-3xl">{source.what}</p>

      <section className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-8">
        <Stat label="ID" value={source.sourceId} mono />
        <Stat label="優先度" value={String(source.priority)} />
        <Stat label="ダム" value={`${source.dams30d.toLocaleString('ja-JP')} 基`} sub="直近30日" />
        <Stat
          label="観測件数"
          value={`${source.rows30d.toLocaleString('ja-JP')} 件`}
          sub="直近30日"
        />
      </section>

      <dl className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm mb-8">
        <Field label="提供元">{source.upstream}</Field>
        <Field label="ライセンス">{source.license ?? '未確認'}</Field>
        <Field label="取得頻度">{source.cadence}</Field>
        <Field label="最新観測">
          {source.latestObservedAt ? fmtDate(source.latestObservedAt) : '—'}
        </Field>
      </dl>

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
                  <td>{PREF_NAME.get(d.prefCode) ?? d.prefCode}</td>
                  <td className="text-right tabular-nums">
                    {d.latestStorageRate != null ? fmtPct(d.latestStorageRate) : '—'}
                  </td>
                  <td className="text-right tabular-nums">
                    {d.latestStorageVolumeM3
                      ? Number(d.latestStorageVolumeM3).toLocaleString('ja-JP')
                      : '—'}
                  </td>
                  <td className="text-xs text-on-surface-variant">{fmtDate(d.latestObservedAt)}</td>
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
