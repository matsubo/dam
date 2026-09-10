import type { Metadata } from 'next';
import { Breadcrumbs } from '../../../components/breadcrumbs.tsx';

export const metadata: Metadata = {
  title: 'プライバシーポリシー',
  description:
    '本サイトが収集する情報、利用目的、第三者提供、Cookie の取り扱い、利用者の権利についてのポリシー。',
  alternates: { canonical: '/legal/privacy' },
};

// The advertising section appears only on a deploy that actually serves ads,
// so the policy never describes a data flow that isn't happening. Same env var
// that gates the AdSense components and /ads.txt.
const ADS_ENABLED = Boolean(process.env.NEXT_PUBLIC_ADSENSE_CLIENT);

const LAST_UPDATED = ADS_ENABLED ? '2026-09-09' : '2026-05-04';

export default function PrivacyPage() {
  return (
    <article className="max-w-3xl mx-auto px-5 md:px-10 py-10 prose prose-sm">
      <Breadcrumbs items={[{ label: 'ホーム', href: '/' }, { label: 'プライバシーポリシー' }]} />
      <h1 className="text-3xl font-semibold mb-1">プライバシーポリシー</h1>
      <p className="text-xs text-on-surface-variant mb-8">最終更新日: {LAST_UPDATED}</p>

      <Section n="1" title="基本方針">
        <p>
          本サイト「Dam Data Japan」(以下「本サービス」) は、利用者の個人情報の重要性を認識し、
          個人情報の保護に関する法律、関係法令、ガイドラインを遵守し、適切に取扱います。
          本サービスは公益目的の無償サービスとして個人が運営しています。 連絡窓口は{' '}
          <a
            className="text-primary hover:underline"
            href="https://discord.gg/UbWqspWbAk"
            target="_blank"
            rel="noopener noreferrer"
          >
            Discord サーバー
          </a>
          のみで、個別のメールアドレスは公開していません。
        </p>
      </Section>

      <Section n="2" title="収集する情報と利用目的">
        <h3 className="text-sm font-semibold mt-4 mb-1">2.1 アカウント情報 (任意)</h3>
        <p>
          API キー発行のため Google アカウントで認証する利用者については、Google OAuth
          から提供されるメールアドレスと表示名のみを取得し、API
          キー紐付け・本人確認・利用量管理の目的でのみ利用します。パスワード等は
          受領・保管しません。
        </p>
        <h3 className="text-sm font-semibold mt-4 mb-1">2.2 API 利用ログ</h3>
        <p>
          認証付き API リクエストについて、API キー ID・呼び出し時刻・分単位の集計件数を
          レート制限と不正利用検知のために保存します。リクエスト本文や IP
          アドレス本体は保存しません。
        </p>
        <h3 className="text-sm font-semibold mt-4 mb-1">2.3 アクセス解析</h3>
        <p>
          Google Analytics 4 (GA4) および Google Tag Manager を導入する場合があります。これらは
          Cookie によって匿名のセッション識別子を発行し、
          ページ閲覧や滞在時間などの統計情報を収集しますが、個人を特定する情報には用いません。
          オプトアウトは{' '}
          <a
            className="text-primary hover:underline"
            href="https://tools.google.com/dlpage/gaoptout"
            target="_blank"
            rel="noreferrer noopener"
          >
            Google アナリティクス オプトアウト アドオン
          </a>{' '}
          で可能です。
        </p>
        {ADS_ENABLED ? (
          <>
            <h3 className="text-sm font-semibold mt-4 mb-1">2.4 広告配信</h3>
            <p>
              一部のページに Google AdSense による広告を掲載しています。Google
              および配信パートナーは、広告の配信・効果測定・パーソナライズのために Cookie
              や端末識別子を利用する場合があります。パーソナライズ広告の無効化は{' '}
              <a
                className="text-primary hover:underline"
                href="https://adssettings.google.com"
                target="_blank"
                rel="noreferrer noopener"
              >
                広告設定
              </a>{' '}
              から、詳細は{' '}
              <a
                className="text-primary hover:underline"
                href="https://policies.google.com/technologies/partner-sites"
                target="_blank"
                rel="noreferrer noopener"
              >
                Google のポリシーと規約
              </a>{' '}
              をご確認ください。
            </p>
          </>
        ) : null}
        <h3 className="text-sm font-semibold mt-4 mb-1">
          {ADS_ENABLED ? '2.5' : '2.4'} サーバーログ
        </h3>
        <p>
          ホスティング (Coolify / Cloudflare 等)
          のレイヤで標準的なアクセスログ・エラーログが一定期間保持されます。
          これらはサービス可用性確保および技術的トラブル解析のためのみ参照します。
        </p>
      </Section>

      <Section n="3" title="第三者提供">
        <p>
          法令に基づく開示請求がある場合、利用者本人の同意がある場合、
          または合併・事業承継等で事業の一部として承継される場合を除き、
          利用者の情報を第三者に提供することはありません。
        </p>
      </Section>

      <Section n="4" title="情報の保管・削除">
        <p>
          API キーおよび利用ログは、本サービス内の{' '}
          <a className="text-primary hover:underline" href="/account/keys">
            /account/keys
          </a>{' '}
          ページから利用者ご自身でいつでも取消・退会 (完全削除) いただけます。 退会時には API
          キー、利用ログを物理削除します。
        </p>
      </Section>

      <Section n="5" title="Cookie">
        <p>
          認証セッションの維持と前述のアクセス解析のため Cookie を利用します。 ブラウザ設定から
          Cookie を無効化することは可能ですが、その場合一部機能 (サインイン状態の維持等)
          が利用できなくなることがあります。
        </p>
      </Section>

      <Section n="6" title="利用者の権利">
        <p>
          利用者は、自己の情報について開示・訂正・利用停止・削除を請求する権利を有します。
          下記窓口へのご連絡で対応します。
        </p>
      </Section>

      <Section n="7" title="お問い合わせ窓口">
        <p>
          本ポリシーに関するご質問・苦情・各種請求は{' '}
          <a
            className="text-primary hover:underline"
            href="https://discord.gg/UbWqspWbAk"
            target="_blank"
            rel="noopener noreferrer"
          >
            Discord サーバー
          </a>{' '}
          までご連絡ください (個別のメール窓口はありません)。
        </p>
      </Section>

      <Section n="8" title="改定">
        <p>
          本ポリシーの内容は法令の改正、サービス内容の変更等に応じて見直しを行うことがあります。
          重要な変更がある場合は本サイト上で告知します。
        </p>
      </Section>

      <p className="mt-10 text-xs text-on-surface-variant">最終更新日: {LAST_UPDATED}</p>
    </article>
  );
}

function Section({ n, title, children }: { n: string; title: string; children: React.ReactNode }) {
  return (
    <section className="mb-6">
      <h2 className="text-lg font-semibold mb-2">
        {n}. {title}
      </h2>
      <div className="text-sm text-on-surface leading-relaxed space-y-2">{children}</div>
    </section>
  );
}
