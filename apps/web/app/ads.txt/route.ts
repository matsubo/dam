// IAB ads.txt — authorises Google to sell this domain's inventory.
// Spec: https://iabtechlab.com/ads-txt/
//
// Emitted only when NEXT_PUBLIC_ADSENSE_CLIENT is set, so a deploy that hasn't
// opted into advertising serves a plain 404 rather than an empty authorisation
// file (an empty ads.txt tells buyers *nobody* may sell, which is worse than
// none at all).
//
// The publisher id is the same `ca-pub-…` value the <AdSlot /> component uses;
// ads.txt wants it without the `ca-` prefix.

export const dynamic = 'force-static';
export const revalidate = 86400;

// f08c47fec0942fa0 is Google's TAG certification-authority id — a fixed
// constant every AdSense ads.txt line carries, not a per-publisher secret.
const GOOGLE_TAG_ID = 'f08c47fec0942fa0';

export function GET(): Response {
  const client = process.env.NEXT_PUBLIC_ADSENSE_CLIENT;
  if (!client) return new Response('Not Found', { status: 404 });

  const publisherId = client.replace(/^ca-/, '');
  const body = `google.com, ${publisherId}, DIRECT, ${GOOGLE_TAG_ID}\n`;

  return new Response(body, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=0, s-maxage=86400, stale-while-revalidate=604800',
    },
  });
}
