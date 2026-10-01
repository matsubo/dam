import { PREFECTURES } from '@dam/core/prefectures';
import { findDamBySlug, latestObservation } from '@dam/db/repo/dams';
import { notFound } from 'next/navigation';
import { ImageResponse } from 'next/og';
import { damDisplayName } from '../../../lib/dam-name.ts';
import { fmtCapacityMcm, fmtDate } from '../../../lib/format.ts';
import { BucketGauge, OgCard } from '../../../lib/og-card.tsx';

// Per-dam social card: the dam's name, where it is, and its latest 貯水率 as
// a filled bucket in the shared rate-band colour. Overrides the site-wide
// app/opengraph-image.tsx for /dams/[slug].
export const alt = 'ダムの現在の貯水率と貯水量 — Dam Data Japan';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
// Reads the DB per request, like the page itself; never at build time.
export const dynamic = 'force-dynamic';

const PREF_NAME = new Map(PREFECTURES.map((p) => [p.code, p.name]));

export default async function OG({ params }: { params: Promise<{ slug: string }> }) {
  const { slug: rawSlug } = await params;
  const d = await findDamBySlug(decodeURIComponent(rawSlug));
  if (!d) notFound();
  const latest = await latestObservation(d.id);

  // Same denominator as the page's gauge: the observation's effective 利水容量
  // (season-aware for trusted sources), never total capacity.
  const cap = latest?.effectiveActiveCapacityM3 ? Number(latest.effectiveActiveCapacityM3) : null;
  const vol = latest?.storageVolumeM3 ? Number(latest.storageVolumeM3) : null;
  const rate = cap && cap > 0 && vol != null ? Math.min(1, vol / cap) : null;

  const place = [
    PREF_NAME.get(d.prefCode) ?? d.prefCode,
    d.watershedName ? `${d.watershedName}水系` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return new ImageResponse(
    <OgCard
      eyebrow={place}
      title={damDisplayName(d.name)}
      stats={[
        ['貯水量', fmtCapacityMcm(latest?.storageVolumeM3)],
        ['有効貯水容量', fmtCapacityMcm(cap ?? d.activeCapacityM3 ?? d.effectiveCapacityM3)],
        ['総貯水容量', fmtCapacityMcm(d.totalCapacityM3)],
      ]}
      footer={latest ? `${fmtDate(latest.observedAt)} 時点` : '観測データなし'}
      aside={<BucketGauge rate={rate} label="貯水率" />}
    />,
    { ...size },
  );
}
