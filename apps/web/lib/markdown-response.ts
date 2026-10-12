// Every Markdown answer under /md/*. proxy.ts rewrites an HTML URL here when
// the request asks for text/markdown, and on that rewrite this handler's
// Cache-Control is the one sent: it beats both the proxy's headers and
// next.config.ts headers(). Cloudflare keys its cache on the URL and ignores
// `Vary: Accept`, so a shared-cacheable answer would be stored under the HTML
// URL and served to browsers. `private` keeps it out of every shared cache
// (Cloudflare answers BYPASS).
export const MARKDOWN_CACHE_CONTROL = 'private, no-store';

export function markdownResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/markdown; charset=utf-8',
      'cache-control': MARKDOWN_CACHE_CONTROL,
      vary: 'Accept',
    },
  });
}
