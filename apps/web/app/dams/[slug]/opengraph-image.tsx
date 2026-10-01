import { PREFECTURES } from '@dam/core/prefectures';
import { findDamBySlug, latestObservation } from '@dam/db/repo/dams';
import { notFound } from 'next/navigation';
import { ImageResponse } from 'next/og';
import { damDisplayName } from '../../../lib/dam-name.ts';
import { fmtCapacityMcm, fmtDate } from '../../../lib/format.ts';
import { rateBand } from '../../../lib/rate-color.ts';

// Per-dam social card: the dam's name, where it is, and its latest 貯水率 as
// a filled bucket in the shared rate-band colour. Overrides the site-wide
// app/opengraph-image.tsx for /dams/[slug].
export const alt = 'ダムの現在の貯水率と貯水量 — Dam Data Platform';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
// Reads the DB per request, like the page itself; never at build time.
export const dynamic = 'force-dynamic';

const PREF_NAME = new Map(PREFECTURES.map((p) => [p.code, p.name]));

// Bucket geometry, shared by the outline, the water and the ticks.
const BW = 290;
const BH = 320;
const TOP_Y = 30;
const BOT_Y = 290;
const TOP_INSET = 30;
const BOT_INSET = 50;

function wallX(y: number): { left: number; right: number } {
  const t = (y - TOP_Y) / (BOT_Y - TOP_Y);
  const inset = TOP_INSET + (BOT_INSET - TOP_INSET) * t;
  return { left: inset, right: BW - inset };
}

function nameFontSize(name: string): number {
  if (name.length <= 8) return 84;
  if (name.length <= 11) return 68;
  if (name.length <= 15) return 54;
  return 44;
}

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
  const band = rateBand(rate);

  const dn = damDisplayName(d.name);
  const place = [
    PREF_NAME.get(d.prefCode) ?? d.prefCode,
    d.watershedName ? `${d.watershedName}水系` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const waterTop = BOT_Y - (BOT_Y - TOP_Y) * (rate ?? 0);
  const surface = wallX(waterTop);
  const bottom = wallX(BOT_Y);
  const water = `M${surface.left},${waterTop} L${surface.right},${waterTop} L${bottom.right},${BOT_Y} L${bottom.left},${BOT_Y} Z`;

  const stats: Array<[string, string]> = [
    ['貯水量', fmtCapacityMcm(latest?.storageVolumeM3)],
    ['有効貯水容量', fmtCapacityMcm(cap ?? d.activeCapacityM3 ?? d.effectiveCapacityM3)],
    ['総貯水容量', fmtCapacityMcm(d.totalCapacityM3)],
  ];

  return new ImageResponse(
    <div
      style={{
        width: 1200,
        height: 630,
        display: 'flex',
        background: 'linear-gradient(135deg, #0057c0 0%, #003f8c 100%)',
        position: 'relative',
        fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background:
            'radial-gradient(circle at 18% 28%, rgba(255,255,255,0.18), transparent 45%), radial-gradient(circle at 78% 72%, rgba(255,255,255,0.12), transparent 45%)',
        }}
      />
      {/* Left: name, place, figures */}
      <div
        style={{
          flex: 1,
          padding: '64px 40px 56px 64px',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          color: 'white',
        }}
      >
        <div style={{ display: 'flex', fontSize: 28, fontWeight: 600, color: '#bcd0ff' }}>
          {place}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 36 }}>
          <div
            style={{
              display: 'flex',
              fontSize: nameFontSize(dn),
              fontWeight: 800,
              lineHeight: 1.1,
              letterSpacing: '-0.02em',
            }}
          >
            {dn}
          </div>
          <div style={{ display: 'flex', gap: 44 }}>
            {stats.map(([label, value]) => (
              <div key={label} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ display: 'flex', fontSize: 20, color: '#bcd0ff' }}>{label}</div>
                <div style={{ display: 'flex', fontSize: 34, fontWeight: 700 }}>{value}</div>
              </div>
            ))}
          </div>
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            color: '#bcd0ff',
            fontSize: 20,
            fontWeight: 600,
          }}
        >
          <span>dam.teraren.com</span>
          <span>{latest ? `${fmtDate(latest.observedAt)} 時点` : '観測データなし'}</span>
        </div>
      </div>
      {/* Right: bucket gauge. Satori can't draw SVG <text>, so the
          percentage and band label are HTML overlaid on the SVG. */}
      <div
        style={{
          width: 400,
          padding: '0 60px 0 0',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 18,
        }}
      >
        <div style={{ display: 'flex', position: 'relative', width: BW, height: BH }}>
          {/* biome-ignore lint/a11y/noSvgWithoutTitle: Satori renders <title> as visible text, not hidden a11y metadata */}
          <svg
            width={BW}
            height={BH}
            viewBox={`0 0 ${BW} ${BH}`}
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              d={`M${TOP_INSET},${TOP_Y} L${BW - TOP_INSET},${TOP_Y} L${BW - BOT_INSET},${BOT_Y} L${BOT_INSET},${BOT_Y} Z`}
              fill="rgba(255,255,255,0.08)"
            />
            {rate != null && <path d={water} fill={band.color} />}
            {[0.25, 0.5, 0.75].map((t) => {
              const y = BOT_Y - (BOT_Y - TOP_Y) * t;
              const x = wallX(y).right;
              return (
                <line
                  key={t}
                  x1={x - 12}
                  y1={y}
                  x2={x}
                  y2={y}
                  stroke="white"
                  strokeOpacity="0.55"
                  strokeWidth="3"
                />
              );
            })}
            <path
              d={`M${TOP_INSET},${TOP_Y} L${BW - TOP_INSET},${TOP_Y} L${BW - BOT_INSET},${BOT_Y} L${BOT_INSET},${BOT_Y} Z`}
              fill="none"
              stroke="white"
              strokeWidth="6"
              strokeLinejoin="round"
            />
          </svg>
          <div
            style={{
              position: 'absolute',
              // Satori ignores the `inset` shorthand.
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 68,
              fontWeight: 800,
              color: 'white',
              textShadow: '0 2px 10px rgba(0,0,0,0.45)',
            }}
          >
            {rate == null ? '—' : `${(rate * 100).toFixed(1)}%`}
          </div>
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            fontSize: 26,
            fontWeight: 700,
            color: 'white',
          }}
        >
          <span style={{ width: 16, height: 16, borderRadius: 8, background: band.color }} />
          {rate == null ? '貯水率データなし' : `貯水率 · ${band.label}`}
        </div>
      </div>
    </div>,
    { ...size },
  );
}
