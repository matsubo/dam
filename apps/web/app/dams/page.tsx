import { listDams } from '@dam/db/repo/dams';
import type { Metadata } from 'next';
import { Breadcrumbs } from '../../components/breadcrumbs.tsx';
import { DamTable } from '../../components/dam-table.tsx';
import { Pagination } from '../../components/pagination.tsx';

export const revalidate = 900;

export const metadata: Metadata = {
  title: 'ダム一覧',
  description: '日本全国のダム一覧。都道府県・水系・管理者で絞り込み。',
};

interface SP {
  searchParams?: Promise<{ pref?: string; watershed?: string; manager?: string; cursor?: string }>;
}

export default async function DamsPage({ searchParams }: SP) {
  const sp = (await searchParams) ?? {};
  const r = await listDams({
    pref: sp.pref ?? null,
    watershedSlug: sp.watershed ?? null,
    manager: sp.manager ?? null,
    search: null,
    cursor: sp.cursor ? BigInt(sp.cursor) : null,
    pageSize: 50,
  });
  return (
    <>
      <Breadcrumbs items={[{ label: 'ホーム', href: '/' }, { label: 'ダム' }]} />
      <h1 className="text-2xl font-semibold mb-4">ダム一覧</h1>
      <DamTable rows={r.items.map((i) => ({ ...i, totalCapacityM3: i.totalCapacityM3 }))} />
      <Pagination basePath="/dams" nextCursor={r.nextCursor?.toString() ?? null} />
    </>
  );
}
