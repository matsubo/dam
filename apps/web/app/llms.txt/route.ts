// llms.txt — concise machine-readable summary for LLM agents.
// Convention: https://llmstxt.org. Sits at /llms.txt as a sibling to
// robots.txt; complements the RFC 9727 API catalog by giving agents a
// human-language overview instead of a hyperlink set.

export const dynamic = 'force-static';
export const revalidate = 3600;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://dam.teraren.com';

const BODY = `# Dam Data Japan

> Open-data API for the storage volume, inflow, and outflow of every dam
> registered in Japan's national reservoir inventory. Built from public
> government sources (国土数値情報, ダム便覧, 国土地理院, 川の防災情報) and
> republished under permissive terms.

## At a glance

- 2,749 dams across all 47 prefectures
- Master attributes (capacity, height, year, manager, purpose) for ~87% of
  dams; the missing tail is small agricultural / sediment dams.
- Time-series at 1-hour grain with daily and monthly continuous aggregates.
- Free public API, 600 req/min · 100,000 req/day after Google sign-in.

## Discovery

- API catalog (RFC 9727): ${SITE_URL}/.well-known/api-catalog
- OpenAPI spec: ${SITE_URL}/api/v1/openapi.json
- HTML docs (Redoc): ${SITE_URL}/api/docs
- Markdown views: \`Accept: text/markdown\` works on /, /sources,
  /legal/terms, /legal/privacy

## Key endpoints

- \`/api/v1/dams\` — paginated list, filter by pref / watershed / manager
- \`/api/v1/dams/{slug}\` — single dam record (HAL+JSON with _links)
- \`/api/v1/dams/{slug}/observations\` — time series (\`interval=hourly|daily|monthly\`)
- \`/api/v1/watersheds/{slug}\` — watershed aggregate
- \`/api/v1/watersheds/{slug}/observations\` — watershed-summed series

## Data sources

- 国土交通省 国土数値情報 W01 / W07 / A21 — master locations, capacity,
  watersheds (annual)
- 一般財団法人日本ダム協会 ダム便覧 — 利水/有効貯水容量, purpose, type, photos
  (monthly)
- 国土地理院 — elevation, basemap tiles
- 川の防災情報 / 水文水質データベース — historical observations only
  (we do not republish realtime values; defer to the upstream sites for live data)
- ja.wikipedia.org — photo fallback (CC-BY-SA)

## How dams are matched across sources

NDI and Damnet have no shared key. We match by normalised name within the
same prefecture, stripping ダム/貯水池/池 and （再/元/新）markers. Multi-row
collisions (e.g. 早明浦（元）+ 早明浦（再）) inherit Damnet attributes via a
group-update; the Damnet ID itself attaches to one row only.

Documented at: ${SITE_URL}/sources

## Restrictions & disclaimers

- Not for life-safety or legal decisions — defer to upstream official sources.
- Storage rate uses 利水容量 (active conservation storage) as denominator,
  not 総貯水容量. Dams without 利水容量 in source data are excluded from
  rate aggregations rather than mis-labelled.

## Contact

- Operator: matsubokkuri@gmail.com
- Terms: ${SITE_URL}/legal/terms
- Privacy: ${SITE_URL}/legal/privacy
- Account / API keys: ${SITE_URL}/account/keys
`;

export function GET(): Response {
  return new Response(BODY, {
    status: 200,
    headers: {
      'content-type': 'text/markdown; charset=utf-8',
      'cache-control': 'public, max-age=3600',
    },
  });
}
