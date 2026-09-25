// Purge the whole Cloudflare zone so a deploy is visible at once instead of
// after the edge TTL. Coolify runs it as dam-web's post-deployment command:
//
//   bun run bin/purge_cdn.ts
//
// Needs CF_ZONE_ID and CF_API_TOKEN (Zone → Cache Purge). Without them it logs
// and exits 0, so a deploy never fails on a missing CDN credential.
// purge_everything is fine here: static chunks are content-hashed, and a URL
// list would rot as pages are added.

type Credentials = { zoneId: string | undefined; token: string | undefined };
type CloudflareResult = { success: boolean; errors?: { code: number; message: string }[] };

export async function purgeCdn(
  { zoneId, token }: Credentials,
  fetchImpl: typeof fetch = fetch,
): Promise<'purged' | 'skipped'> {
  if (!zoneId || !token) return 'skipped';
  const res = await fetchImpl(`https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ purge_everything: true }),
  });
  const body = (await res.json()) as CloudflareResult;
  if (!res.ok || !body.success) {
    const reason =
      body.errors?.map((e) => `${e.code} ${e.message}`).join('; ') || `HTTP ${res.status}`;
    throw new Error(`Cloudflare purge failed: ${reason}`);
  }
  return 'purged';
}

if (import.meta.main) {
  const result = await purgeCdn({
    zoneId: process.env.CF_ZONE_ID,
    token: process.env.CF_API_TOKEN,
  });
  console.log(
    result === 'purged'
      ? '[purge_cdn] Cloudflare cache purged'
      : '[purge_cdn] CF_ZONE_ID / CF_API_TOKEN not set — skipped',
  );
}
