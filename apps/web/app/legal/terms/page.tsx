import type { Metadata } from 'next';
import { Breadcrumbs } from '../../../components/breadcrumbs.tsx';
import { REPO_URL } from '../../../lib/contributors.ts';

export const metadata: Metadata = {
  title: '利用規約',
  description:
    '本サイト・公開 API の利用条件、API キー、レート制限、再配布、免責事項に関する規約。',
  alternates: { canonical: '/legal/terms' },
};

const LAST_UPDATED = '2026-05-04';

export default function TermsPage() {
  return (
    <article className="max-w-3xl mx-auto px-5 md:px-10 py-10">
      <Breadcrumbs items={[{ label: 'ホーム', href: '/' }, { label: '利用規約' }]} />
      <h1 className="text-3xl font-semibold mb-1">利用規約</h1>
      <p className="text-xs text-on-surface-variant mb-8">最終更新日: {LAST_UPDATED}</p>

      <Section n="1" title="本規約の適用">
        <p>
          本規約は、本サイト「Dam Data Japan」(以下「本サービス」) およびその提供する API
          を利用するすべての方 (以下「利用者」) に適用されます。本サービスを利用された時点で、
          本規約に同意したものとみなします。
        </p>
      </Section>

      <Section n="2" title="提供データの性質">
        <p>
          本サービスが提供するダム諸元・観測値は、国土数値情報 (国土交通省) ・ ダム便覧
          (一般財団法人日本ダム協会) ・国土地理院・ja.wikipedia.org (写真フォールバック)
          の公開データをもとに、本サービスが集約・正規化したものです。
          観測値のリアルタイム提供は行わず、過去履歴のみを再配信しています。原典の最新性・正確性は保証されず、また、本サービスが行う名寄せ・単位換算
          などの加工を経た値が含まれます。
        </p>
        <p>
          本サービスのデータは、災害判断・人命関係・法的判断等の決定的用途に直接利用しない
          でください。これらの用途には必ず公式情報源を併用してください。
        </p>
      </Section>

      <Section n="3" title="利用条件">
        <ul className="list-disc list-inside space-y-1">
          <li>
            個人・商用を問わず、無償でご利用いただけます。クレジット表示の義務はありませんが、
            データの出典として原典 (国土交通省等) の併記を推奨します。
          </li>
          <li>
            API の利用には Google アカウントによる認証と発行されたキーが必要です。
            キーは利用者本人のみが利用するものとし、第三者への譲渡・共有・公開は禁止します。
          </li>
          <li>
            キー漏洩により発生した過剰呼び出しにつき、本サービスは一方的にキーを失効させる
            ことができ、利用者はそれに同意します。
          </li>
        </ul>
      </Section>

      <Section n="4" title="レート制限">
        <p>
          API は標準で 600 req/min および 100,000 req/day のレート制限を適用します。
          上限を超えた呼び出しは HTTP 429 を返します。継続的に高負荷をかける利用 ( DoS
          的アクセス、超高速ポーリング等) は禁止します。
        </p>
      </Section>

      <Section n="5" title="禁止事項">
        <ul className="list-disc list-inside space-y-1">
          <li>本サービスの動作を妨害し、または第三者の利用を阻害する行為</li>
          <li>本サービスを再配布する形態で利用者に有償提供すること (API のラッパー販売を含む)</li>
          <li>取得データを第三者の権利を侵害する目的で利用すること</li>
          <li>
            原典のライセンス条件を逸脱する形での再配布。原典 (Wikipedia 等)
            のライセンスに従ってください。
          </li>
          <li>本サービスを利用した違法行為、公序良俗に反する行為</li>
        </ul>
      </Section>

      <Section n="6" title="知的財産・ライセンス">
        <p>
          本サービスのコードは{' '}
          <a className="text-primary hover:underline" href={REPO_URL}>
            GitHub
          </a>{' '}
          で PolyForm Shield License 1.0.0
          のもとソースコード公開しています。本サービスと競合する製品・サービスの提供には利用できません。データソース部分のライセンスは原典のライセンスに従います
          (国土数値情報: 政府標準利用規約 2.0 互換、Wikipedia: CC-BY-SA、ほか)。 本サービスの UI
          上の写真は{' '}
          <a className="text-primary hover:underline" href="/sources">
            データソースページ
          </a>{' '}
          に記載の各原典権利者に帰属します。
        </p>
      </Section>

      <Section n="7" title="サービスの変更・停止">
        <p>
          本サービスは予告なく仕様変更、メンテナンス、あるいは恒久的な停止を行うことが
          あります。これにより利用者に生じた損害について、本サービスは責任を負いません。
        </p>
      </Section>

      <Section n="8" title="免責">
        <p>
          本サービスは、提供されるデータの正確性・最新性・完全性を一切保証しません。
          本サービスの利用または利用不能から生じる直接・間接の損害について、
          適用される法令で許容される最大限の範囲で本サービスは一切の責任を負いません。
        </p>
      </Section>

      <Section n="9" title="準拠法・管轄">
        <p>
          本規約は日本法に準拠して解釈され、本サービスの利用に関連する一切の紛争については、
          東京地方裁判所を第一審の専属的合意管轄裁判所とします。
        </p>
      </Section>

      <Section n="10" title="改定">
        <p>
          本規約は必要に応じて改定することがあります。重要な改定は本サイト上で告知します。
          改定後にサービスを継続利用された場合、新規約に同意したものとみなします。
        </p>
      </Section>

      <Section n="11" title="お問い合わせ">
        <p>
          本規約に関するお問い合わせは{' '}
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
