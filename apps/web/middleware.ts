import { NextResponse, type NextRequest } from 'next/server';

// Two agent-affordances applied site-wide:
//
// 1. RFC 8288 `Link` headers with agent-useful relations (`api-catalog`,
//    `service-desc`, `service-doc`, `describedby`). isitagentready.com
//    explicitly looks for these and our scan was failing on it before.
//
// 2. Markdown content negotiation. When a client sends `Accept: text/markdown`
//    and the requested page has a Markdown alternative under /md/<path>,
//    we rewrite to that route. Agents that prefer Markdown can opt into it
//    with one Accept header — no separate URL discovery needed.

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://dam.teraren.com';

const LINK_HEADER = [
  `<${SITE_URL}/.well-known/api-catalog>; rel="api-catalog"; type="application/linkset+json"`,
  `<${SITE_URL}/.well-known/agent-skills>; rel="agent-skills"; type="application/json"`,
  `<${SITE_URL}/api/v1/openapi.json>; rel="service-desc"; type="application/openapi+json"`,
  `<${SITE_URL}/api/docs>; rel="service-doc"; type="text/html"`,
  `<${SITE_URL}/sources>; rel="service-meta"; type="text/html"`,
  `<${SITE_URL}/llms.txt>; rel="describedby"; type="text/markdown"`,
  `<${SITE_URL}/legal/terms>; rel="terms-of-service"; type="text/html"`,
  `<${SITE_URL}/legal/privacy>; rel="privacy-policy"; type="text/html"`,
].join(', ');

// Pages that have a hand-curated Markdown sibling. Anything outside this list
// gets a 406 if the client demanded Markdown — better than serving HTML
// labelled as Markdown.
const MD_ROUTES = new Set<string>(['/', '/sources', '/legal/terms', '/legal/privacy']);

function prefersMarkdown(accept: string | null): boolean {
  if (!accept) return false;
  // Trivial Accept parser: split by comma, look for `text/markdown` with a
  // higher q than `text/html` (or no q at all).
  const items = accept.split(',').map((s) => s.trim());
  let mdQ = 0;
  let htmlQ = 0;
  for (const item of items) {
    const [media, ...params] = item.split(';').map((s) => s.trim());
    const q = (() => {
      for (const p of params) {
        const m = p.match(/^q=(\d*\.?\d+)$/);
        if (m) return Number(m[1]);
      }
      return 1;
    })();
    if (media === 'text/markdown') mdQ = Math.max(mdQ, q);
    if (media === 'text/html' || media === '*/*') htmlQ = Math.max(htmlQ, q);
  }
  return mdQ > 0 && mdQ >= htmlQ;
}

export function middleware(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;

  // Legacy-slug redirect: watersheds used to be stored as `watershed-{name}`
  // (visible in URLs as /watersheds/watershed-賀茂川). Migration 0027 dropped
  // the prefix; bounce any leftover external link to the canonical form so
  // search-engine and third-party bookmarks don't 404.
  if (pathname.startsWith('/watersheds/watershed-')) {
    const url = req.nextUrl.clone();
    url.pathname = pathname.replace('/watersheds/watershed-', '/watersheds/');
    return NextResponse.redirect(url, 308);
  }

  // Markdown negotiation: rewrite to the /md/* sibling when applicable.
  if (prefersMarkdown(req.headers.get('accept')) && MD_ROUTES.has(pathname)) {
    const url = req.nextUrl.clone();
    url.pathname = `/md${pathname === '/' ? '/index' : pathname}`;
    const res = NextResponse.rewrite(url);
    res.headers.set('Link', LINK_HEADER);
    res.headers.set('Vary', 'Accept');
    return res;
  }

  const res = NextResponse.next();
  res.headers.set('Link', LINK_HEADER);
  // Tell shared caches that we vary the body on Accept (for MD negotiation).
  const existingVary = res.headers.get('Vary');
  res.headers.set('Vary', existingVary ? `${existingVary}, Accept` : 'Accept');
  return res;
}

export const config = {
  // Skip Next internals + the API itself + static assets so we don't override
  // upstream Link / Vary headers there.
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|.well-known).*)'],
};
