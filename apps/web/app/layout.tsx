import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { Nav } from '../components/nav.tsx';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Dam Data Platform', template: '%s — Dam Data Platform' },
  description: 'Realtime and historical reservoir-level data for dams across Japan.',
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000'),
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <body>
        <Nav />
        <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
        <footer className="mx-auto max-w-6xl px-4 py-8 text-sm text-muted">
          Data: 国交省 (川の防災情報, 水文水質DB), 国土数値情報, ダム便覧
        </footer>
      </body>
    </html>
  );
}
