'use client';

import dynamic from 'next/dynamic';

// Redoc touches `window` during init, so it has to be client-only. The
// `RedocStandalone` React component pulls the spec, renders the three-pane
// reference docs, and applies our colour palette via the `theme` prop.
const RedocStandalone = dynamic(
  () => import('redoc').then((m) => ({ default: m.RedocStandalone })),
  {
    ssr: false,
    loading: () => (
      <div
        className="animate-pulse bg-gray-100 rounded-xl mx-auto max-w-7xl my-8"
        style={{ height: '70vh' }}
        aria-label="API ドキュメントを読み込み中"
      />
    ),
  },
);

export default function ApiDocsPage() {
  return (
    <RedocStandalone
      specUrl="/api/v1/openapi.json"
      options={{
        hideDownloadButton: false,
        nativeScrollbars: true,
        scrollYOffset: 64, // matches the sticky nav (h-16)
        theme: {
          colors: { primary: { main: '#0057c0' } },
          typography: {
            fontFamily:
              '-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif',
            headings: { fontFamily: 'inherit' },
            code: {
              fontFamily:
                'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
            },
          },
        },
      }}
    />
  );
}
