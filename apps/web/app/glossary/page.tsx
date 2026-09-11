import type { Metadata } from 'next';
import { Breadcrumbs } from '../../components/breadcrumbs.tsx';
import { EntityIcon } from '../../components/entity-icon.tsx';

export const revalidate = 86400;
export const metadata: Metadata = {
  title: '用語集',
  description:
    'Dam Data Platform で使われる用語の定義。ダム・水系・河川・貯水量・有効貯水容量・利水容量・貯水率・観測レコードなど、サイト上での意味と計算方法を明示します。',
  alternates: { canonical: '/glossary' },
};

interface Term {
  id: string;
  term: string;
  reading?: string;
  body: string;
  also?: string;
}

const SECTIONS: { title: string; terms: Term[] }[] = [
  {
    title: '基本エンティティ',
    terms: [
      {
        id: 'dam',
        term: 'ダム',
        reading: 'dam',
        body: '河川を堰き止めて水を貯めるための構造物。本サイトでは国土交通省「ダム便覧」に登録された、堤高 15 m 以上の貯水・治水・利水ダムを対象とする。当サイトには 2,749 基のマスタを収録。',
      },
      {
        id: 'watershed',
        term: '水系',
        reading: 'すいけい',
        body: '一つの河川とそれに接続する支川群、湖沼などを一体としてとらえた集水域。河川法に基づき「一級水系」「二級水系」が指定される。本サイトでは国土数値情報 W07 を一次ソースとし、644 水系を収録。',
        also: '一級水系 / 二級水系 / その他',
      },
      {
        id: 'first-class-watershed',
        term: '一級水系',
        reading: 'いっきゅうすいけい',
        body: '国土交通大臣が指定し、国が直接管理する 109 水系。利根川・淀川など、流域面積や経済影響が特に大きい水系。',
      },
      {
        id: 'second-class-watershed',
        term: '二級水系',
        reading: 'にきゅうすいけい',
        body: '都道府県知事が指定・管理する水系。一級水系より小規模だが、地域の重要な水資源。',
      },
      {
        id: 'river',
        term: '河川',
        reading: 'かせん',
        body: '水系を構成する個々の川。本流・支川など。水系がツリーの根、河川がそのノードに対応する。',
      },
      {
        id: 'manager',
        term: '管理者',
        reading: 'かんりしゃ',
        body: 'ダムを管理する主体。国土交通省、独立行政法人水資源機構、都道府県、電力会社、市町村などが該当する。',
      },
    ],
  },
  {
    title: '容量・貯水関連',
    terms: [
      {
        id: 'total-capacity',
        term: '総貯水容量',
        reading: 'そうちょすいようりょう',
        body: 'ダム湛水面の最高水位（サーチャージ水位）まで貯められる容量の合計。死水容量・利水容量・洪水調節容量を含む、ダムの「物理的な最大容積」。単位は m³。',
      },
      {
        id: 'effective-capacity',
        term: '有効貯水容量',
        reading: 'ゆうこうちょすいようりょう',
        body: '総貯水容量から死水容量を除いた、実際に使える容量。利水容量と洪水調節容量を合わせた量にあたる。ダム便覧が公表するのはこの値までで、本サイトが諸元として持つ容量（active_capacity_m3 / API の activeCapacityM3）もこれ。貯水率の分母は原則この値。',
        also: '英: effective capacity',
      },
      {
        id: 'active-capacity',
        term: '利水容量',
        reading: 'りすいようりょう',
        body: '有効貯水容量のうち、水道・かんがい・発電などに充てられる部分。洪水期は洪水調節容量を確保するため小さくなる。ダム便覧はこの値を公表していないため、本サイトが諸元として持っているのは有効貯水容量であり、利水容量は一部の出典（川の防災情報・県の防災サイトなど）が公表する貯水率から逆算した場合にだけ分かる。',
        also: '英: active capacity / conservation storage',
      },
      {
        id: 'flood-control-capacity',
        term: '洪水調節容量',
        reading: 'こうずいちょうせつようりょう',
        body: '洪水時に下流の被害を抑えるため、空けておくべき容量。有効貯水容量のうち利水容量ではない部分にあたり、洪水期に大きく取られる。',
      },
      {
        id: 'dead-storage',
        term: '死水容量',
        reading: 'しすいようりょう',
        body: '取水口より下にあり、通常は使えない容量。堆砂や水位低下時の保全に充てられる。',
      },
      {
        id: 'storage-volume',
        term: '貯水量',
        reading: 'ちょすいりょう',
        body: 'ある時点でダムに実際に貯まっている水の量（容積）。単位 m³。観測値カラム名は storage_volume_m3。',
        also: 'storage_volume_m3 / 貯水容積',
      },
      {
        id: 'storage-rate',
        term: '貯水率',
        reading: 'ちょすいりつ',
        body: '本サイトでは「現在の貯水量 ÷ その時点で有効な容量」で計算する。分母は原則としてダム便覧の有効貯水容量だが、出典自身が季節を反映した利水容量貯水率を公表しているダムでは、その率が示す分母（洪水期の利水容量）を用いる。容量が登録されていないダムでは — と表示。100 % を超えた場合は表示上 100 % にクリップする。',
        also: 'rate = storage_volume_m3 / 有効な容量（既定は active_capacity_m3）',
      },
      {
        id: 'national-rate',
        term: '全国貯水率',
        reading: 'ぜんこくちょすいりつ',
        body: '容量が分かる全国のダム合計について、現在貯水量の合計を各ダムの分母の合計で割った値。「容量の登録があるダム × 直近 7 日以内の観測値」の組のみで集計する。',
      },
      {
        id: 'inflow-outflow',
        term: '流入量・放流量',
        reading: 'りゅうにゅうりょう・ほうりゅうりょう',
        body: '流入量 (inflow_m3s) はダムに流入する瞬間流量、放流量 (outflow_m3s) はダムから下流へ放流する瞬間流量。単位は m³/s。',
      },
      {
        id: 'water-level',
        term: '貯水位',
        reading: 'ちょすいい',
        body: 'ダムに貯まった水の標高。常時満水位 / 制限水位 / 死水位 などの基準位と組み合わせて運用される。観測値カラム water_level_m、単位は m。',
      },
      {
        id: 'rainfall',
        term: '流域雨量',
        reading: 'りゅういきうりょう',
        body: 'ダム上流域での降水量。観測値カラム rainfall_mm、単位は mm（観測時刻からの 1 時間積算など、ソースに依存）。',
      },
    ],
  },
  {
    title: '時系列・観測関連',
    terms: [
      {
        id: 'observation',
        term: '観測値',
        reading: 'かんそくち',
        body: '`(dam_id, observed_at, source_id)` で識別される時系列の 1 ポイント。貯水量・貯水位・流入量・放流量・雨量などの値、および品質フラグを併せ持つ。',
      },
      {
        id: 'observation-record',
        term: '観測レコード',
        reading: 'かんそくレコード',
        body: 'observations テーブルの 1 行。観測値そのもの。トップページや /stats のカウンタ「観測レコード」はこの行数を指す。TimescaleDB の approximate_row_count() を使った推定値で、誤差は概ね ±1 %。',
      },
      {
        id: 'observed-at',
        term: '観測時刻',
        reading: 'かんそくじこく',
        body: 'データの観測タイムスタンプ。サイト上の表示は常に JST（Asia/Tokyo）で、末尾に「JST」を付記する。DB には UTC で保存されている。',
      },
      {
        id: 'grain',
        term: '粒度',
        reading: 'りゅうど',
        body: 'API・チャートで提供する 3 解像度。hourly（1 時間）、daily（1 日）、monthly（1 ヶ月）。daily / monthly は TimescaleDB の連続集計（continuous aggregate）から返す。',
      },
      {
        id: 'quality-flag',
        term: 'quality_flag',
        body: '観測値の品質を示す数値フラグ。0=正常、>0=何らかの懸念（欠測補完済み、外れ値疑いなど）。フラグ体系はベータ段階で確定予定。',
      },
      {
        id: 'source-id',
        term: 'source_id',
        body: '観測値の出所（川の防災情報・各県の防災情報システム・水文水質データベース など）。同じダムで同じ時刻に複数ソースが存在する場合、source_priorities テーブルで優先順を決める。',
      },
    ],
  },
  {
    title: 'サイト独自の概念',
    terms: [
      {
        id: 'name-matching',
        term: '名寄せ',
        reading: 'なよせ',
        body: '異なるソース（国土数値情報・ダム便覧・川の防災情報など）に登場する同一ダムを 1 件の dam レコードに紐付ける作業。external_ids JSONB カラムに各ソースの ID を保持する（例: external_ids = {"ndi":"1234","damnet":"567"}）。詳細と具体例は /sources を参照。',
      },
      {
        id: 'rateable',
        term: 'rate-able dam',
        body: '有効貯水容量 (active_capacity_m3) が登録されているダム。貯水率の集計対象になる。本サイトでは現在 2,388 基（全 2,749 基中）。',
      },
      {
        id: 'storage-change-strip',
        term: '貯水量の変化（ストリップ）',
        body: 'ホームページとダム詳細ページに表示する 8 つの時間窓（1h / 6h / 12h / 1d / 7d / 30d / 1y / 5y）の貯水量変化率。基準点（anchor）= 直近の観測時刻。各バケット = 「anchor − N」時点の観測との差分。',
      },
      {
        id: 'lifecycle',
        term: 'ライフサイクル段階',
        body: 'アルファ → ベータ → 正式リリース（GA）。現在のステージは /roadmap 参照。フッターのバージョンバッジに常時表示される。',
      },
      {
        id: 'app-version',
        term: 'バージョン番号',
        body: 'サイトと API の semver。0.x.y はアルファ、0.next.* がベータ予定、≥1.0.0 で GA。フッターおよび OpenAPI info.version に同じ値が出る（lib/version.ts が単一ソース）。',
      },
    ],
  },
];

