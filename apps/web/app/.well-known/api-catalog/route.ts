// RFC 9727 — API Catalog (linkset/Linkset+JSON, "service-desc" rel pointing
// to OpenAPI). Published at /.well-known/api-catalog so agents can discover
// every public endpoint of this site without reading the homepage.

export const dynamic = 'force-static';
export const revalidate = 3600;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://dam.teraren.com';

export function GET(): Response {
  const linkset = {
    linkset: [
      {
        anchor: `${SITE_URL}/api/v1`,
        'service-desc': [
          {
            href: `${SITE_URL}/api/v1/openapi.json`,
            type: 'application/openapi+json',
            title: 'OpenAPI 3 specification',
          },
        ],
        'service-doc': [
          {
            href: `${SITE_URL}/api/docs`,
            type: 'text/html',
            title: 'Human-readable API documentation (Redoc)',
          },
        ],
        'service-meta': [
          {
            href: `${SITE_URL}/sources`,
            type: 'text/html',
            title: 'Data sources, name-resolution methodology, ER diagram',
          },
        ],
        terms: [
          {
            href: `${SITE_URL}/legal/terms`,
            type: 'text/html',
            title: 'Terms of use',
          },
        ],
        privacy: [
          {
            href: `${SITE_URL}/legal/privacy`,
            type: 'text/html',
            title: 'Privacy policy',
          },
        ],
        author: [
          {
            href: 'https://discord.gg/UbWqspWbAk',
            title: 'Site operator (Discord)',
          },
        ],
      },
    ],
  };
  return new Response(JSON.stringify(linkset, null, 2), {
    status: 200,
    headers: {
      'content-type': 'application/linkset+json',
      'cache-control': 'public, max-age=3600',
      // Allow agents fetching from any origin to read the catalog.
      'access-control-allow-origin': '*',
    },
  });
}
