import { PREFECTURES } from '@dam/core/prefectures';
import { sql } from '@dam/db/client';
import { sitemapDams } from '@dam/db/repo/dams';
import type { MetadataRoute } from 'next';

// Dynamic so we don't query the DB during `next build`. Cached for an hour
// in production via standard HTTP caching at the edge.
export const dynamic = 'force-dynamic';
export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000';
  const [dams, watersheds, sources] = await Promise.all([
    // Canonical dam pages only: a （元）/（再） twin deferring to its sibling is left out.
    sitemapDams(),
    sql<{ slug: string; updated_at: Date }[]>`SELECT slug, updated_at FROM watersheds ORDER BY id`,
    // Every id /sources/[id] renders (it 404s on anything not in this table).
    sql<{ source_id: string }[]>`SELECT source_id FROM source_priorities ORDER BY source_id`,
  ]);
  // Static and prefecture pages have no recorded change date, so they carry
  // no lastModified rather than a fresh timestamp on every fetch.
  return [
    { url: base, changeFrequency: 'daily', priority: 1.0 },
    { url: `${base}/dams`, changeFrequency: 'daily', priority: 0.9 },
    { url: `${base}/watersheds`, changeFrequency: 'weekly', priority: 0.8 },
    { url: `${base}/map`, changeFrequency: 'weekly', priority: 0.7 },
    { url: `${base}/stats`, changeFrequency: 'daily', priority: 0.5 },
    { url: `${base}/sources`, changeFrequency: 'daily', priority: 0.5 },
    { url: `${base}/roadmap`, changeFrequency: 'monthly', priority: 0.4 },
    { url: `${base}/glossary`, changeFrequency: 'monthly', priority: 0.4 },
    { url: `${base}/faq`, changeFrequency: 'monthly', priority: 0.4 },
    { url: `${base}/coverage`, changeFrequency: 'daily', priority: 0.5 },
    { url: `${base}/contribute`, changeFrequency: 'monthly', priority: 0.5 },
    { url: `${base}/api/docs`, changeFrequency: 'monthly', priority: 0.5 },
    { url: `${base}/legal/terms`, changeFrequency: 'yearly', priority: 0.2 },
    { url: `${base}/legal/privacy`, changeFrequency: 'yearly', priority: 0.2 },
    ...dams.map((d) => ({
      url: `${base}/dams/${encodeURIComponent(d.slug)}`,
      lastModified: d.lastModified,
      changeFrequency: 'daily' as const,
      priority: 0.7,
    })),
    ...watersheds.map((w) => ({
      url: `${base}/watersheds/${encodeURIComponent(w.slug)}`,
      lastModified: w.updated_at,
      changeFrequency: 'daily' as const,
      priority: 0.6,
    })),
    ...sources.map((s) => ({
      url: `${base}/sources/${encodeURIComponent(s.source_id)}`,
      changeFrequency: 'daily' as const,
      priority: 0.4,
    })),
    ...PREFECTURES.map((p) => ({
      url: `${base}/prefectures/${p.code}`,
      changeFrequency: 'daily' as const,
      priority: 0.5,
    })),
  ];
}
