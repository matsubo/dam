export const dynamic = 'force-static';
export const revalidate = 3600;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://dam.teraren.com';

const BODY = `# Data Sources & Methodology

## External sources used

| Source | Provides | Cadence | License |
|---|---|---|---|
| 国土交通省 国土数値情報 (NDI W01/W07/A21) | Master locations, capacity, watersheds | Annual | 政府標準利用規約 2.0 互換 |
| ダム便覧 (dambinran.damnet.or.jp) | 利水/有効貯水容量, purpose, type, photos | Monthly | Cite source |
| 国土地理院 (GSI) | Elevation (DEM10B/5A), basemap tiles | Monthly | Cite source |
| ja.wikipedia.org | Photo fallback (CC-BY-SA) | Monthly | CC-BY-SA |
| 川の防災情報 (river.go.jp) | Realtime observations | Hourly | Public |
| 水文水質データベース | Historical observations | Backfill | Public |

## Name resolution (Damnet ↔ NDI)

NDI provides 2,749 dam rows; Damnet has ~2,600 detailed records but no
shared key. We match by:

1. Normalize both names — strip 「ダム」「貯水池」「池」 suffix and
   「（再）」「（元）」「（新）」 redevelopment markers, then NFKC + lower.
2. Key = \`prefCode | normalizedName\`. Same prefecture is required to avoid
   linking same-named dams in different prefectures.
3. When NDI has multiple rows under one key (e.g. 早明浦（元）+ 早明浦（再）),
   the Damnet ID attaches to one row and attributes (利水容量 etc) backfill
   to all rows in the group.
4. Coverage: 87% of dams have 利水容量 after this process. The remaining
   13% are mostly small (<100,000 m³) agricultural / sediment dams not in
   Damnet.

## Schema overview

- \`dams\` — master, 2,749 rows. Includes location (PostGIS geography),
  capacity columns, external_ids JSON for source linkage.
- \`watersheds\` — 一級/二級/その他 boundaries (PostGIS).
- \`rivers\` — river references inside watersheds.
- \`observations\` — TimescaleDB hypertable, 1-hour grain. Columns:
  storage_volume_m3, storage_rate, inflow_m3s, outflow_m3s, water_level_m,
  rainfall_mm, quality_flag, source_id.
- \`obs_daily\`, \`obs_monthly\` — continuous aggregates auto-maintained
  by Timescale.
- \`raw_snapshots\` — audit log of every fetched bytes blob (S3 URI).
- \`match_review\` — pending fuzzy matches awaiting manual review.

## Granularity

- Native: 1-hour observations.
- Aggregations: daily (last/avg/max/min storage), monthly (avg only).
- Quality flag: 'ok', 'estimated', 'missing', 'invalid'. Filter by
  quality_flag = 'ok' for analysis.

## Reading the data
- HTML: ${SITE_URL}/sources
- OpenAPI: ${SITE_URL}/api/v1/openapi.json
- API catalog: ${SITE_URL}/.well-known/api-catalog
`;

export function GET(): Response {
  return new Response(BODY, {
    status: 200,
    headers: {
      'content-type': 'text/markdown; charset=utf-8',
      'cache-control': 'public, max-age=3600',
      vary: 'Accept',
    },
  });
}
