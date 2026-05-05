import { PREFECTURES } from '@dam/core/prefectures';
import { listDams } from '@dam/db/repo/dams';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Breadcrumbs } from '../../../components/breadcrumbs.tsx';
import { DamTable } from '../../../components/dam-table.tsx';

export const dynamic = 'force-dynamic';
export const revalidate = 900;

const PREF_NAME = new Map(PREFECTURES.map((p) => [p.code, p.name]));

interface PageProps {
  params: Promise<{ code: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { code } = await params;
  const name = PREF_NAME.get(code);
  if (!name) return { title: '都道府県が見つかりません' };
  return {
    title: `${name}のダム`,
    description: `${name}に所在するダムの一覧と諸元。総貯水容量・水系・管理者で並び替え。`,
    alternates: { canonical: `/prefectures/${code}` },
  };
}

export default async function PrefPage({ params }: PageProps) {
  const { code } = await params;
  const name = PREF_NAME.get(code);
  if (!name) notFound();
  const r = await listDams({ pref: code, pageSize: 500 });
  return (
    <div className="max-w-7xl mx-auto px-5 md:px-10 py-8">
      <Breadcrumbs
        items={[{ label: 'ホーム', href: '/' }, { label: '都道府県' }, { label: name }]}
      />
      <h1 className="text-2xl font-semibold mb-4">{name}のダム</h1>
      <DamTable rows={r.items} />
    </div>
  );
}
