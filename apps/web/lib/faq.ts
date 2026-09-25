// Questions and answers for /faq (issue #61). Plain text so the same entries
// feed both the page and its FAQPage JSON-LD.

export interface FaqEntry {
  id: string;
  question: string;
  answer: string[];
  links?: { href: string; label: string }[];
}

export const FAQ: FaqEntry[] = [
  {
    id: 'rate-origin',
    question: '表示されている貯水率は公式の発表値ですか？',
    answer: [
      '出典によります。国・県・水資源機構などが公表している貯水率を、そのままの基準（多くは利水容量に対する割合）で使えると確認できた出典（信頼ソース）については、その公表値を表示しています。',
      'それ以外の出典、または出典が貯水率を公表していない場合は、出典の貯水量をダム便覧の有効貯水容量で割った当サイトの計算値です。ダムページではこの場合「当サイトが算出した値です」と注記し、API では latest.storageRateOrigin が "computed" になります。',
      '計算値は、洪水期に制限水位を下げて運用するダムでは公式の利水容量貯水率より低く出ることがあります。',
    ],
    links: [{ href: '/glossary#storage-rate', label: '用語集: 貯水率' }],
  },
  {
    id: 'source-choice',
    question: '同じダムを複数の出典が配信しているとき、どれを表示していますか？',
    answer: [
      '最新観測値は、直近 24 時間以内に信頼ソースが自前の貯水率を配信していればそれを優先し、なければ最も新しい観測値を表示します。',
      '推移グラフ（1 時間値）は、ダムごとに 1 つの出典に絞って描画します。貯水量を配信している出典を先に、そのうえで出典ごとの優先度（priority）が高いものを選びます。優先度の一覧はデータソースのページにあります。',
    ],
    links: [{ href: '/sources', label: 'データソースと優先度' }],
  },
  {
    id: 'denominator',
    question: '貯水率の分母には何を使っていますか？',
    answer: [
      '信頼ソースの場合は、その出典の貯水率から逆算した容量（貯水量 ÷ 貯水率）です。季節ごとの運用容量が反映されるため、洪水期は諸元の容量より小さくなることがあります。',
      'それ以外は、ダム便覧の有効貯水容量です。ダム便覧は利水容量を公表していないため、利水容量ではありません。',
    ],
    links: [{ href: '/glossary#active-capacity', label: '用語集: 有効貯水容量・利水容量' }],
  },
  {
    id: 'redevelopment',
    question: '同じダムが「（元）」と「（再）」の 2 つ表示されるのはなぜですか？',
    answer: [
      '再開発（かさ上げなど）されたダムは、国土数値情報とダム便覧のどちらも、改良前を「（元）」、改良後を「（再）」として別々に登録しています。当サイトもそれに合わせて 2 件として扱い、諸元はそれぞれの登録内容を表示します。',
    ],
  },
  {
    id: 'missing-rate',
    question: '貯水率が表示されないダムがあるのはなぜですか？',
    answer: [
      '出典が貯水量を配信していない（水位のみの）場合や、有効貯水容量が不明な場合は、貯水率を計算できないため表示しません。また、公開されたリアルタイムの配信元が見つかっていないダムもあります。',
    ],
    links: [{ href: '/coverage', label: 'カバレッジ' }],
  },
];
