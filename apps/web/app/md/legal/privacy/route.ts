export const dynamic = 'force-static';
export const revalidate = 3600;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://dam.teraren.com';

// Advertising clauses appear only on a deploy that actually serves ads, so the
// policy never claims a data flow that isn't happening. Same env var that gates
// the AdSense components and /ads.txt.
const ADS_ENABLED = Boolean(process.env.NEXT_PUBLIC_ADSENSE_CLIENT);

// The list is data so the advertising clause can slot in without hand-renumbering.
const CLAUSES: readonly string[] = [
  `**Account info** — Only the email address and display name returned
   by Google OAuth are stored, used to bind API keys to a user. No
   passwords are received or stored.`,
  `**API request logs** — For authenticated requests we record API key
   ID, request time, and a per-minute aggregate count for rate limiting
   and abuse detection. We do not log request bodies or client IPs.`,
  `**Analytics** — Pageviews may be measured via Google Analytics 4
   with cookie-based anonymous session IDs. No personally identifying
   data is collected. Opt out via the Google Analytics opt-out browser
   add-on.`,
  ...(ADS_ENABLED
    ? [
        `**Advertising** — Some pages carry Google AdSense. Google and its
   partners may use cookies or device identifiers to serve and measure
   ads, including personalised ads. Manage or disable this at
   https://adssettings.google.com — see also
   https://policies.google.com/technologies/partner-sites .`,
      ]
    : []),
  `**No third-party sharing** — Except as required by law, by
   user consent, or in business succession.`,
  `**Self-service deletion** — At /account/keys you can revoke any API
   key or hard-delete your entire account (keys + usage logs).`,
  `**Cookies** — Used for sign-in session${ADS_ENABLED ? ', analytics and advertising' : ' and analytics'} only.`,
  '**Contact** — https://discord.gg/UbWqspWbAk (Discord). No direct email.',
];

const BODY = `# Privacy Policy

Last updated: ${ADS_ENABLED ? '2026-09-09' : '2026-05-04'}.

${CLAUSES.map((clause, i) => `${i + 1}. ${clause}`).join('\n')}

Full policy (HTML): ${SITE_URL}/legal/privacy
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
