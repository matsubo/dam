import { ImageResponse } from 'next/og';

// Site-wide social-share card (1200×630) used for `og:image` and
// `twitter:image`. Dam-detail and watershed pages can ship their own
// `opengraph-image.tsx` later for per-page cards if needed; this is the
// fallback for everything else.
export const alt = 'Dam Data Platform — 日本のダム貯水量';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function OG() {
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
      {/* Soft radial decoration */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background:
            'radial-gradient(circle at 18% 28%, rgba(255,255,255,0.18), transparent 45%), radial-gradient(circle at 78% 72%, rgba(255,255,255,0.12), transparent 45%)',
        }}
      />
      {/* Left: copy */}
      <div
        style={{
          flex: 1,
          padding: '70px 60px',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          color: 'white',
        }}
      >
        <div
          style={{
            fontSize: 18,
            fontWeight: 700,
            letterSpacing: '0.22em',
            color: '#bcd0ff',
            textTransform: 'uppercase',
          }}
        >
          Reservoir · Open Data
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          {/* Satori (next/og) requires `display: flex` on any element with
              multiple children, so we stack the two lines with a column
              flexbox instead of using <br />. */}
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              fontSize: 76,
              fontWeight: 800,
              lineHeight: 1.05,
              letterSpacing: '-0.02em',
            }}
          >
            <div>日本のダム貯水量</div>
            <div>データを、開かれた形で。</div>
          </div>
          <div
            style={{
              fontSize: 26,
              fontWeight: 500,
              color: '#bcd0ff',
              maxWidth: 720,
              lineHeight: 1.4,
            }}
          >
            全国 2,749 基のダム諸元と 1 時間粒度の貯水量履歴。
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
          <span style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: 6,
                background: '#86efac',
              }}
            />
            履歴データ
          </span>
        </div>
      </div>
      {/* Right: bucket gauge visual. The SVG renders the bucket + water;
          satori (next/og) doesn't support <text> in SVG so the percentage
          label is overlaid as an HTML div with absolute positioning. */}
      <div
        style={{
          width: 380,
          padding: '70px 50px 70px 0',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          position: 'relative',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            position: 'relative',
            width: 290,
            height: 320,
          }}
        >
          {/* biome-ignore lint/a11y/noSvgWithoutTitle: Satori renders <title> as visible text, not hidden a11y metadata */}
          <svg width="290" height="320" viewBox="0 0 290 320" xmlns="http://www.w3.org/2000/svg">
            <path
              d="M30,30 L260,30 L240,290 L50,290 Z"
              fill="rgba(255,255,255,0.08)"
              stroke="white"
              strokeWidth="6"
              strokeLinejoin="round"
            />
            <path d="M44,128 L246,128 L240,290 L50,290 Z" fill="#3aa6ff" />
            <line
              x1="44"
              y1="128"
              x2="246"
              y2="128"
              stroke="white"
              strokeOpacity="0.6"
              strokeWidth="2"
            />
            <line
              x1="252"
              y1="225"
              x2="240"
              y2="225"
              stroke="white"
              strokeOpacity="0.55"
              strokeWidth="3"
            />
            <line
              x1="252"
              y1="160"
              x2="240"
              y2="160"
              stroke="white"
              strokeOpacity="0.55"
              strokeWidth="3"
            />
            <line
              x1="252"
              y1="95"
              x2="240"
              y2="95"
              stroke="white"
              strokeOpacity="0.55"
              strokeWidth="3"
            />
          </svg>
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 64,
              fontWeight: 800,
              color: 'white',
            }}
          >
            62%
          </div>
        </div>
      </div>
    </div>,
    { ...size },
  );
}
