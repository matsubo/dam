import { listWatersheds } from '@dam/db/repo/watersheds';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Breadcrumbs } from '../../components/breadcrumbs.tsx';

export const revalidate = 3600;
export const metadata: Metadata = { title: '水系一覧' };

export default async function WatershedsPage() {
  // Fetch all watersheds. Order: 一級 first, then 二級, then 'other' — and
  // within each band, by descending dam count so the most populated systems
  // surface at the top. Filter to systems that actually have at least one
  // dam in the master, since this is a dam-data site.
  const r = await listWatersheds({ pageSize: 1000 });
  const all = r.items;
  const totals = all.reduce(
    (acc, w) => {
      acc[w.kind]++;
      return acc;
    },
    { first: 0, second: 0, other: 0 } as Record<'first' | 'second' | 'other', number>,
  );
  const withDams = all.filter((w) => w.damCount > 0);
  const ordered = [...withDams].sort((a, b) => {
    const rank = { first: 0, second: 1, other: 2 } as const;
    if (rank[a.kind] !== rank[b.kind]) return rank[a.kind] - rank[b.kind];
    return b.damCount - a.damCount;
  });
  const counts = ordered.reduce(
    (acc, w) => {
      acc[w.kind]++;
      return acc;
    },
    { first: 0, second: 0, other: 0 } as Record<'first' | 'second' | 'other', number>,
  );
  const emptyCount = all.length - ordered.length;
  return (
    <>
      <Breadcrumbs items={[{ label: 'ホーム', href: '/' }, { label: '水系' }]} />
      <h1 className="text-2xl font-semibold mb-2">水系一覧</h1>
      <p className="text-muted mb-6 text-sm">
        ダムが登録されている {ordered.length} 水系を表示（一級 {counts.first} · 二級 {counts.second}{' '}
        · その他 {counts.other}）。マスタ全体は {all.length} 水系（一級 {totals.first} · 二級{' '}
        {totals.second} · その他 {totals.other}）
        {emptyCount > 0 ? `、うち ${emptyCount} 水系はダム登録なし` : ''}。
      </p>
      <table>
        <thead>
          <tr>
            <th>水系</th>
            <th>区分</th>
            <th className="text-right">ダム数</th>
          </tr>
        </thead>
        <tbody>
          {ordered.map((w) => (
            <tr key={w.slug}>
              <td>
                <Link href={`/watersheds/${w.slug}`}>{w.name}</Link>
              </td>
              <td>{w.kind === 'first' ? '一級' : w.kind === 'second' ? '二級' : 'その他'}</td>
              <td className="text-right">{w.damCount}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
