import { sql } from '@dam/db/client';
import type { Metadata } from 'next';
import { Breadcrumbs } from '../../components/breadcrumbs.tsx';
import { JapanMap, type MapPoint } from '../../components/japan-map.tsx';

export const dynamic = 'force-dynamic';
export const revalidate = 3600;
export const metadata: Metadata = {
  title: '日本のダム地図',
  description: '全国のダムを地図で確認。円の大きさ＝総貯水容量、色＝最新貯水率。',
};

async function fetchPoints(): Promise<MapPoint[]> {
  // Bring back capacity + the latest storage_rate per dam so the map can
  // encode (size = capacity, color = storage_rate). The aggregate-source
  // observations don't carry storage_rate so we fall back to volume / capacity.
  return sql<MapPoint[]>`
    WITH latest AS (
      SELECT DISTINCT ON (dam_id) dam_id, storage_volume_m3, storage_rate
      FROM observations
      WHERE observed_at > NOW() - INTERVAL '30 days'
      ORDER BY dam_id, observed_at DESC
    )
    SELECT
      d.slug,
      d.name,
      ST_Y(d.location::geometry)            AS lat,
      ST_X(d.location::geometry)            AS lng,
      d.total_capacity_m3::FLOAT8           AS "capacityM3",
      COALESCE(
        l.storage_rate::FLOAT8,
        CASE
          WHEN d.total_capacity_m3 IS NOT NULL AND d.total_capacity_m3 > 0
            THEN l.storage_volume_m3::FLOAT8 / d.total_capacity_m3::FLOAT8
          ELSE NULL
        END
      )                                     AS "storageRate"
    FROM dams d
    LEFT JOIN latest l ON l.dam_id = d.id
    ORDER BY d.total_capacity_m3 DESC NULLS LAST
  `;
}

export default async function MapPage() {
  const points = await fetchPoints();
  return (
    <div className="max-w-7xl mx-auto px-5 md:px-10 py-8">
      <Breadcrumbs items={[{ label: 'ホーム', href: '/' }, { label: '地図' }]} />
      <h1 className="text-2xl font-semibold mb-2">日本のダム地図</h1>
      <p className="text-sm text-muted mb-4">
        円の面積 = 総貯水容量。色 = 最新貯水率（青=低 → 緑=中 → 黄=高）。
      </p>
      <JapanMap points={points} />
    </div>
  );
}
