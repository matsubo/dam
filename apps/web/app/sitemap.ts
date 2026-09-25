import { sql } from '@dam/db/client';
import type { MetadataRoute } from 'next';

// Dynamic so we don't query the DB during `next build`. Cached for an hour
// in production via standard HTTP caching at the edge.
export const dynamic = 'force-dynamic';
export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000';
  const [dams, watersheds] = await Promise.all([
    sql<{ slug: string; updated_at: Date }[]>`SELECT slug, updated_at FROM dams ORDER BY id`,
    sql<{ slug: string; updated_at: Date }[]>`SELECT slug, updated_at FROM watersheds ORDER BY id`,
  ]);
  const PREFS = (await import('@dam/core/prefectures')).PREFECTURES;
  const now = new Date();
  return [
    { url: base, lastModified: now, changeFrequency: 'daily', priority: 1.0 },
    { url: `${base}/dams`, lastModified: now, changeFrequency: 'daily', priority: 0.9 },
    { url: `${base}/watersheds`, lastModified: now, changeFrequency: 'weekly', priority: 0.8 },
    { url: `${base}/map`, lastModified: now, changeFrequency: 'weekly', priority: 0.7 },
    { url: `${base}/sources`, lastModified: now, changeFrequency: 'daily', priority: 0.5 },
    { url: `${base}/roadmap`, lastModified: now, changeFrequency: 'monthly', priority: 0.4 },
    { url: `${base}/glossary`, lastModified: now, changeFrequency: 'monthly', priority: 0.4 },
    { url: `${base}/faq`, lastModified: now, changeFrequency: 'monthly', priority: 0.4 },
    { url: `${base}/coverage`, lastModified: now, changeFrequency: 'daily', priority: 0.5 },
    { url: `${base}/contribute`, lastModified: now, changeFrequency: 'monthly', priority: 0.5 },
    ...dams.map((d) => ({
      url: `${base}/dams/${d.slug}`,
      lastModified: d.updated_at,
      changeFrequency: 'daily' as const,
      priority: 0.7,
    })),
    ...watersheds.map((w) => ({
      url: `${base}/watersheds/${w.slug}`,
      lastModified: w.updated_at,
      changeFrequency: 'daily' as const,
      priority: 0.6,
    })),
    ...PREFS.map((p) => ({
      url: `${base}/prefectures/${p.code}`,
      lastModified: now,
      changeFrequency: 'daily' as const,
      priority: 0.5,
    })),
  ];
}
