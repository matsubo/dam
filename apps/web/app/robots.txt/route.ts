// Custom robots.txt route. We need a hand-written body (rather than Next's
// MetadataRoute.Robots) because we emit two non-standard directives:
//   1. Content Signals  - https://www.iana.org/assignments/content-signals
//   2. Per-AI-bot allow blocks for transparency
// neither of which Next's metadata Robots type supports.

export const dynamic = 'force-static';
export const revalidate = 86400;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://dam.teraren.com';

const AI_BOTS = [
  'GPTBot',
  'ChatGPT-User',
  'OAI-SearchBot',
  'Google-Extended',
  'CCBot',
  'anthropic-ai',
  'Claude-Web',
  'ClaudeBot',
  'PerplexityBot',
  'Bytespider',
  'cohere-ai',
  'Applebot-Extended',
  'DuckAssistBot',
  'FacebookBot',
  'Amazonbot',
];

export function GET(): Response {
  const aiBlocks = AI_BOTS.map(
    (b) => `User-agent: ${b}\nAllow: /\nDisallow: /api/\n`,
  ).join('\n');

  const body = `# Dam Data Japan — robots.txt
# Public open data on Japanese reservoirs. Crawling is welcome including by
# AI agents; the JSON API under /api/ is excluded so machines use the
# documented endpoints (see /api/docs and /.well-known/api-catalog).

User-agent: *
Allow: /
Disallow: /api/

# Content Signals (RFC draft / IETF AI Preferences WG).
# We're an open-data publisher: declare permissive intent for all uses.
Content-Signal: search=yes, ai-train=yes, ai-input=yes
Content-Usage: search=allowed, ai-training=allowed, ai-input=allowed

# Explicit per-AI-bot allow blocks. Consolidates intent for the long tail of
# AI crawlers that look up their own user-agent rather than the wildcard.
${aiBlocks}
Sitemap: ${SITE_URL}/sitemap.xml
`;
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'public, max-age=86400',
    },
  });
}
