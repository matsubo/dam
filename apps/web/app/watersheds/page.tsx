import { listWatersheds } from '@dam/db/repo/watersheds';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Breadcrumbs } from '../../components/breadcrumbs.tsx';

export const revalidate = 3600;
export const metadata: Metadata = { title: '水系一覧' };

export default async function WatershedsPage() {
  const r = await listWatersheds({ pageSize: 500 });
  return (
    <>
      <Breadcrumbs items={[{ label: 'ホーム', href: '/' }, { label: '水系' }]} />
      <h1 className="text-2xl font-semibold mb-4">水系一覧</h1>
      <table>
        <thead>
          <tr>
            <th>水系</th>
            <th>区分</th>
            <th className="text-right">ダム数</th>
          </tr>
        </thead>
        <tbody>
          {r.items.map((w) => (
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
