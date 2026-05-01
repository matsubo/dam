import { sql } from '@dam/db/client';
import type { Metadata } from 'next';
import { Breadcrumbs } from '../../components/breadcrumbs.tsx';
import { fmtDate } from '../../lib/format.ts';

export const revalidate = 300;
export const metadata: Metadata = {
  title: 'データソース',
  description: '使用しているデータソースと最終取得時刻。',
};

interface Row {
  source_id: string;
  description: string | null;
  priority: number;
  active: boolean;
  last_fetched_at: Date | null;
  last_status: string | null;
}

export default async function SourcesPage() {
  const rows = await sql<Row[]>`
    SELECT sp.source_id, sp.description, sp.priority, sp.active,
           lf.last_fetched_at, lf.last_status
    FROM source_priorities sp
    LEFT JOIN LATERAL (
      SELECT fetched_at AS last_fetched_at, parse_status AS last_status
      FROM raw_snapshots WHERE source_id = sp.source_id
      ORDER BY fetched_at DESC LIMIT 1
    ) lf ON TRUE
    ORDER BY sp.priority DESC
  `;
  return (
    <>
      <Breadcrumbs items={[{ label: 'ホーム', href: '/' }, { label: 'データソース' }]} />
      <h1 className="text-2xl font-semibold mb-4">データソース</h1>
      <table>
        <thead>
          <tr>
            <th>ソース</th>
            <th>説明</th>
            <th>優先度</th>
            <th>最終取得</th>
            <th>状態</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.source_id}>
              <td>{r.source_id}</td>
              <td>{r.description ?? '—'}</td>
              <td>{r.priority}</td>
              <td>{fmtDate(r.last_fetched_at)}</td>
              <td>{r.last_status ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
