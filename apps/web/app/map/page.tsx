import { sql } from '@dam/db/client';
import type { Metadata } from 'next';
import { unstable_cache } from 'next/cache';
import { Breadcrumbs } from '../../components/breadcrumbs.tsx';
import { JapanMap, type MapPoint } from '../../components/japan-map.tsx';

// Map page: 2,749 dam pins, expensive to compute (DISTINCT ON over recent
// observations + ST_X/ST_Y projection). force-dynamic skips Next's
// build-time static prerender (which fails because the build container
// can't reach the DB). The actual caching is provided by unstable_cache
// below — 24 h TTL across requests at runtime.
export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: '日本のダム地図',
  description: '全国のダムを地図で確認。円の大きさ＝総貯水容量、色＝最新貯水率。',
  alternates: { canonical: '/map' },
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
      -- size encoding: total capacity (every dam has it)
      d.total_capacity_m3::FLOAT8           AS "capacityM3",
      d.active_capacity_m3::FLOAT8          AS "activeCapacityM3",
      -- colour encoding: rate computed against 利水容量. Dams without
      -- 利水容量 (~51%) get a NULL rate which renders as a neutral grey marker.
      CASE
        WHEN d.active_capacity_m3 IS NOT NULL AND d.active_capacity_m3 > 0
        THEN LEAST(1.0, l.storage_volume_m3::FLOAT8 / d.active_capacity_m3::FLOAT8)
        ELSE NULL
      END                                   AS "storageRate"
    FROM dams d
    LEFT JOIN latest l ON l.dam_id = d.id
    ORDER BY d.total_capacity_m3 DESC NULLS LAST
  `;
}

// In-process cache for the entire map dataset. The 'map' tag lets a future
// post-ingest hook call revalidateTag('map') to refresh on demand.
const cachedFetchPoints = unstable_cache(
  async (): Promise<MapPoint[]> => {
    return await fetchPoints();
  },
  ['map-points-v1'],
  { revalidate: 86400, tags: ['map'] },
);

export default async function MapPage() {
  const points = await cachedFetchPoints();
  return (
    <div className="max-w-7xl mx-auto px-5 md:px-10 py-8">
      <Breadcrumbs items={[{ label: 'ホーム', href: '/' }, { label: '地図' }]} />
      <h1 className="text-2xl font-semibold mb-2">日本のダム地図</h1>
      <p className="text-sm text-muted mb-4">
        円の面積 = 総貯水容量。色 = 最新貯水率（赤=渇水 →
        青=満水、利水容量比）。データのないダムは灰色。
      </p>
      <JapanMap points={points} />
    </div>
  );
}