export default function GlossaryPage() {
  return (
    <div className="max-w-3xl mx-auto px-5 md:px-10 py-8">
      <Breadcrumbs items={[{ label: 'ホーム', href: '/' }, { label: '用語集' }]} />
      <h1 className="text-2xl font-semibold mb-2">用語集</h1>
      <p className="text-sm text-on-surface-variant mb-6">
        本サイトで使う用語の定義。一般用語の意味に加え、サイト独自の計算方法・カラム名も併記する。
        各項目はアンカーリンクで参照可能（例:{' '}
        <a href="#storage-rate" className="text-primary hover:underline">
          /glossary#storage-rate
        </a>
        ）。
      </p>

      <nav className="mb-8 grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
        {SECTIONS.map((s) => (
          <a
            key={s.title}
            href={`#section-${SECTIONS.indexOf(s)}`}
            className="text-on-surface-variant hover:text-primary"
          >
            {s.title}
          </a>
        ))}
      </nav>

      {SECTIONS.map((section, idx) => (
        <section key={section.title} className="mb-10" id={`section-${idx}`}>
          <h2 className="text-lg font-semibold mb-4 inline-flex items-center gap-2">
            {section.title === '基本エンティティ' ? (
              <EntityIcon kind="dam" size={18} className="text-primary shrink-0" />
            ) : null}
            <span>{section.title}</span>
          </h2>
          <dl className="space-y-5">
            {section.terms.map((t) => (
              <div
                key={t.id}
                id={t.id}
                className="border-l-4 border-outline-variant pl-4 scroll-mt-20"
              >
                <dt className="font-display font-semibold text-on-surface inline-flex items-baseline gap-2 flex-wrap">
                  <span>{t.term}</span>
                  {t.reading ? (
                    <span className="text-xs text-on-surface-variant">（{t.reading}）</span>
                  ) : null}
                  <a
                    href={`#${t.id}`}
                    className="text-xs text-on-surface-variant/70 hover:text-primary"
                    aria-label={`${t.term}へのリンク`}
                  >
                    #
                  </a>
                </dt>
                <dd className="text-sm text-on-surface-variant mt-1 leading-relaxed">
                  {t.body}
                  {t.also ? (
                    <span className="block mt-1 text-xs text-on-surface-variant/80">
                      関連: {t.also}
                    </span>
                  ) : null}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}

      <p className="mt-12 text-xs text-on-surface-variant">
        定義の不明点・追加要望は{' '}
        <a
          href="https://discord.gg/UbWqspWbAk"
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary hover:underline"
        >
          Discord
        </a>{' '}
        まで。データソースの詳細は{' '}
        <a href="/sources" className="text-primary hover:underline">
          /sources
        </a>
        、ロードマップは{' '}
        <a href="/roadmap" className="text-primary hover:underline">
          /roadmap
        </a>
        。
      </p>
    </div>
  );
}
