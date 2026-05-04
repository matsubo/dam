import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { ExtensionErrorShield } from '../components/extension-error-shield.tsx';
import { GoogleAnalytics } from '../components/google-analytics.tsx';
import { Gtm, GtmNoscript } from '../components/gtm.tsx';
import { Nav } from '../components/nav.tsx';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Dam Data Platform', template: '%s — Dam Data Platform' },
  description: '日本全国のダム諸元と貯水量の履歴データ。長期トレンドを 1 時間〜月次の粒度で。',
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000'),
  // Google Search Console verification token — set via NEXT_PUBLIC_GSC_VERIFICATION
  // (the value Search Console gives you in the "HTML tag" verification flow).
  // When unset, the meta tag is omitted.
  ...(process.env.NEXT_PUBLIC_GSC_VERIFICATION
    ? { verification: { google: process.env.NEXT_PUBLIC_GSC_VERIFICATION } }
    : {}),
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
        {/* Wallet-extension error shield — installed BEFORE Next dev's
            overlay attaches its own listener, so we get the event first and
            can preventDefault. The React component (ExtensionErrorShield)
            still runs as a defence-in-depth secondary listener. */}
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: tiny inline guard */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){var P=[/window\\.ethereum/,/window\\.solana/,/window\\.tron/,/chrome-extension:\\/\\//,/moz-extension:\\/\\//,/safari-extension:\\/\\//];function noise(m,s){m=String(m||"");s=String(s||"");for(var i=0;i<P.length;i++){if(P[i].test(m)||P[i].test(s))return true;}return false;}window.addEventListener("error",function(e){if(noise(e.message,e.filename)){e.preventDefault();e.stopImmediatePropagation();}},true);window.addEventListener("unhandledrejection",function(e){var r=e.reason||{};if(noise(r.message,r.stack)){e.preventDefault();e.stopImmediatePropagation();}},true);})();`,
          }}
        />
      </head>
      <body>
        <Gtm />
        <GtmNoscript />
        <GoogleAnalytics />
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
              国土交通省・国土数値情報・ダム便覧の公開データをもとに、全国 2,749
              基のダムの諸元と貯水量履歴を集約・配信するサービス。
              研究・防災・教育・商用、いずれの用途にも無償でご利用いただけます。
              なお、観測値のリアルタイム提供は行っていません — 各時点の値は
              一次情報源 (川の防災情報など) を併用してください。
            </p>
            <div className="flex flex-wrap gap-2 text-xs">
              <span className="px-2 py-1 rounded-full bg-white border border-outline-variant text-on-surface-variant">
                Open Data
              </span>
              <span className="px-2 py-1 rounded-full bg-white border border-outline-variant text-on-surface-variant">
                無料 API
              </span>
              <span className="px-2 py-1 rounded-full bg-white border border-outline-variant text-on-surface-variant">
                履歴データ
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
            <div className="eyebrow-muted mb-4">アカウント</div>
            <ul className="space-y-2 text-sm">
              <li>
                <a className="text-on-surface-variant hover:text-primary transition-colors" href="/account/keys">
                  API キー管理
                </a>
              </li>
              <li>
                <a className="text-on-surface-variant hover:text-primary transition-colors" href="/account/sign-in">
                  サインイン
                </a>
              </li>
            </ul>

            <div className="eyebrow-muted mt-6 mb-4">運営</div>
            <ul className="space-y-2 text-sm">
              <li>
                <a className="text-on-surface-variant hover:text-primary transition-colors" href="/legal/terms">
                  利用規約
                </a>
              </li>
              <li>
                <a className="text-on-surface-variant hover:text-primary transition-colors" href="/legal/privacy">
                  プライバシーポリシー
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

        {/* Data attribution band — only sources we actually consume.
            Each entry includes the licence terms we operate under. */}
        <div className="bg-white border border-outline-variant rounded-xl p-5 mb-8">
          <div className="eyebrow-muted mb-3">データ出典 · ライセンス</div>
          <ul className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-2 text-xs text-on-surface-variant">
            <li>
              <span className="font-semibold text-on-surface">国土数値情報</span>{' '}
              ダム諸元 W01・流域界 A21（出典明示で再配布可）
            </li>
            <li>
              <span className="font-semibold text-on-surface">一般財団法人 日本ダム協会</span>{' '}
              ダム便覧（諸元・写真の引用は出典明示。写真の著作権は撮影者に帰属）
            </li>
            <li>
              <span className="font-semibold text-on-surface">国土地理院</span>{' '}
              地理院タイル（出典明示で利用可）
            </li>
            <li>
              <span className="font-semibold text-on-surface">ja.wikipedia.org</span>{' '}
              ダム写真フォールバック（CC BY-SA 4.0、各ページの著作者に従う）
            </li>
          </ul>
          <p className="text-[10px] text-on-surface-variant mt-3">
            写真は外部サーバから配信されており、各画像のライセンスは原典に従います。
            再利用する場合は必ず原典の権利者に従ってください。
          </p>
        </div>

        <div className="pt-6 border-t border-outline-variant flex flex-col md:flex-row items-center justify-between gap-4">
          <p className="text-xs text-on-surface-variant font-display font-medium">
            © {new Date().getFullYear()} Dam Data Japan · Open Reservoir Data ·{' '}
            <span className="text-on-surface-variant/70">v0.1</span>
          </p>
          <div className="flex items-center gap-3">
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

