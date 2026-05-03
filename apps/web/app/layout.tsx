import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { ExtensionErrorShield } from '../components/extension-error-shield.tsx';
import { Nav } from '../components/nav.tsx';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Dam Data Platform', template: '%s — Dam Data Platform' },
  description: '日本全国のダム貯水量データ。1時間ごとに更新、長期トレンドも一括で。',
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000'),
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <head>
        {/* Material Symbols (Outlined) — matches the school.teraren.com palette */}
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/icon?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,300..700,0..1,-50..200"
        />
      </head>
      <body>
        <ExtensionErrorShield />
        <Nav />
        {/* All hero/feature sections set their own max-width; pages that just
            need a centred narrow column wrap their content themselves. */}
        <main className="pt-16">{children}</main>
        <SiteFooter />
      </body>
    </html>
  );
}

function SiteFooter() {
  return (
    <footer className="bg-surface-container-low border-t border-outline-variant mt-20">
      <div className="max-w-7xl mx-auto px-5 md:px-10 py-14">
        <div className="grid grid-cols-2 md:grid-cols-5 gap-8 mb-12">
          <div className="col-span-2">
            <div className="flex items-center gap-2.5 mb-4">
              <span className="material-symbols-outlined text-primary text-2xl">water</span>
              <span className="font-display text-lg font-extrabold tracking-tight text-on-surface">
                Dam Data
              </span>
            </div>
            <p className="text-sm text-on-surface-variant leading-relaxed max-w-sm mb-5">
              国土交通省・国土数値情報・ダム便覧の公開データをもとに、全国 2,749 基のダムの貯水量を 1
              時間ごとに集約・配信する公益サービス。研究・防災・教育・商用、いずれの用途にも無償でご利用いただけます。
            </p>
            <div className="flex flex-wrap gap-2 text-xs">
              <span className="px-2 py-1 rounded-full bg-white border border-outline-variant text-on-surface-variant">
                Open Data
              </span>
              <span className="px-2 py-1 rounded-full bg-white border border-outline-variant text-on-surface-variant">
                API キー不要
              </span>
              <span className="px-2 py-1 rounded-full bg-white border border-outline-variant text-on-surface-variant">
                毎時更新
              </span>
            </div>
          </div>

          <div>
            <div className="eyebrow-muted mb-4">カタログ</div>
            <ul className="space-y-2 text-sm">
              <li>
                <a className="text-on-surface-variant hover:text-primary transition-colors" href="/dams">
                  ダム一覧
                </a>
              </li>
              <li>
                <a className="text-on-surface-variant hover:text-primary transition-colors" href="/watersheds">
                  水系一覧
                </a>
              </li>
              <li>
                <a className="text-on-surface-variant hover:text-primary transition-colors" href="/map">
                  日本地図
                </a>
              </li>
              <li>
                <a className="text-on-surface-variant hover:text-primary transition-colors" href="/stats">
                  マクロ統計
                </a>
              </li>
            </ul>
          </div>

          <div>
            <div className="eyebrow-muted mb-4">開発者向け</div>
            <ul className="space-y-2 text-sm">
              <li>
                <a className="text-primary font-semibold hover:underline" href="/api/docs">
                  API 仕様
                </a>
              </li>
              <li>
                <a className="text-on-surface-variant hover:text-primary transition-colors" href="/api/v1/openapi.json">
                  OpenAPI JSON
                </a>
              </li>
              <li>
                <a className="text-on-surface-variant hover:text-primary transition-colors" href="/sources">
                  データソース
                </a>
              </li>
              <li>
                <a className="text-on-surface-variant hover:text-primary transition-colors" href="/sitemap.xml">
                  サイトマップ
                </a>
              </li>
              <li>
                <a className="text-on-surface-variant hover:text-primary transition-colors" href="/api/v1/healthz">
                  ヘルスチェック
                </a>
              </li>
            </ul>
          </div>

          <div>
            <div className="eyebrow-muted mb-4">サイトについて</div>
            <ul className="space-y-2 text-sm">
              <li>
                <a className="text-on-surface-variant hover:text-primary transition-colors" href="/sources">
                  データの出典
                </a>
              </li>
              <li>
                <a className="text-on-surface-variant hover:text-primary transition-colors" href="https://github.com/matsubo/dam" target="_blank" rel="noopener">
                  GitHub リポジトリ
                </a>
              </li>
              <li>
                <a className="text-on-surface-variant hover:text-primary transition-colors" href="mailto:matsubokkuri@gmail.com">
                  お問い合わせ
                </a>
              </li>
            </ul>
          </div>
        </div>

        {/* Data attribution band */}
        <div className="bg-white border border-outline-variant rounded-xl p-5 mb-8">
          <div className="eyebrow-muted mb-3">データ出典</div>
          <ul className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-2 text-xs text-on-surface-variant">
            <li>
              <span className="font-semibold text-on-surface">国土交通省</span> 川の防災情報（水位・流量・降雨量）
            </li>
            <li>
              <span className="font-semibold text-on-surface">国土交通省</span> 水文水質データベース（過去履歴）
            </li>
            <li>
              <span className="font-semibold text-on-surface">国土数値情報</span> ダム諸元 W01・水系流域 W07
            </li>
            <li>
              <span className="font-semibold text-on-surface">日本ダム協会</span> ダム便覧（写真・基本情報）
            </li>
            <li>
              <span className="font-semibold text-on-surface">国土地理院</span> 地理院タイル（地図表示）
            </li>
            <li>
              <span className="font-semibold text-on-surface">気象庁</span> 関連リファレンス
            </li>
          </ul>
        </div>

        <div className="pt-6 border-t border-outline-variant flex flex-col md:flex-row items-center justify-between gap-4">
          <p className="text-xs text-on-surface-variant font-display font-medium">
            © {new Date().getFullYear()} Dam Data Japan · Open Reservoir Data ·{' '}
            <span className="text-on-surface-variant/70">v0.1</span>
          </p>
          <div className="flex items-center gap-3">
            <a
              title="GitHub"
              href="https://github.com/matsubo/dam"
              target="_blank"
              rel="noopener"
              className="w-9 h-9 inline-flex items-center justify-center border border-outline-variant rounded-lg text-on-surface-variant hover:bg-primary hover:text-white hover:border-primary transition-colors"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <title>GitHub</title>
                <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
              </svg>
            </a>
            <a
              title="X"
              href="https://x.com/matsubokkuri"
              target="_blank"
              rel="noopener"
              className="w-9 h-9 inline-flex items-center justify-center border border-outline-variant rounded-lg text-on-surface-variant hover:bg-primary hover:text-white hover:border-primary transition-colors"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <title>X</title>
                <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
              </svg>
            </a>
            <a
              title="Email"
              href="mailto:matsubokkuri@gmail.com"
              className="w-9 h-9 inline-flex items-center justify-center border border-outline-variant rounded-lg text-on-surface-variant hover:bg-primary hover:text-white hover:border-primary transition-colors"
            >
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>
                mail
              </span>
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}

