// Editorial metadata about each registered data source. Lives outside the
// DB because it's content (license blurbs, upstream URLs) rather than
// behaviour — and the DB row only stores priority + active flag.
//
// Used by:
//   - /sources page (table)
//   - /sources/[id] page (detail)
//   - components/source-badge.tsx (label / link target)

export interface SourceDetail {
  /** Human-readable upstream source name + URL hint. */
  upstream: string;
  license: string;
  cadence: string;
  what: string;
  /** Friendly short label for badge / link text (defaults to source_id). */
  label?: string;
}

// jwa-chubu, jwa-kiso-rt and jwa-toyokawa all read pages of the 中部支社
// リアルタイム情報 system (water.go.jp/mizu/chubu/), whose note asks users not to
// collect with tools. They are kept because the organisation-wide rule puts
// numeric data outside copyright; each entry adds how its fetch rate is kept
// low. Quotes verified against both documents on 2026-09-28.
const JWA_CHUBU_TERMS =
  '水資源機構「著作権・リンク等について」(water.go.jp/honsya/honsya/policy/copyright/): 「数値データ、簡単な表・グラフ等は著作権の対象ではありませんので、これらについては本利用ルールの適用はなく、自由に利用できます。」 中部支社 リアルタイム情報「ご利用上の注意事項」(water.go.jp/mizu/chubu/res/description/description.pdf): 「ツール等による、自動的なデータ収集等はサーバに負荷がかかり、情報提供できなくなる恐れがありますのでご遠慮頂くよう、ご理解・ご協力をお願いいたします。」「このサイトを営利目的に利用することはできません。私的使用又は引用等の著作権法上認められた行為を除き、機構に無断で転載、複製、出版、放送、上映等を行うことはできません。」 本サイトは観測値 (数値データ) のみを出典明示のうえ保持し、ページの文章・図表は複製しない。';

