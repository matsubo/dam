import { aggregateWatershed, findWatershedBySlug } from '@dam/db/repo/watersheds';
import { notFound } from 'next/navigation';
import { ImageResponse } from 'next/og';
import { fmtCapacityMcm, fmtDate } from '../../../lib/format.ts';
import { BucketGauge, OgCard } from '../../../lib/og-card.tsx';

// Per-watershed social card: 水系 name, kind, dam count and capacities, and
// the 水系合計貯水率 the page shows as a bucket. Overrides the site-wide
// app/opengraph-image.tsx for /watersheds/[slug].
export const alt = '水系のダム数と水系合計貯水率 — Dam Data Japan';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
// Reads the DB per request, like the page itself; never at build time.
export const dynamic = 'force-dynamic';

const KIND_LABEL = { first: '一級水系', second: '二級水系', other: '水系' } as const;

export default async function OG({ params }: { params: Promise<{ slug: string }> }) {
  const { slug: rawSlug } = await params;
  const w = await findWatershedBySlug(decodeURIComponent(rawSlug));
  if (!w) notFound();
  const agg = await aggregateWatershed(w.id);

  // Same rule as the page: the observed cohort's storage over the same
  // cohort's 有効貯水容量, so dams without fresh data stay out of both sides.
  const observedCap = agg.observedActiveCapacityM3 ? Number(agg.observedActiveCapacityM3) : null;
  const rate =
    agg.latestStorageVolumeM3 && observedCap && observedCap > 0
      ? Math.min(1, Number(agg.latestStorageVolumeM3) / observedCap)
      : null;

  const footer = agg.observedAt
    ? [
        `${fmtDate(agg.observedAt)} 時点`,
        agg.observedDamCount < agg.damCount
          ? `${agg.observedDamCount}/${agg.damCount} 基集計`
          : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : '観測データなし';

  return new ImageResponse(
    <OgCard
      eyebrow={KIND_LABEL[w.kind]}
      title={`${w.name}水系`}
      stats={[
        ['ダム数', `${agg.damCount} 基`],
        ['有効貯水容量', fmtCapacityMcm(agg.activeCapacityM3)],
        ['総貯水容量', fmtCapacityMcm(agg.totalCapacityM3)],
      ]}
      footer={footer}
      aside={<BucketGauge rate={rate} label="水系合計貯水率" />}
    />,
    { ...size },
  );
}
