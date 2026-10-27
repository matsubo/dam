import { allSourceFacts } from '@dam/core/sources';
import { markdownResponse } from '../../../lib/markdown-response.ts';

export const dynamic = 'force-static';
export const revalidate = 3600;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://dam.teraren.com';

/** A table cell: no pipes or line breaks from the declaration text. */
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');

// Every declared source (packages/core/src/source_registry.ts), the same facts
// /sources and /api/v1/sources show; the 30-day counts are on those two.
const SOURCE_ROWS = allSourceFacts()
  .map(
    (s) =>
      `| ${cell(s.label)} (\`${s.sourceId}\`) | ${cell(s.upstream)} | ${cell(s.what)} | ${cell(s.cadence)} | ${cell(s.license ?? '未確認')} | ${s.status} | ${s.priority} |`,
  )
  .join('\n');

const BODY = `# Data Sources & Methodology

## External sources used

| Source | Upstream | Provides | Cadence | License | Status | Priority |
|---|---|---|---|---|---|---|
${SOURCE_ROWS}

Every observation served by this site comes from one of the upstream
sources above; there is no placeholder or generated data. Dams with no
upstream feed simply have no observations. To list only dams that do have
upstream data, use \`?real=1\` on /api/v1/dams.

## Name resolution (Damnet ↔ NDI)

NDI provides 2,749 dam rows; Damnet has ~2,600 detailed records but no
shared key. We match by:

1. Normalize both names — strip 「ダム」「貯水池」「池」 suffix and
   「（再）」「（元）」「（新）」 redevelopment markers, then NFKC + lower.
2. Key = \`prefCode | normalizedName\`. Same prefecture is required to avoid
   linking same-named dams in different prefectures.
3. When NDI has multiple rows under one key (e.g. 早明浦（元）+ 早明浦（再）),
   the Damnet ID attaches to one row and attributes (有効貯水容量 etc) backfill
   to all rows in the group.
4. Coverage: 87% of dams have 有効貯水容量 after this process. The remaining
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
- \`raw_snapshots\` — historical fetch log (until 2026-09); no longer written.
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
  return markdownResponse(BODY);
}
