import { ImageResponse } from 'next/og';

// 180×180 apple-touch-icon. Larger format gives room for a wordmark hint.
export const size = { width: 180, height: 180 };
export const contentType = 'image/png';

export default function AppleIcon() {
  return new ImageResponse(
    <div
      style={{
        width: 180,
        height: 180,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'linear-gradient(135deg, #0057c0 0%, #003f8c 100%)',
        borderRadius: 38,
        position: 'relative',
      }}
    >
      <svg width="100" height="100" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
        <path d="M18,18 L82,18 L73,82 L27,82 Z" fill="white" stroke="white" strokeWidth="4" />
        <path d="M22,52 L78,52 L73,82 L27,82 Z" fill="#3aa6ff" />
        <line x1="22" y1="52" x2="78" y2="52" stroke="#ffffff" strokeOpacity="0.7" strokeWidth="2" />
      </svg>
      <div
        style={{
          color: 'white',
          fontSize: 22,
          fontWeight: 800,
          letterSpacing: '-0.02em',
          marginTop: 6,
        }}
      >
        Dam Data
      </div>
    </div>,
    { ...size },
  );
}
