import type { ReactNode } from 'react';
import { rateBand } from './rate-color.ts';

// Shared frame for the per-page social cards (dams, watersheds, prefectures):
// blue gradient, a left column of eyebrow / title / figures / footer, and a
// right-hand aside — usually the 貯水率 bucket. Rendered by Satori, so every
// multi-child div spells out display:flex.

// Bucket geometry, shared by the outline, the water and the ticks.
const BW = 290;
const BH = 320;
const TOP_Y = 30;
const BOT_Y = 290;
const TOP_INSET = 30;
const BOT_INSET = 50;
const OUTLINE = `M${TOP_INSET},${TOP_Y} L${BW - TOP_INSET},${TOP_Y} L${BW - BOT_INSET},${BOT_Y} L${BOT_INSET},${BOT_Y} Z`;

/** Layout for an aside's content: a centred column, figure above caption. */
export const ASIDE_STACK = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 18,
} as const;

function wallX(y: number): { left: number; right: number } {
  const t = (y - TOP_Y) / (BOT_Y - TOP_Y);
  const inset = TOP_INSET + (BOT_INSET - TOP_INSET) * t;
  return { left: inset, right: BW - inset };
}

function titleFontSize(title: string): number {
  if (title.length <= 8) return 84;
  if (title.length <= 11) return 68;
  if (title.length <= 15) return 54;
  return 44;
}

export function OgCard({
  eyebrow,
  title,
  stats,
  footer,
  aside,
}: {
  eyebrow: string;
  title: string;
  stats: Array<[string, string]>;
  footer: string;
  aside: ReactNode;
}) {
  return (
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
      {/* Left: eyebrow, title, figures */}
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
          {eyebrow}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 36 }}>
          <div
            style={{
              display: 'flex',
              fontSize: titleFontSize(title),
              fontWeight: 800,
              lineHeight: 1.1,
              letterSpacing: '-0.02em',
            }}
          >
            {title}
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
          <span>{footer}</span>
        </div>
      </div>
      {/* Right: aside, one node centred in the column */}
      <div
        style={{
          width: 400,
          padding: '0 60px 0 0',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {aside}
      </div>
    </div>
  );
}

/**
 * 貯水率 as a filled bucket in the shared rate-band colour, captioned
 * `${label} · ${band}` (or `${label}データなし` when rate is null). Satori
 * can't draw SVG <text>, so the percentage is HTML overlaid on the SVG.
 */
export function BucketGauge({ rate, label }: { rate: number | null; label: string }) {
  const band = rateBand(rate);
  const waterTop = BOT_Y - (BOT_Y - TOP_Y) * (rate ?? 0);
  const surface = wallX(waterTop);
  const bottom = wallX(BOT_Y);
  const water = `M${surface.left},${waterTop} L${surface.right},${waterTop} L${bottom.right},${BOT_Y} L${bottom.left},${BOT_Y} Z`;
  return (
    <div style={ASIDE_STACK}>
      <div style={{ display: 'flex', position: 'relative', width: BW, height: BH }}>
        {/* biome-ignore lint/a11y/noSvgWithoutTitle: Satori renders <title> as visible text, not hidden a11y metadata */}
        <svg width={BW} height={BH} viewBox={`0 0 ${BW} ${BH}`} xmlns="http://www.w3.org/2000/svg">
          <path d={OUTLINE} fill="rgba(255,255,255,0.08)" />
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
          <path d={OUTLINE} fill="none" stroke="white" strokeWidth="6" strokeLinejoin="round" />
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
            // "100.0%" at 68px runs past the bucket walls.
            fontSize: rate != null && rate >= 0.9995 ? 54 : 68,
            fontWeight: 800,
            color: 'white',
            textShadow: '0 2px 10px rgba(0,0,0,0.45)',
          }}
        >
          {rate == null ? '—' : `${(rate * 100).toFixed(1)}%`}
        </div>
      </div>
      <Caption color={band.color}>
        {rate == null ? `${label}データなし` : `${label} · ${band.label}`}
      </Caption>
    </div>
  );
}

/** Coloured dot + bold white line under the aside's main figure. */
export function Caption({ color, children }: { color: string; children: ReactNode }) {
  return (
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
      <span style={{ width: 16, height: 16, borderRadius: 8, background: color }} />
      {children}
    </div>
  );
}