export const SOURCE_DETAILS: Record<string, SourceDetail> = {
  ndi: {
    upstream: '国土交通省 国土数値情報 (W01: ダム, W05: 河川, W07: 流域メッシュ)',
    license:
      'W01 / W05 / W07 はいずれも「非商用」(旧国土情報利用約款準拠版; W01 は有償刊行物を原典とするため商用利用不可): 出典・加工者を明示のうえ非商用目的で利用し、複製物は再配布しない。本サイトはこれらを加工して作成したダム属性・水系の区分 (一級/二級)・流域界を保持。',
    cadence: '年次 (毎年初旬に最新版へ差し替え)',
    what: 'マスタデータの土台。位置 (緯度経度), 都道府県, 河川, 流域, 総貯水容量, 堤高, 竣工年。水系の一級/二級区分 (W05 区間種別 + 水系域コード)。',
    label: '国土数値情報',
  },
  damnet: {
    upstream: '一般財団法人日本ダム協会「ダム便覧」 (dambinran.damnet.or.jp)',
    license:
      'サイト表記は「『ダム便覧』内の文章、画像、データなどすべての内容の無断転載を禁じます」。出典明示による一括再利用を認める記載は確認できず、諸元は同協会の有償刊行物「ダム年鑑」由来。写真は 2026-09-10 に利用停止 (media-policy が写真ごとの使用条件または個別問い合わせを求めており、著作権も撮影者に帰属するため)。',
    cadence: '月 1 回 (master:refresh:damnet cron / 毎月 5 日 03:00 UTC)',
    what: '総貯水容量・有効貯水容量, 目的, 型式, 堤頂長, 流域面積, 湛水面積, 着工年, 事業者, 施工者, ダム湖名。利水容量は公表されていない。',
    label: 'ダム便覧',
  },
  wikipedia: {
    upstream: 'ja.wikipedia.org REST API (pageimages prop)',
    license: 'CC-BY-SA 4.0 (各ページの著作者に従う)',
    cadence: '月 1 回 (images:refresh:wikipedia cron / 毎月 2 日 05:00 UTC)',
    what: 'Damnet に写真がない場合のフォールバック。記事サムネイル URL のみ。',
    label: 'Wikipedia',
  },
  gsi: {
    upstream: '国土地理院 標高 API (cyberjapandata.gsi.go.jp/general/dem)',
    license: '出典明示で利用可',
    cadence: '月 1 回 (master:refresh:elevation cron)',
    what: '地点標高 (DEM10B / 5A 統合)。緯度経度から数 m 精度で取得。',
    label: 'GSI',
  },
  'tokyo-waterworks': {
    upstream: '東京都水道局 水源情報 (waterworks.metro.tokyo.lg.jp/suigen/suigen.html)',
    license: '東京都オープンデータ (出典明示で再配布可)',
    cadence: '日次 (毎日 12:00 / 18:00 JST に取得)',
    what: '東京都の水源 15 ダム (利根川・荒川・多摩川 水系) の貯水量 (万m³) と貯水率 (%)。前日からの増減量。',
    label: '東京都水道局',
  },
  'jwa-junpo': {
    upstream: '水資源機構 旬報 (water.go.jp/honsya/honsya/suigen/junpo/index.html)',
    license: '統計法に基づく公的統計 (出典明示で再配布可)',
    cadence: '10 日毎 (毎月 1 / 11 / 21 日 JST 公表; 取得は日次でポーリング)',
    what: '水資源機構が管理する全国 26 ダムの利水容量・貯水量 (千m³)・貯水率 (現在 / 平年 / 平年比)。',
    label: '水資源機構 旬報',
  },
  'fukushima-nourin': {
    upstream:
      '福島県 農林水産部 農地管理課「県内の主要農業関係ダムの貯水状況」 (pref.fukushima.lg.jp/sec/36045d/noutikannri010.html)',
    license: '公開情報 — 出典明示で再配布可',
    cadence: '隔週程度 (調査日 (令和N年M月D日現在) ベース; 取得は日次でポーリング)',
    what: '福島県内の農業関係ダム 29 基の貯水率 (かんがい用水分) と平年比。県土木部の河川ダムには載らない土地改良区・市町村管理の農業用ダム / 調整池 / 溜池が対象。貯水量・水位は非公開。',
    label: '福島県 農業関係ダム',
  },
  'miyagi-nousei': {
    upstream:
      '宮城県 農政部 農村振興課「農業用水の状況」 (pref.miyagi.jp/soshiki/nosonshin/yousui.html → 各回の PDF)',
    license:
      'サイト表記は「『私的使用のための複製』や『引用』など著作権法上認められた場合を除き、無断で複製・転用することはできません」。本サイトは観測値 (事実データ) のみを出典明示のうえ掲載。',
    cadence:
      'かんがい期は毎月 1 日・15 日、それ以外は月 1 回 (調査日 午前9時 ベース; 取得は日次でポーリング)',
    what: '宮城県内の主要ダム 17 基の利水容量・貯水量・貯水率・貯水位・流入量・放流量と、主要ため池 9 か所の満水貯水量・貯水量・貯水率。岩堂沢・二ツ石・菅生・宿の沢・村田と牛野・愛子・嘉太神・川原子・孫沢溜池は他のフィードに載らない。',
    label: '宮城県 農業用水の状況',
  },
  'kagawa-tameike': {
    upstream:
      '香川県 水資源対策課「かがわの水」降雨及び貯水率の状況 (pref.kagawa.lg.jp/mizusigen/mizu/kfvn.html → chosuiYYYYMMDD.pdf)',
    license:
      'サイト表記は「私的使用または引用など著作権法上認められた行為として、適宜の方法により出所を明示することにより、引用・転載複製を行うことができます」(無断改変は不可)。',
    cadence:
      'PDF は開庁日毎、ため池貯水率は月 2 回程度の調査日 (M月D日現在) ベース (取得は日次でポーリング)',
    what: '香川県の主要ため池 26 か所 (満濃池・公渕池・神内池・仁池・豊稔池 ほか) の貯水率 (整数 %)。貯水量・水位は非公開。同 PDF の県内ダム欄は kagawa-bousai が毎時で持つため取り込まない。',
    label: '香川県 主要ため池',
  },
  'sado-nourin': {
    upstream:
      '新潟県 佐渡地域振興局 農林水産振興部「【佐渡】農業用ダムの貯水量情報」 (pref.niigata.lg.jp/site/sado-nourinsuisan-nouson/122000000.html → ダム別ページ)',
    license:
      'サイト表記は「『私的使用』または『引用』など著作権法上認められた行為として適切な方法で利用する場合を除き、新潟県に無断で転載、複製…をすることはできません」。本サイトは観測値 (事実データ) のみを出典明示のうえ掲載。',
    cadence:
      'かんがい期に月 1〜2 回程度 (調査日 (令和N年M月D日時点) ベース; 取得は日次でポーリング)',
    what: '佐渡の県営農業用ダム 7 基 (羽茂・竹田川・小倉川・藤津川・新穂・新穂第2・佐和田) の貯水量と貯水率 (各ページの有効貯水量に対する整数 %)。',
    label: '佐渡 農業用ダム',
  },
  aitoyo: {
    upstream: 'あいとよネット 公益財団法人 愛知・豊川用水振興協会 (aitoyo.or.jp)',
    license: '公益財団法人発行 — 出典明示で再配布可',
    cadence: '日次 (木曽川/豊川は 24:00 JST 値, 矢作川は 09:00 JST 値; 取得は 11:00 JST)',
    what: '木曽川 4 ダム (牧尾/阿木川/味噌川/岩屋), 豊川 1 ダム (宇連), 矢作川 2 ダム (矢作/羽布) の 利水容量・貯水量・貯水率・前日差・平年貯水率。',
    label: 'あいとよネット',
  },
  'jwa-chikugo': {
    upstream: '水資源機構 筑後川ダム統合管理事務所 (water.go.jp/chikugo/chikugo/water-source.html)',
    license: '公的統計 — 出典明示で再配布可',
    cadence: '日次 (毎日 0:00 JST 値; 取得は 10:00 JST)',
    what: '筑後川水系 7 ダム (松原/下筌/大山/合所/江川/寺内/小石原川) の貯水率・貯水量。',
    label: 'JWA 筑後川',
  },
  'jwa-chikugo-rt': {
    upstream:
      '水資源機構 筑後川局 水管理情報WEB (chikugo.ec-net.jp/chikugo/kyoku/pc/new/rep{EG,TR,KB,OY,CO}_I60.html)',
    license:
      '水資源機構 利用ルール — 出典を記載すれば複製・公衆送信・翻案・商用利用可; 数値データは著作権の対象外 (water.go.jp/honsya/honsya/policy/copyright/)',
    cadence: '時次 (毎正時値, ~37 分に更新; 取得は毎時 :50, 直近 24 時間分を毎回 UPSERT)',
    what: '筑後川水系 5 施設 (江川/寺内/小石原川/大山ダム, 筑後大堰) の貯水位・有効貯水量・貯水率 (利水等の貯水容量比)・流入量・総放流量・時間雨量。筑後大堰は貯水位・有効貯水量のみで新規カバレッジ; 各ダムは jwa-chikugo (日次 0 時) を時次に格上げ。',
    label: 'JWA 筑後川 時次',
  },
  'jwa-fukudou': {
    upstream: '水資源機構 筑後川局 福岡導水管理室 (water.go.jp/chikugo/fukudou/html/info02.html)',
    license:
      '水資源機構 利用ルール — 出典を記載すれば複製・公衆送信・翻案・商用利用可; 数値データは著作権の対象外 (water.go.jp/honsya/honsya/policy/copyright/)',
    cadence: '日次 (平日 ~04:30 JST に当日 0 時値を掲載; 取得は毎時 :54)',
    what: '山口調整池 (天拝湖, 福岡導水) の貯水位 (EL.m) と総貯水量。総貯水量から堆砂容量 (総 − 有効) を差し引いた有効分を保存; 公表貯水率は総貯水容量比のため保存しない。他ソースなしの新規カバレッジ。',
    label: 'JWA 福岡導水',
  },
  'jwa-toneara': {
    upstream: '水資源機構 関東支社 (water.go.jp/honsya/honsya/suigen/sokuhou/toneara/index.html)',
    license: '公的統計 — 出典明示で再配布可',
    cadence: '日次 (毎日 0:00 JST 値; 取得は毎時 :39)',
    what: '利根川水系 9 施設 (矢木沢/奈良俣/藤原/相俣/薗原/八ッ場/下久保/草木/渡良瀬貯水池) と荒川水系 4 施設 (二瀬/滝沢/浦山/荒川貯水池) の貯水量(万m³)・貯水率。藤原/相俣/薗原/八ッ場/二瀬は新規カバレッジ。',
    label: 'JWA 利根川/荒川',
  },
  'jwa-tonekako': {
    upstream:
      '水資源機構 利根川河口堰管理所 利根河口堰 情報提供 (tonekako.sakura.ne.jp — water.go.jp/honsya/honsya/suigen/realtime/ からリンク)',
    license:
      '水資源機構ウェブサイト利用ルール — 「数値データ、簡単な表・グラフ等は著作権の対象ではありません…自由に利用できます」(出典: 独立行政法人水資源機構)',
    cadence: '時次 (正時値・直近 24 時間; 取得は毎時 :30、24 時間分を毎回 upsert)',
    what: '利根川河口堰 (茨城/千葉境) の堰上流水位 (新宿 19.0km, Y.P.m)・堰流入量・堰通過流量 (ゲート全開時は ** = 欠測扱い)。貯水量・貯水率は公表なし。他に実時間データのない施設。',
    label: 'JWA 利根川河口堰',
  },
  'jwa-toyokawa': {
    upstream: '水資源機構 中部支社 豊川水系 (water.go.jp/mizu/chubu/realtime/index_2.html)',
    license: `${JWA_CHUBU_TERMS} 取得は 1 回 1 ページ、毎時 1 回に抑えている。`,
    cadence: '時次 (元データは ~10 分粒度; 取得は毎時 :43)',
    what: '豊川水系 2 ダム (宇連/大島) の貯水位(EL.m)・有効貯水量(10³m³→m³)・流入量。ページの放流量は放流量（利水）のみで全放流量ではないため保存しない。リアルタイム観測; jwa-junpo (10 日) / aitoyo (日次) より高頻度。',
    label: 'JWA 豊川',
  },
  'jwa-yoshino': {
    upstream:
      '水資源機構 吉野川上流総合管理所 (water.go.jp/mizu/ikeda/mizuinfo/dyn/html/p0001/60/p000101.html)',
    license: '公的統計 — 出典明示で再配布可',
    cadence: '時次 (元データは 5 分粒度で自動更新; 取得は毎時 :45)',
    what: '吉野川水系 5 ダム (池田/早明浦/新宮/富郷/柳瀬) の貯水位(EL.m)・流入量・全放流量。早明浦ダムのみ利水貯水率[速報値]も提供 (四国の水不足予測の主要指標)。jwa-junpo (10 日) より高頻度で水位も追加。',
    label: 'JWA 吉野川',
  },
  'jwa-aichi-yosui': {
    upstream:
      '水資源機構 愛知用水総合管理所 水情報 (water.go.jp/chubu/aityosui/b(jyouhou-main)/02(mizu)/00(top)/b-02.html)',
    license:
      '愛知用水総合管理所 サイトポリシー「著作権について」: 「当サイトの内容について、私的使用または引用等、著作権法上認めらた行為を除き、当方に無断で転載等を行うことはできません。また、引用を行う際は適宜の方法により、必ず出所を明示してください。」 水資源機構「著作権・リンク等について」(water.go.jp/honsya/honsya/policy/copyright/): 「数値データ、簡単な表・グラフ等は著作権の対象ではありませんので、これらについては本利用ルールの適用はなく、自由に利用できます。」 本サイトは観測値 (数値データ) のみを出所明示のうえ保持。',
    cadence:
      '日次 (貯水位・貯水量・貯水率は 0 時 JST 値, 元ページは 10 時頃更新; 取得は 11:20 / 14:20 JST)',
    what: '愛知用水の東郷調整池 (愛知池)・前山池 と水源の牧尾ダムの貯水位・貯水量(千m³→m³)・貯水率 (有効貯水量比)。牧尾の流入量・放流量は前日の日平均値のため取り込まない。東郷調整池・前山は他に公開ソースのない新規カバレッジ。',
    label: 'JWA 愛知用水',
  },
  'jwa-chubu': {
    upstream: '水資源機構 中部支社 (water.go.jp/mizu/chubu/report/)',
    license: `${JWA_CHUBU_TERMS} 報告は平日 1 回の掲載のため、取得は平日 3 回 (1 回 1 ページ) に抑えている。`,
    cadence:
      '平日日次 (当日 0 時値, 平日 09:40〜11:40 JST 頃掲載; 取得は平日 10:41 / 12:41 / 15:41 JST)',
    what: '木曽川水系 5 ダム (牧尾/阿木川/味噌川/岩屋/徳山) と三重用水 中里ダム (三重県いなべ市) の 0時の貯水位(EL.m)・貯水量(千m³)・貯水率(利水容量比)・前日平均の流入量・放流量。中里ダムは新規カバレッジ; 他 5 ダムは jwa-junpo より日次で詳細なデータを提供。',
    label: 'JWA 中部支社',
  },
  'jwa-kiso-rt': {
    upstream: '水資源機構 中部支社 木曽川水系 実時計 (water.go.jp/mizu/chubu/realtime/index.html)',
    license: `${JWA_CHUBU_TERMS} 取得は 1 回 1 ページ、毎時 1 回に抑えている。`,
    cadence: '時次 (元データは ~10 分粒度; 取得は毎時 :47)',
    what: '木曽川水系 5 dams (牧尾/味噌川/阿木川/岩屋/徳山) と三重用水 中里貯水池 の貯水位(EL.m)・有効貯水量(千m³→m³)・流入量・放流量。jwa-chubu (日次, 優先度 296) を時次に格上げ。',
    label: 'JWA 木曽川 実時計',
  },
  'jwa-biwako': {
    upstream: '水資源機構 琵琶湖総合管理所 堰諸量 (biwako-mizukanri.jp/daminfo1_h.html)',
    license:
      '水資源機構ウェブサイト利用ルール (政府標準利用規約 第2.0版準拠、CC BY 4.0 互換): 出典記載のうえ複製・加工・商用利用可。数値データは著作権の対象外として自由に利用可。',
    cadence: '時次 (直近 25 時間分の 1 時間値; 取得は毎時 :58)',
    what: '琵琶湖 (琵琶湖開発) の琵琶湖水位 (B.S.L. を T.P. 標高 = B.S.L. + 84.371 m に換算)・総流入量・総流出量。貯水量・貯水率は非公開。',
    label: 'JWA 琵琶湖',
  },
  'kanagawa-dam': {
    upstream: 'かながわの水がめ (kanagawa-dam.jp) — JSON API `summary.php`',
    license: '神奈川県企業庁 — 出典明示で再配布可 (推定)',
    cadence: '時次 (1 時間粒度; 取得は毎時 :05)',
    what: '神奈川県 5 ダム (相模/城山/三保/宮ヶ瀬/道志) の貯水位・貯水量・貯水率・流入量・放流量。',
    label: 'かながわの水がめ',
  },
  mudam: {
    upstream: 'NILIM ダム諸量データベース (mudam.nilim.go.jp)',
    license: '国の公式統計値 — 出典明示で再配布可 (robots.txt allows)',
    cadence: '日次 (1-2 年遅れの確定値; 1998-最新まで)',
    what: '全国 600 ダム × 日次 貯水位・流入量・放流量 (貯水量直接なし)。チャートの歴史的深さ補完用。',
    label: 'NILIM ダム諸量 DB',
  },
  'shiga-bousai': {
    upstream:
      '滋賀県土木防災情報システム モバイル版 ダム観測情報 (shiga-bousai.jp/mobile/dam/dam_select.php)',
    license: '滋賀県オープンデータ — 出典明示で再配布可 (推定)',
    cadence: '時次 (最新 10 分値 + 直近 6 時間の 1 時間値; 取得は毎時 :07)',
    what: '滋賀県 8 ダム (青土/日野川/永源寺/野洲川/蔵王/宇曽川/姉川/石田川) の貯水位・流入量・放流量・60分間雨量。',
    label: '滋賀県土木防災',
  },
  'tottori-dam': {
    upstream: '鳥取県ダム諸量情報システム (tottoridam.jp)',
    license: '鳥取県オープンデータ — 出典明示で再配布可 (推定)',
    cadence: '時次 (1 時間粒度; ページは 10 分毎にリフレッシュ; 取得は毎時 :09)',
    what: '鳥取県 5 ダム (賀祥/朝鍋/佐治川/東郷/百谷) の貯水位・有効貯水量・貯水率・流入量・放流量・時間雨量。',
    label: '鳥取県ダム情報',
  },
  'aomori-dam': {
    upstream: '青森県河川砂防情報提供システム ダム諸量グラフ (kasensabo.bousai.pref.aomori.jp)',
    license: '青森県オープンデータ — 出典明示で再配布可 (推定)',
    cadence: '時次 (元データは 10 分粒度; 取得は毎時 :11)',
    what: '青森県河川砂防情報提供システムのダム諸量現況表に載る全ダム (11: 下湯/久吉/浅瀬石川/世増/浅虫/遠部/津軽/飯詰/小泊/清水目/川内) の貯水位・流入量・全放流量・貯水量 (有効容量)・貯水率 (利水容量; 利水容量のない遠部/清水目は有効容量)。',
    label: '青森県砂防ダム',
  },
  'hkd-mlit-dam': {
    upstream: '国土交通省 北海道開発局 ダムリアルタイム情報 (info-dam.hdb.hkd.mlit.go.jp)',
    license: '国の公式統計値 — 出典明示で再配布可',
    cadence: '時次 (元データは 10 分粒度; 取得は毎時 :13)',
    what: '北海道開発局直轄 18 ダム (平取/忠別/豊平峡/岩尾内/漁川/定山渓/金山/鹿ノ子/新桂沢/二風谷/美利河/留萌/サンル/札内川/大雪/滝里/十勝/夕張シューパロ) の貯水位・流入量・放流量・貯水量・貯水率。',
    label: '北海道開発局ダム',
  },
  'chiba-suisei': {
    upstream: '千葉県 水政課 県内ダムの貯水状況 (pref.chiba.lg.jp/suisei/chosui)',
    license: '千葉県オープンデータ — 出典明示で再配布可 (推定)',
    cadence: '週次 (月曜 9:00 JST 値、1 週飛ぶこともある; 取得は毎日 11:30 JST)',
    what: '千葉県内 23 ダム (水道用 20 + 工業用水 3) の貯水容量・貯水量(m³)・貯水率(%)。',
    label: '千葉県水政課',
  },
  'okayama-bousai': {
    upstream: 'おかやま防災ポータル (bousai.pref.okayama.jp)',
    license: '岡山県オープンデータ — 出典明示で再配布可 (推定)',
    cadence: '時次 (元データは 30 分粒度; 取得は毎時 :21)',
    what: '岡山県管理 ~15 ダム (旭川/鳴滝/河平/三室川/黒木/香々美/久賀/津川/黒谷/鬼ヶ岳/大佐/日笠/槙谷/楢井 ほか) の貯水位・有効貯水量・貯水率・流入量・全放流量。',
    label: 'おかやま防災ポータル',
  },
  'niigata-bousai': {
    upstream: '新潟県河川防災情報システム (doboku-bousai.pref.niigata.jp/kasen)',
    license: '新潟県オープンデータ — 出典明示で再配布可 (推定)',
    cadence: '時次 (元データは 10 分粒度; 取得は毎時 :23)',
    what: '新潟県管理 ~20 ダム (三面/奥三面/大谷/胎内川/奥胎内/早出川/破間川/笠堀/刈谷田川 ほか) の貯水位・貯水率・流入量・全放流量。',
    label: '新潟県河川防災情報',
  },
  'hyogo-bodik': {
    upstream: '兵庫県 ダム諸量データ (data.bodik.jp/dataset/280003_dam_hyogo)',
    license: 'CC-BY 4.0 — 出典明示で再配布可',
    cadence: '時次 (元データは 10 分粒度; 取得は毎時 :25)',
    what: '兵庫県管理 ~20 ダム (青野/生野/引原/安室/金出地/与布土/諭鶴羽 ほか) の貯水位・貯水量(m³)・全流入量・全放流量。BODIK オープンデータ CSV。',
    label: '兵庫県オープンデータ',
  },
  'tochigi-bodik': {
    upstream:
      '栃木県河川水位・雨量情報システム ダム諸量 (data.bodik.jp/dataset/090000_river_dam_parameter)',
    license: 'CC-BY 4.0 — 出典明示で再配布可',
    cadence: '時次 (元データは 10 分粒度; 取得は毎時 :27)',
    what: '栃木県管理 7 ダム (寺山/塩原/西荒川/東荒川/三河沢/中禅寺/松田川) の貯水位・貯水量(m³)・全流入量・全放流量。BODIK NGSI-v2 CSV。',
    label: '栃木県オープンデータ',
  },
  'osaka-bousai': {
    upstream: '大阪府河川防災情報 (osaka-kasen-portal.net/suibou/publicdata/choryuryo.json)',
    license: '公開情報 — 出典明示で再配布可',
    cadence: '時次 (元データは 1 分更新; 取得は毎時 :31)',
    what: '大阪府管理 3 ダム (安威川/箕面川/狭山池) の有効貯水量(m³)・貯水率。水位・流量は非公開。',
    label: '大阪府河川防災情報',
  },
  'hiroshima-bousai': {
    upstream: '広島県防災Web (bousai.pref.hiroshima.lg.jp/dam) — /data/dam/list/{ts}.json',
    license: '公開情報 — 出典明示で再配布可',
    cadence: '時次 (元データは 10 分粒度; 取得は毎時 :29)',
    what: '広島県管理 18 ダムの貯水位・有効貯水量(千m³)・全流入量・全放流量・貯水率。県管理 12 + 国管理 5 (cgr-mlit-dam と重複) + 農水省 1。',
    label: '広島県防災Web',
  },
  'tottori-bousai': {
    upstream: '鳥取県防災Web (bousai.pref.tottori.lg.jp/dam) — /data/dam/list/{ts}.json',
    license: '公開情報 — 出典明示で再配布可',
    cadence: '時次 (元データは 10 分粒度; 取得は毎時 :33)',
    what: '鳥取県管理 6 ダム (百谷/佐治川/東郷/賀祥/朝鍋/菅沢) の貯水位・有効貯水量(千m³)・全流入量・全放流量・貯水率。菅沢ダムは本ソース唯一の観測源。',
    label: '鳥取県防災Web',
  },
  'kochi-kigyo': {
    upstream:
      '高知県公営企業局 発電所集中監視制御Webシステム ダム水文量表 (210.155.220.59/web/crt17/01/01; 案内: pref.kochi.lg.jp/doc/denki_dam_info/)',
    license:
      '利用許諾・再配布条件の明記なし。サイトの注意事項は「利用者が本サイトで公開している情報を用いて行う行為（編集・加工等した情報を利用することを含む。）について、高知県公営企業局は一切の責任を負うものではありません」。物部川水系治水協定に基づき「試験的に公開」、値は瞬時値で「実際の記録値とは異なります」。',
    cadence: '時次 (直近 48 時間の 1 時間値; 取得は毎時 :44)',
    what: '高知県公営企業局の発電専用 2 ダム (物部川: 吉野/杉田) の貯水位・流入量・放流量・時間雨量。貯水量・貯水率は非公開。両ダムとも本ソース唯一の観測源。',
    label: '高知県公営企業局',
  },
  'fukuoka-bodik': {
    upstream:
      '福岡市関連9ダム貯水量 — BODIK オープンデータ (data.bodik.jp/dataset/401307_mizukanri)',
    license: 'CC-BY 4.0 (出典明示で商用利用可)',
    cadence: '時次 (毎時更新; 取得は毎時 :35)',
    what: '福岡市水道局管理 9 ダム (南畑/五ケ山/脊振/曲渕/江川/久原/長谷/猪野/瑞梅寺) の有効貯水量(千m³)。水位・流量は非公開。',
    label: '福岡市関連ダム',
  },
  'kitakyushu-suido': {
    upstream:
      '北九州市上下水道局「北九州市の水源状況」 (city.kitakyushu.lg.jp/suidou/s00900011.html)',
    license:
      'サイト表記は「北九州市ホームページに掲載している内容 (文章、写真、図、イラスト、音声・動画等) に関する著作権は、原則として北九州市に帰属します。…「私的使用のための複製」や「引用」など著作権法上認められた場合を除き、無断で複製・転用することはできません」。本サイトは観測値 (事実) のみを出典明示で引用。',
    cadence: '平日日次 (09:00 JST 値, 平日 16 時頃更新; 取得は 17:50 JST)',
    what: '北九州市の 10 水源 (油木/ます渕/耶馬渓/力丸/頓田/畑/白木/道原/松ヶ江/遠賀川河口堰) の水位・貯水量(万m³)・貯水率。白木/道原/松ヶ江/遠賀川河口堰は新規カバレッジ。頓田は 2 ダム (頓田第1/第2) の合算値のため未紐付け。',
    label: '北九州市上下水道局',
  },
  'sasebo-suido': {
    upstream:
      '佐世保市水道局「佐世保市水道用貯水池の貯水状況表」 (city.sasebo.lg.jp/suidokyoku/suisou/chosuiritsu.html の日次 PDF)',
    license:
      'サイト表記は「当サイトに掲載している文字、写真、イラストやデザインといった情報の著作権は、私たち又は原権利者に帰属します。私的使用又は引用等著作権法上認められている行為を除き、無断で転載等を行うことはできません。引用を行う際は、適宜の方法により、必ず出所を明示してください」。本サイトは観測値 (事実) のみを出典明示で引用。',
    cadence: '日次 (毎日 00:00 JST 値, 土日含む; 取得は 10:54 / 16:54 JST)',
    what: '佐世保市水道局 6 ダム (山の田/菰田/川谷/相当/転石/下の原) の現在貯水量(m³)・貯水率 (水道有効貯水量比)。水位・流量は非公開。',
    label: '佐世保市水道局',
  },
  'matsue-suido': {
    upstream:
      '松江市上下水道局「千本ダム・大谷ダム貯水量・貯水率」 (water.matsue.shimane.jp/shiryo/chosui-list.html)',
    license: '利用条件の記載なし (公開情報) — 出典明示で観測値を引用',
    cadence: '日次 (日付のみ・時刻非公表のため 00:00 JST で記録; 平日更新; 取得は 13:58 JST)',
    what: '松江市の水道専用 2 ダム (千本/大谷) の日別貯水量(m³)・貯水率。当月と前月の全日を毎回取り込み。',
    label: '松江市上下水道局',
  },
  'shimane-bousai': {
    upstream:
      '島根県水防情報システム (www.suibou-shimane.jp) — /dyn/dps/json/{YYYYMMDD}/dam60.json',
    license:
      '利用条件に再配布の定めなし (「利用における注意事項」: 無人観測所の速報値で異常値を含み得る)',
    cadence: '時次 (60 分値; 取得は毎時 :37、前日分と当日分の全時刻を毎回読み直し)',
    what: '島根県 19 ダム — 土木部 14 (布部/山佐/三瓶/波積/八戸/浜田/第二浜田/大長見/御部/益田川/笹倉/大峠/銚子/美田)、農林水産部 3 (清瀧/津田川/嵯峨谷)、三成/木都賀 — の貯水位・貯水量(千m³)・利水貯水率(洪水期/非洪水期)・流入量・全放流量。',
    label: '島根県水防情報システム',
  },
  kasenbosai: {
    upstream: '国土交通省 川の防災情報 (river.go.jp) — tmlist/dam per-obs JSON',
    license: '国の公式統計値 — 出典明示で再配布可',
    cadence: '時次 (元データは 10 分粒度; 取得は毎時 :03)',
    what: '全国 ~870 ダムの 10 分粒度 貯水位・貯水量・有効容量貯水率・全流入量・全放流量。MLIT SCC の per-dam tmlist/dam/{obs_fcd}.json から取得。',
    label: '川の防災情報',
  },
  'hrr-mlit-dam': {
    upstream: '国土交通省 北陸地方整備局 ダム防災情報 (hrr.mlit.go.jp/river/dam-bousai)',
    license: '国の公式統計値 — 出典明示で再配布可',
    cadence: '時次 (元データは 10 分粒度; 取得は毎時 :19)',
    what: '北陸地方整備局直轄 7 ダム (福島:大川 / 山形:横川 / 新潟:大石・三国川 / 長野:大町 / 富山:宇奈月 / 石川:手取川) の貯水位・流入量・放流量。',
    label: '北陸地方整備局ダム',
  },
  'ktr-kinu-dam': {
    upstream:
      '国土交通省 関東地方整備局 鬼怒川ダム統合管理事務所 (ktr.mlit.go.jp/kinudamu/daminfo)',
    license: '国の公式統計値 — 出典明示で再配布可',
    cadence: '時次 (元データは 10 分粒度; 取得は毎時 :17)',
    what: '関東地方整備局 鬼怒川ダム統管直轄 4 ダム (栃木県: 五十里/川俣/川治/湯西川) の貯水位・全流入量・全放流量・累加雨量。',
    label: '鬼怒川ダム統管',
  },
  'cgr-mlit-dam': {
    upstream:
      '国土交通省 中国地方整備局 ダム防災情報システム (cgr.mlit.go.jp/cginfo/syokai/busyo/kasen/dam_bousai)',
    license: '国の公式統計値 — 出典明示で再配布可',
    cadence: '時次 (取得は毎時 :15)',
    what: '中国地方整備局直轄 11 ダム (岡山:苫田 / 広島:土師・弥栄・八田原・温井・灰塚 / 山口:島地川 / 鳥取:菅沢・殿 / 島根:志津見・尾原) の貯水位・流入量・放流量・貯水率(有効容量)・雨量。',
    label: '中国地方整備局ダム',
  },
  'cgr-okakawa-dam': {
    upstream:
      '国土交通省 中国地方整備局 岡山河川事務所 三水系の主要ダムの貯水状況 (cgr.mlit.go.jp/okakawa/kouhou/kassui)',
    license: '公共データ利用規約（第1.0版） (PDL1.0) — 出典明示で再配布可',
    cadence: '日次 (平日 午前9時 速報値; 取得は 10:50 / 14:50 JST)',
    what: '吉井川・旭川・高梁川の主要 11 ダム + 2 堰 (小阪部川/坂根堰/新田原井堰/苫田/湯原/旭川/千屋/河本/新成羽川 ほか) の貯水量(千m³)・貯水率(洪水期利水容量比)。',
    label: '岡山河川事務所',
  },
  'cgr-ashida-seki': {
    upstream:
      '国土交通省 中国地方整備局 福山河川国道事務所「芦田川水系 水文データ」 (cgr.mlit.go.jp/fukuyama/mobile_ashidagawa/sekisyoryou.php)',
    license:
      '中国地方整備局ホームページのコンテンツは、権利表記の記載がない限り「公共データ利用規約（第1.0版）」(PDL1.0) に準拠した利用条件の下で利用可 — 出典記載が必要 (cgr.mlit.go.jp/about_manual)',
    cadence: '時次 (元データは 10 分更新の最新値のみ; 取得は毎時 :02)',
    what: '芦田川河口堰 (広島県福山市) の堰上水位・貯水量(千m³)・流入量・放流量。貯水率は非公表 (貯水量と有効貯水容量から算出)。',
    label: '芦田川河口堰',
  },
  'mc-tottori-hydro': {
    upstream: 'M&C鳥取水力発電株式会社 発電所・ダム運転情報 (mchp-k.co.jp/business/list.php)',
    license:
      '利用条件の記載なし (ページ表記は「Copyright © 2021 M&C TOTTORI HYDROPOWER All Right Reserved.」) — 観測値のみを出典明示で掲載',
    cadence: '時次 (ページは毎分更新の現在値; 取得は毎時 :32)',
    what: '鳥取県営発電の運営権者が公開する 4 ダム (茗荷谷/三朝調整池/中津/菅沢) の 10分間流入量とゲート放流量。ダム水位は EL ではない水位計の読みのため保存しない。茗荷谷・三朝・中津は本ソース唯一の観測源。',
    label: 'M&C鳥取水力発電',
  },
  'nagano-kigyo': {
    upstream:
      '長野県企業局 ダム情報 (naganoken-kigyokyoku.jp/dam) — /json/{takato,sugadaira}_new.json',
    license:
      '利用条件の記載なし (ページ表記は「Copyright © Nagano Prefecture. All Rights Reserved.」) — 観測値のみを出典明示で掲載',
    cadence: '時次 (元データは 10 分粒度・直近 4 件; 取得は毎時 :54)',
    what: '長野県企業局管理の高遠ダム・菅平ダムの貯水位 (EL.m)・全流入量・全放流量。菅平は貯水率 (%) も公開 (貯水量は非公開)。菅平は本ソース唯一の観測源。',
    label: '長野県企業局',
  },
  synthetic: {
    upstream: '当サイトの内部生成 (シード値)',
    license: 'CC0 (出典明示は任意)',
    cadence: '不変 (一括投入後の更新なし)',
    what: '上流フィードが未接続のダム向けにグラフ表示用の補完値を生成。実観測値ではない旨を UI で明示。',
    label: '推定値',
  },
};

/** Friendly label preferring SOURCE_DETAILS.label, falling back to source_id. */
export function sourceLabel(sourceId: string): string {
  return SOURCE_DETAILS[sourceId]?.label ?? sourceId;
}
