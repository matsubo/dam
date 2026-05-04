export const dynamic = 'force-static';
export const revalidate = 3600;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://dam.teraren.com';

const BODY = `# Terms of Use

Last updated: 2026-05-04.

By using this site or its API you accept these terms.

1. **Scope** — Dam Data Japan aggregates Japanese reservoir data from
   public sources (国土数値情報 W01/A21, 一般財団法人日本ダム協会 ダム便覧,
   国土地理院 地理院タイル/標高, ja.wikipedia 写真フォールバック) and
   republishes it via this website and the JSON API. Realtime observation
   values are not republished.
2. **Nature of data** — Values are derived from upstream sources via
   normalization, name-matching, and unit conversion. Latency, accuracy,
   and completeness are not guaranteed. **Do not use for decisive
   safety / disaster / legal determinations** — always consult primary
   sources.
3. **Free use** — Personal and commercial use is permitted at no cost.
   Crediting the original source (e.g. 国土交通省) is recommended.
4. **API keys** — Issued via Google sign-in at /account/keys. Keys are
   personal. Do not share, transfer, or publish a key. Default rate
   limits are 600 req/min and 100,000 req/day; abuse may result in key
   revocation without notice.
5. **Prohibited** — Disrupting service, sustained load testing without
   coordination, reselling the API verbatim, infringing third-party
   rights, redistributing source data outside the upstream license terms.
6. **No warranty** — Provided "as is". To the extent permitted by law,
   the operator is not liable for any direct or indirect damages.
7. **Governing law** — Japanese law. Tokyo District Court has exclusive
   jurisdiction in the first instance.
8. **Contact** — https://discord.gg/UbWqspWbAk (Discord). No direct email.

Full terms (HTML): ${SITE_URL}/legal/terms
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
