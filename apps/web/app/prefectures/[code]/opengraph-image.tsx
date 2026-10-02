import { PREFECTURES } from '@dam/core/prefectures';
import { type DamListItem, listDamsPaged } from '@dam/db/repo/dams';
import { notFound } from 'next/navigation';
import { ImageResponse } from 'next/og';
import { fmtCapacityMcm } from '../../../lib/format.ts';
import { ASIDE_STACK, Caption, OgCard } from '../../../lib/og-card.tsx';

// Per-prefecture social card: dam count, capacities, and how many of the
// prefecture's dams have live observations. The page computes no aggregate
// 貯水率, so neither does the card. Overrides the site-wide
// app/opengraph-image.tsx for /prefectures/[code].
export const alt = '都道府県のダム数と貯水容量 — Dam Data Japan';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
// Reads the DB per request, like the page itself; never at build time.
export const dynamic = 'force-dynamic';

const PREF_NAME = new Map(PREFECTURES.map((p) => [p.code, p.name]));

function sumM3(items: DamListItem[], pick: (d: DamListItem) => string | null): number | null {
  const values = items.map(pick).filter((v): v is string => v != null);
  return values.length > 0 ? values.reduce((s, v) => s + Number(v), 0) : null;
}

export default async function OG({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const name = PREF_NAME.get(code);
  if (!name) notFound();

  const [first, real] = await Promise.all([
    listDamsPaged({ pref: code, pageSize: 200 }),
    // Same "実測データあり" rule as /dams?real=1: a non-synthetic observation
    // in the last 30 days.
    listDamsPaged({ pref: code, realDataOnly: true, pageSize: 1 }),
  ]);
  const rest = await Promise.all(
    Array.from({ length: first.totalPages - 1 }, (_, i) =>
      listDamsPaged({ pref: code, pageSize: 200, page: i + 2 }),
    ),
  );
  const dams = [first, ...rest].flatMap((p) => p.items);

  return new ImageResponse(
    <OgCard
      eyebrow="都道府県"
      title={`${name}のダム`}
      stats={[
        ['ダム数', `${first.total} 基`],
        ['有効貯水容量', fmtCapacityMcm(sumM3(dams, (d) => d.activeCapacityM3))],
        ['総貯水容量', fmtCapacityMcm(sumM3(dams, (d) => d.totalCapacityM3))],
      ]}
      footer="実測データあり = 直近30日に観測のあるダム"
      aside={
        <div style={ASIDE_STACK}>
          <div
            style={{
              width: 290,
              height: 320,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              border: '6px solid white',
              borderRadius: 28,
              background: 'rgba(255,255,255,0.08)',
              color: 'white',
            }}
          >
            <div style={{ display: 'flex', fontSize: 120, fontWeight: 800, lineHeight: 1 }}>
              {String(real.total)}
            </div>
            <div style={{ display: 'flex', fontSize: 36, fontWeight: 700, color: '#bcd0ff' }}>
              {`/ ${first.total} 基`}
            </div>
          </div>
          <Caption color="#16a34a">実測データあり</Caption>
        </div>
      }
    />,
    { ...size },
  );
}
