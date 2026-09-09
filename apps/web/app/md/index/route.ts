// Markdown variant of the homepage, served when middleware rewrites
// `/` requests that arrive with `Accept: text/markdown`. Hand-curated so
// agents see the structured summary an HTML→MD converter wouldn't capture.

export const dynamic = 'force-static';
export const revalidate = 3600;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://dam.teraren.com';

const BODY = `# Dam Data Japan

Open data API for the storage volume, inflow, and outflow of every dam
listed in Japan's national reservoir registry. Built from public sources
(国土数値情報, ダム便覧, 国土地理院, ja.wikipedia for photo fallback) and
republished under permissive terms. Realtime values are not republished.

## What you can do here
- Browse 2,749 dams with capacity, location, and operator metadata
- Read **historical** storage volume / rate / inflow / outflow at hourly,
  daily, or monthly granularity
- Aggregate by watershed (一級/二級水系) or by prefecture
- Pull JSON or CSV — no special protocol, plain HTTP

**Not realtime.** This service does not republish live readings. For
current-moment values, defer to 川の防災情報 (https://www.river.go.jp/) or the
operator's own dashboards.

## Public endpoints
- Human site: ${SITE_URL}/
- HTML API docs (Redoc): ${SITE_URL}/api/docs
- OpenAPI spec: ${SITE_URL}/api/v1/openapi.json
- API catalog (RFC 9727): ${SITE_URL}/.well-known/api-catalog
- Data sources & methodology: ${SITE_URL}/sources

## Authentication
Public read endpoints accept anonymous access via the website. The JSON API
under /api/v1 requires an API key issued from /account/keys. Send it as
\`Authorization: Bearer <key>\`. Default quota: 600 req/min, 100,000 req/day.

## Data update cadence
- Master (ダム諸元) refresh: monthly from NDI W01 + Damnet
- Observations: 1-hour native granularity, ingested in periodic batches
  from public archives (not realtime).

## Contributing
Built and run by one person. Coverage — getting live observations for the
dams that still only have master data — is the current priority, and help is
wanted: ${SITE_URL}/contribute. Donations: https://github.com/sponsors/matsubo

## Contact
- Contact: https://discord.gg/UbWqspWbAk (Discord — no email contact)
- Terms: ${SITE_URL}/legal/terms
- Privacy: ${SITE_URL}/legal/privacy
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
