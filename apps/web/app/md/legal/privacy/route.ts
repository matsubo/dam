export const dynamic = 'force-static';
export const revalidate = 3600;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://dam.teraren.com';

const BODY = `# Privacy Policy

Last updated: 2026-05-04.

1. **Account info** — Only the email address and display name returned
   by Google OAuth are stored, used to bind API keys to a user. No
   passwords are received or stored.
2. **API request logs** — For authenticated requests we record API key
   ID, request time, and a per-minute aggregate count for rate limiting
   and abuse detection. We do not log request bodies or client IPs.
3. **Analytics** — Pageviews may be measured via Google Analytics 4
   with cookie-based anonymous session IDs. No personally identifying
   data is collected. Opt out via the Google Analytics opt-out browser
   add-on.
4. **No third-party sharing** — Except as required by law, by
   user consent, or in business succession.
5. **Self-service deletion** — At /account/keys you can revoke any API
   key or hard-delete your entire account (keys + usage logs).
6. **Cookies** — Used for sign-in session and analytics only.
7. **Contact** — https://discord.gg/UbWqspWbAk (Discord). No direct email.

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
