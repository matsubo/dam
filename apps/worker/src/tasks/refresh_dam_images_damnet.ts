// Periodic Damnet cover-image refresh.
// Re-scrapes the dam-info page for any dam whose `image_url` is null and
// drops in the first `{damnetID}DC{...}` photo URL. Idempotent.
import { sql } from '@dam/db/client';
import type { Task } from 'graphile-worker';

const BASE = 'https://dambinran.damnet.or.jp';

const refreshDamImagesDamnet: Task = async (_payload, _helpers) => {
  const UA =
    process.env.HTTP_USER_AGENT ??
    `dam-data-platform/0.1 (${process.env.HTTP_CONTACT_EMAIL ?? 'ops@example.com'})`;

  const rows = await sql<{ id: string; damnet: string }[]>`
    SELECT id::TEXT, external_ids->>'damnet' AS damnet
    FROM dams
    WHERE image_url IS NULL AND external_ids ? 'damnet'
  `;
  let found = 0;
  for (const r of rows) {
    try {
      const res = await fetch(`${BASE}/dams/japan/${r.damnet}`, {
        headers: { 'User-Agent': UA, Accept: 'text/html' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) continue;
      const html = await res.text();
      const re = new RegExp(
        `https://dambinran\\.damnet\\.or\\.jp/wp-content/uploads/[^"\\s)]*?\\b${r.damnet}DC[A-Z0-9_-]+\\.(?:jpe?g|png|webp)`,
        'gi',
      );
      const candidates = Array.from(html.matchAll(re), (m) => m[0]);
      if (candidates.length === 0) continue;
      const url =
        candidates.find((u) => /BU\d/i.test(u)) ??
        candidates.find((u) => /DO\d/i.test(u)) ??
        candidates[0]!;
      await sql`UPDATE dams SET image_url = ${url}, updated_at = NOW() WHERE id = ${r.id}::BIGINT`;
      found += 1;
      await new Promise((r) => setTimeout(r, 200)); // be polite
    } catch {
      // skip and keep going; next month's run will retry.
    }
  }
  console.log(`[images:refresh:damnet] checked=${rows.length} found=${found}`);
};

export default refreshDamImagesDamnet;
