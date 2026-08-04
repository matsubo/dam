import { ImageResponse } from 'next/og';

// Browser tab favicon — a tiny bucket-with-water glyph, same visual idiom
// as the ReservoirGauge component the rest of the site uses.
export const size = { width: 32, height: 32 };
export const contentType = 'image/png';

export default function Icon() {
  return new ImageResponse(
    <div
      style={{
        width: 32,
        height: 32,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#0057c0',
        borderRadius: 6,
      }}
    >
      {/* Bucket outline + water fill */}
      {/* biome-ignore lint/a11y/noSvgWithoutTitle: Satori renders <title> as visible text, not hidden a11y metadata */}
      <svg width="22" height="22" viewBox="0 0 22 22" xmlns="http://www.w3.org/2000/svg">
        <path d="M4,4 L18,4 L16,18 L6,18 Z" fill="white" stroke="white" strokeWidth="1.4" />
        <path d="M5,12 L17,12 L16,18 L6,18 Z" fill="#3aa6ff" />
      </svg>
    </div>,
    { ...size },
  );
}
