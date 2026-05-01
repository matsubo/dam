import { sql } from '@dam/db/client';
import type { Metadata } from 'next';
import { Breadcrumbs } from '../../components/breadcrumbs.tsx';
import { JapanMap, type MapPoint } from '../../components/japan-map.tsx';

export const revalidate = 3600;
export const metadata: Metadata = {
  title: '日本のダム地図',
  description: '全国のダムを地図で確認。',
};

async function fetchPoints(): Promise<MapPoint[]> {
  const rows = await sql<MapPoint[]>`
    SELECT slug, name,
           ST_Y(location::geometry) AS lat,
           ST_X(location::geometry) AS lng
    FROM dams
    ORDER BY id
  `;
  return rows;
}

export default async function MapPage() {
  const points = await fetchPoints();
  return (
    <>
      <Breadcrumbs items={[{ label: 'ホーム', href: '/' }, { label: '地図' }]} />
      <h1 className="text-2xl font-semibold mb-4">日本のダム地図</h1>
      <JapanMap points={points} />
    </>
  );
}
