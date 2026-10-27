import { PREFECTURES } from '@dam/core/prefectures';
import { findDamBySlug } from '@dam/db/repo/dams';
import { notFound } from 'next/navigation';
import { ImageResponse } from 'next/og';
import { damDisplayName } from '../../../lib/dam-name.ts';
import { loadDamReading } from '../../../lib/dam-reading-state.ts';
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
  // The page's state: a 提供元なし dam shows no gauge here either, and the
  // rate divides by the reading's effective capacity, as on the page.
  const { state } = await loadDamReading(d.id);
  const reading = state.kind === 'reading' ? state : null;
  const latest = reading?.latest ?? null;
  const cap = reading?.capacityM3 ?? null;

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
      aside={<BucketGauge rate={reading?.rate ?? null} label="貯水率" />}
    />,
    { ...size },
  );
}
